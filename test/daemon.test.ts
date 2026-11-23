import { createServer, type Server } from "node:net";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rows } from "./fixtures.js";
import { MockDaemon, runCli } from "./mock-daemon.js";

let h: MockDaemon;
beforeAll(async () => {
  h = await MockDaemon.start();
});
afterAll(async () => {
  await h.close();
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function emptyHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ant0-cli-home-"));
  temps.push(dir);
  return dir;
}

/** A port that nothing listens on: bind to 0, read the port, close. */
async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("ant0 daemon status", () => {
  it("prints health and the URL against a running daemon", async () => {
    const r = await h.cli("daemon", "status");
    expect(r.code, r.stderr).toBe(0);
    const kv = new Map(rows(r.stdout).map(([k, v]) => [k, v]));
    expect(kv.get("state")).toBe("running");
    expect(kv.get("url")).toBe(h.baseUrl);
    expect(kv.get("version")).toBe("0.1.0-test");
    expect(kv.get("pid")).toBe(String(process.pid));
    expect(kv.get("home")).toBe(h.home);
  });

  it("--json prints the health payload verbatim", async () => {
    const r = await h.cli("--json", "daemon", "status");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, version: "0.1.0-test", home: h.home });
  });

  it("warns on stderr when the daemon is a different major.minor than the CLI", async () => {
    const other = await MockDaemon.start();
    try {
      other.on("GET", "/v1/health", () => ({
        body: { ok: true, version: "9.9.0", pid: process.pid, uptime_s: 1, home: other.home },
      }));
      const r = await other.cli("daemon", "status");
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain("ant0: warning: the daemon is version 9.9.0 but this CLI is");
      expect(r.stdout).not.toContain("warning");
    } finally {
      await other.close();
    }
  });

  it("exits 3 when nothing listens", async () => {
    const home = emptyHome();
    const r = await runCli([
      "--home",
      home,
      "--port",
      String(await freePort()),
      "daemon",
      "status",
    ]);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("ant0: daemon not running (start it with `ant0 daemon start`)\n");
  });
});

describe("not-running hint", () => {
  it("names `daemon start` unless a host names its own start command", async () => {
    vi.resetModules();
    try {
      const errors = await import("../src/errors.js");
      expect(errors.notRunningMessage()).toBe(
        "daemon not running (start it with `ant0 daemon start`)",
      );
      errors.setStartCommand("ant0 runtime start");
      expect(errors.notRunningMessage()).toBe(
        "daemon not running (start it with `ant0 runtime start`)",
      );
      expect(new errors.DaemonNotRunningError().message).toBe(errors.notRunningMessage());
    } finally {
      vi.resetModules();
    }
  });
});

describe("exit codes", () => {
  it("3 when there is no token file", async () => {
    const home = emptyHome();
    const r = await runCli(["--home", home, "profiles", "ls"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^ant0: daemon not running/);
    expect(r.stdout).toBe("");
  });

  it("3 when the token exists but the connection is refused", async () => {
    const home = emptyHome();
    writeFileSync(join(home, "ant0d.token"), "abc", { mode: 0o600 });
    writeFileSync(
      join(home, "ant0d.pid"),
      JSON.stringify({ pid: process.pid, port: await freePort(), host: "127.0.0.1" }),
    );
    const r = await runCli(["--home", home, "proxies", "ls"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^ant0: daemon not running/);
  });

  it("ANT0_HOME from the environment is honoured", async () => {
    const r = await runCli(["--json", "daemon", "status"], { ANT0_HOME: h.home });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ ok: true });
  });

  it("--port overrides the pid file", async () => {
    const r = await runCli(
      ["--home", h.home, "--port", String(await freePort()), "daemon", "status"],
      {},
    );
    expect(r.code).toBe(3);
  });

  it("1 for a wrong token (401 unauthorized)", async () => {
    const home = emptyHome();
    writeFileSync(join(home, "ant0d.token"), "wrong", { mode: 0o600 });
    writeFileSync(
      join(home, "ant0d.pid"),
      JSON.stringify({ pid: process.pid, port: h.port, host: "127.0.0.1" }),
    );
    const r = await runCli(["--home", home, "profiles", "ls"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^ant0: unauthorized: /);
  });

  describe.skipIf(process.platform === "win32")("a token file that is not private", () => {
    function wideHome(): string {
      const home = emptyHome();
      writeFileSync(join(home, "ant0d.token"), "fake-token\n", { mode: 0o644 });
      chmodSync(join(home, "ant0d.token"), 0o644);
      writeFileSync(
        join(home, "ant0d.pid"),
        JSON.stringify({ pid: process.pid, port: h.port, host: "127.0.0.1" }),
      );
      return home;
    }

    it("does not stop daemon status or a health check, which never send the token", async () => {
      const r = await runCli(["--home", wideHome(), "daemon", "status"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).not.toContain("not private");
    });

    it("is refused where the token is sent, with the path and the fix", async () => {
      const home = wideHome();
      const r = await runCli(["--home", home, "profiles", "ls"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not private");
      expect(r.stderr).toContain(`chmod 600 '${join(home, "ant0d.token")}'`);
      expect(r.stderr).not.toContain("fake-token");
    });

    it.each([
      ["api-keys list", ["api-keys", "list"]],
      ["events", ["events"]],
    ])("%s refuses it with the path and the fix", async (_name, args) => {
      const home = wideHome();
      const r = await runCli(["--home", home, ...args]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not private");
      expect(r.stderr).toContain(`chmod 600 '${join(home, "ant0d.token")}'`);
      expect(r.stderr).not.toContain("fake-token");
    });

    it("a symlinked token is refused even with the opt-out set", async () => {
      const home = emptyHome();
      writeFileSync(join(home, "real.token"), "fake-token\n", { mode: 0o600 });
      symlinkSync(join(home, "real.token"), join(home, "ant0d.token"));
      writeFileSync(
        join(home, "ant0d.pid"),
        JSON.stringify({ pid: process.pid, port: h.port, host: "127.0.0.1" }),
      );
      const r = await runCli(["--home", home, "profiles", "ls"], {
        ANT0_ALLOW_SHARED_TOKEN_FILE: "1",
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(join(home, "ant0d.token"));
      expect(r.stderr).toContain("a symbolic link");
      expect(r.stderr).not.toContain("fake-token");
      expect(r.stderr).not.toContain("warning");
    });

    it("ANT0_ALLOW_SHARED_TOKEN_FILE=1 warns on stderr and sends the request", async () => {
      const r = await runCli(["--home", wideHome(), "profiles", "ls"], {
        ANT0_ALLOW_SHARED_TOKEN_FILE: "1",
      });
      expect(r.stderr).toContain("warning");
      expect(r.stderr).toContain("ANT0_ALLOW_SHARED_TOKEN_FILE=1");
      // It got as far as the daemon (which answers 401 to the fake token), not a local refusal.
      expect(r.stderr).toMatch(/unauthorized/);
    });
  });

  it("2 for unknown commands, bad options and missing arguments", async () => {
    expect((await h.cli("nope")).code).toBe(2);
    expect((await h.cli("profiles", "frobnicate")).code).toBe(2);
    expect((await h.cli("profiles", "show")).code).toBe(2);
    expect((await h.cli("--port", "abc", "daemon", "status")).code).toBe(2);
    const bare = await h.cli("profiles");
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("Usage: ant0 profiles");
  });

  it("0 for --help and --version, written to stdout", async () => {
    const help = await h.cli("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: ant0 [options] [command]");
    for (const name of [
      "daemon",
      "browsers",
      "profiles",
      "trash",
      "proxies",
      "extensions",
      "events",
    ]) {
      expect(help.stdout).toContain(`\n  ${name}`);
    }
    const version = await h.cli("--version");
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
