/**
 * The real built CLI as a child process, with ANT0_HOME and HOME in its environment (the in-process
 * `runCli` harness does not put its env into `process.env`, which is where discovery reads it).
 * Everything lives in temp dirs; HOME is a temp dir, never a real Ant0 home.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withFreePort } from "./free-port.js";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const posix = process.platform === "win32" ? describe.skip : describe;

let server: Server;
let port: number;
const seen: { url: string; authorization: string | undefined }[] = [];
const temps: string[] = [];

beforeAll(async () => {
  if (!existsSync(bin)) throw new Error("build @ant0/cli first: pnpm --filter @ant0/cli... build");
  server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ ok: true, version: "0.0.0-test", pid: 4242, uptime_s: 5, home: "fake" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  seen.length = 0;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ant0-cli-proc-"));
  temps.push(dir);
  return dir;
}

/** A home with a token that other users can read, and a pid file pointing at `daemonPort`. */
function wideHome(daemonPort?: number): string {
  const home = temp();
  const token = join(home, "ant0d.token");
  writeFileSync(token, "fake-token-value\n");
  chmodSync(token, 0o644);
  if (daemonPort !== undefined)
    writeFileSync(
      join(home, "ant0d.pid"),
      JSON.stringify({ pid: process.pid, port: daemonPort, host: "127.0.0.1" }),
    );
  return home;
}

async function cli(args: string[], env: Record<string, string>, timeoutMs = 60_000) {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += String(c)));
  child.stderr.on("data", (c) => (stderr += String(c)));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}

posix("the built CLI with a token file that is not private", () => {
  it("daemon status works with ANT0_HOME set, and sends no Authorization header", async () => {
    const home = wideHome(port);
    const r = await cli(["daemon", "status"], { ANT0_HOME: home, HOME: temp() });
    expect(r.stderr).not.toContain("not private");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("running");
    const health = seen.filter((s) => s.url === "/v1/health");
    expect(health.length).toBeGreaterThan(0);
    for (const s of health) expect(s.authorization).toBeUndefined();
  });

  it("--home and ANT0_HOME disagree: health uses --home's daemon and never reads ANT0_HOME's token", async () => {
    const envHome = wideHome(); // no daemon here, only a readable token
    const flagHome = temp();
    writeFileSync(
      join(flagHome, "ant0d.pid"),
      JSON.stringify({ pid: process.pid, port, host: "127.0.0.1" }),
    );
    const r = await cli(["--home", flagHome, "daemon", "status"], {
      ANT0_HOME: envHome,
      HOME: temp(),
    });
    expect(r.stderr).not.toContain("not private");
    expect(r.stderr).not.toContain(envHome);
    expect(r.code).toBe(0);
    const health = seen.filter((s) => s.url === "/v1/health");
    expect(health.length).toBeGreaterThan(0);
    for (const s of health) expect(s.authorization).toBeUndefined();
  });

  // Needs a built daemon: ANT0D_TEST_BIN names its entry file, and the test is skipped without it.
  it.skipIf(!process.env.ANT0D_TEST_BIN)(
    "daemon start does not fail on the check and ant0d puts the token back to 0600",
    async () => {
      // The real built ant0d, on a free port, in a temp home; stopped again at the end. The probed
      // port can be taken before ant0d binds it (#96); a lost port is retried on a fresh one.
      const home = wideHome();
      const token = join(home, "ant0d.token");
      mkdirSync(join(home, "logs"), { recursive: true });
      const env = {
        ANT0_HOME: home,
        HOME: temp(),
        ANT0D_BIN: process.env.ANT0D_TEST_BIN!,
      };
      const stop = (p: number) => cli(["--port", String(p), "daemon", "stop"], env, 30_000);
      let started: number | undefined;
      try {
        const { port: daemonPort, result: r } = await withFreePort(
          (p) => cli(["--port", String(p), "daemon", "start"], env),
          {
            // A non-ant0d answer (http_404) or an early exit means the port was not ours.
            lostPort: (res) => res.code !== 0 && !res.stderr.includes("not private"),
            cleanup: async (p) => {
              await stop(p);
            },
          },
        );
        started = daemonPort;
        expect(r.stderr).not.toContain("not private");
        expect(r.code, r.stderr).toBe(0);
        expect(statSync(token).mode & 0o777).toBe(0o600);
      } finally {
        if (started !== undefined) await stop(started);
      }
    },
    120_000,
  );
});
