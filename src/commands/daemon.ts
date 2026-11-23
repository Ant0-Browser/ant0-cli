/**
 * `ant0 daemon start [--foreground] | stop | status`.
 *
 * `start` spawns the daemon detached with stdio appended to `<home>/logs/ant0d.out`, then waits
 * up to 10 s for `GET /v1/health`. `stop` reads the pid file and sends SIGTERM. `status` is
 * health + pid.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { unwrap, type Health } from "../api/index.js";
import type { Context } from "../context.js";
import { CliError, DaemonNotRunningError, isConnectionRefused } from "../errors.js";
import { formatDuration, keyValues } from "../format.js";
import { versionSkewWarning } from "../version.js";
import type { DaemonCommand, RuntimeCommands } from "../runtime-types.js";

export const START_TIMEOUT_MS = 10_000;
export const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 200;

type Env = Record<string, string | undefined>;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where the Ant0 desktop app installs the daemon, when it is not on PATH. */
function packagedDaemonPaths(env: Env, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return local ? [join(local, "Programs", "Ant0", "ant0d.exe")] : [];
  }
  return ["/usr/bin/ant0d"];
}

function onPath(env: Env, platform: NodeJS.Platform): string | undefined {
  const names = platform === "win32" ? ["ant0d.exe", "ant0d.cmd"] : ["ant0d"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The daemon to launch: `$ANT0D_BIN` (a `.js` file runs under this Node), else `ant0d` on PATH,
 * else the desktop app's install location. Throws when none exists.
 */
export function resolveDaemonCommand(
  runtime?: RuntimeCommands,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): DaemonCommand {
  if (runtime) return runtime.daemon;
  const override = env.ANT0D_BIN;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) throw new CliError("ANT0D_BIN must be an absolute path");
    if (!existsSync(override)) throw new CliError(`ANT0D_BIN does not exist: ${override}`);
    return /^\.[cm]?js$/.test(extname(override))
      ? { command: process.execPath, args: [override] }
      : { command: override, args: [] };
  }
  const found = onPath(env, platform) ?? packagedDaemonPaths(env, platform).find(isFile);
  if (found) return { command: found, args: [] };
  throw new CliError(
    "ant0d not found: install the Ant0 desktop app, put ant0d on PATH, or set ANT0D_BIN to its path",
  );
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One warning per invocation, however many health polls `daemon start` makes. */
const warned = new WeakSet<Context>();

async function health(ctx: Context): Promise<Health | undefined> {
  try {
    const result = unwrap(await ctx.openClient().GET("/v1/health"));
    const warning = versionSkewWarning(result.version);
    if (warning !== undefined && !warned.has(ctx)) {
      warned.add(ctx);
      ctx.err(`ant0: ${warning}`);
    }
    return result;
  } catch (err) {
    if (isConnectionRefused(err)) return undefined;
    throw err;
  }
}

function statusLines(h: Health, baseUrl: string): string {
  return keyValues([
    ["state", "running"],
    ["url", baseUrl],
    ["pid", h.pid],
    ["version", h.version],
    ["uptime", formatDuration(h.uptime_s)],
    ["home", h.home],
  ]);
}

export function registerDaemon(program: Command, ctx: Context): void {
  const daemon = program.command("daemon").description("Run and inspect the local ant0d daemon");

  daemon
    .command("start")
    .description("Start ant0d in the background (or attached with --foreground)")
    .option("--foreground", "run attached to this terminal")
    .action(async (opts: { foreground?: boolean }) => {
      const conn = ctx.connection();
      const port = new URL(conn.baseUrl).port;
      const existing = await health(ctx);
      if (existing) {
        ctx.emit(
          { ...existing, url: conn.baseUrl, started: false },
          () =>
            `ant0d ${existing.version} already running at ${conn.baseUrl} (pid ${existing.pid})`,
        );
        return;
      }

      const { command, args } = resolveDaemonCommand(ctx.runtime, ctx.io.env);
      const daemonArgs = [...args, "--home", conn.home, "--port", port];

      if (opts.foreground) {
        const code = await new Promise<number>((resolve, reject) => {
          const child = spawn(command, daemonArgs, { stdio: "inherit" });
          child.on("error", reject);
          child.on("exit", (c) => resolve(c ?? 1));
        });
        if (code !== 0) throw new CliError(`ant0d exited with code ${code}`, code);
        return;
      }

      mkdirSync(join(conn.home, "logs"), { recursive: true });
      const logFile = join(conn.home, "logs", "ant0d.out");
      const fd = openSync(logFile, "a");
      let exited: number | null | undefined;
      const child = spawn(command, [...daemonArgs, "--quiet"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      child.on("error", (err) => {
        exited = -1;
        ctx.err(`ant0: could not spawn ant0d: ${err.message}`);
      });
      child.on("exit", (code) => {
        exited = code ?? 1;
      });
      child.unref();

      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (exited !== undefined) {
          throw new CliError(`ant0d exited early (code ${exited}); see ${logFile}`);
        }
        const h = await health(ctx);
        if (h) {
          ctx.emit(
            { ...h, url: conn.baseUrl, started: true },
            () => `ant0d ${h.version} running at ${conn.baseUrl} (pid ${h.pid})`,
          );
          return;
        }
        await sleep(POLL_MS);
      }
      throw new CliError(
        `ant0d did not answer on ${conn.baseUrl} within ${START_TIMEOUT_MS / 1000} s; see ${logFile}`,
      );
    });

  daemon
    .command("stop")
    .description("Stop the running daemon (SIGTERM, waits up to 10 s)")
    .action(async () => {
      const conn = ctx.connection();
      const pid = conn.pidFile?.pid;
      if (pid === undefined || !processAlive(pid)) throw new DaemonNotRunningError();
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        throw new CliError(`could not signal pid ${pid}: ${(err as Error).message}`);
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!processAlive(pid)) {
          ctx.emit({ pid, stopped: true }, () => `stopped ant0d (pid ${pid})`);
          return;
        }
        await sleep(POLL_MS);
      }
      throw new CliError(`ant0d (pid ${pid}) did not exit within ${STOP_TIMEOUT_MS / 1000} s`);
    });

  daemon
    .command("status")
    .description("Show whether the daemon answers and where")
    .action(async () => {
      const conn = ctx.connection();
      const h = await health(ctx);
      if (!h) {
        if (ctx.json) ctx.out(JSON.stringify({ ok: false, url: conn.baseUrl }, null, 2));
        throw new DaemonNotRunningError();
      }
      ctx.emit(h, () => statusLines(h, conn.baseUrl));
    });
}
