import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mockDaemon, sdkClient, rawClient, TOKEN, SECRET } from "./mcp-helpers.js";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function daemon() {
  const value = await mockDaemon();
  cleanups.push(value.close);
  return value;
}
function command(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.end();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ant0 mcp serve command integration (spawned executable)", () => {
  it("interoperates with the official client and finds the daemon from explicit flags anywhere on the line", async () => {
    const d = await daemon();
    const tokenBefore = readFileSync(join(d.home, "ant0d.token"), "utf8");
    const pidBefore = readFileSync(join(d.home, "ant0d.pid"), "utf8");
    // Poison files the MCP adapter must never read (nor create a login/engine session to replace).
    mkdirSync(join(d.home, "cloud"));
    mkdirSync(join(d.home, "device"));
    writeFileSync(join(d.home, "cloud", "session.json"), SECRET);
    writeFileSync(join(d.home, "device", "keys.json"), SECRET);
    for (const args of [
      [bin, "mcp", "serve", "--stdio", "--home", d.home, "--port", String(d.port)],
      [bin, "--home", d.home, "--port", String(d.port), "mcp", "serve", "--stdio"],
      [bin, "mcp", "--home", d.home, "serve", "--stdio", "--port", String(d.port)],
    ]) {
      const sdk = await sdkClient(d.home, args);
      try {
        // The local connection lists the 9 inventory/run tools plus the 11 local-only identity tools.
        expect((await sdk.client.listTools()).tools).toHaveLength(32);
        const result = await sdk.client.callTool({ name: "ant0_daemon_status" });
        expect(result.structuredContent).toEqual({ ok: true, version: "0.1.0", uptime_s: 7 });
        expect(sdk.stderr()).toBe("");
      } finally {
        await sdk.close();
      }
    }
    expect(
      d.requests.every((r) => r.method === "GET" && r.authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(readFileSync(join(d.home, "ant0d.token"), "utf8")).toBe(tokenBefore);
    expect(readFileSync(join(d.home, "ant0d.pid"), "utf8")).toBe(pidBefore);
    expect(readFileSync(join(d.home, "cloud", "session.json"), "utf8")).toBe(SECRET);
    expect(readFileSync(join(d.home, "device", "keys.json"), "utf8")).toBe(SECRET);
  });

  it("uses ANT0_HOME discovery and exits cleanly on EOF", async () => {
    const d = await daemon();
    const result = await command(["mcp", "serve", "--stdio"], { ANT0_HOME: d.home });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(d.requests).toEqual([]);
  });

  it.each([
    [[], "mcp serve requires --stdio"],
    [["--stdio", "--json"], "mcp serve does not accept --json"],
  ])("requires the transport explicitly and refuses JSON mode: %s", async (args, message) => {
    const result = await command(["mcp", "serve", ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`ant0: ${message}\n`);
  });

  it("returns daemon-not-running without creating a home or starting services", async () => {
    const d = await daemon();
    const missing = join(d.home, "missing");
    const result = await command(["mcp", "serve", "--stdio", "--home", missing]);
    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr: "ant0: mcp: local daemon unavailable\n",
    });
    expect(existsSync(missing)).toBe(false);
    expect(d.requests).toEqual([]);
  });

  it.each<string[]>([["--port", SECRET], [`--${SECRET}`]])(
    "keeps parser diagnostics bounded and free of raw arguments",
    async (...args: string[]) => {
      const result = await command(["mcp", "serve", "--stdio", ...args]);
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr: "ant0: mcp: invalid command arguments\n",
      });
    },
  );

  it("sanitizes parser failures when global flags separate the MCP subcommands", async () => {
    const result = await command(["mcp", "--home", SECRET, "serve", "--stdio", "--port", SECRET]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "ant0: mcp: invalid command arguments\n",
    });
  });

  it("rejects unsafe discovered destinations without outputting connection secrets or making requests", async () => {
    const d = await daemon();
    writeFileSync(
      join(d.home, "ant0d.pid"),
      JSON.stringify({ pid: 42, port: d.port, host: `${SECRET}@evil.example` }),
    );
    const result = await command(["mcp", "serve", "--stdio", "--home", d.home]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "ant0: mcp: invalid local daemon configuration\n",
    });
    expect(d.requests).toEqual([]);
  });

  it("malformed input exits with one fixed diagnostic and only protocol messages on stdout", async () => {
    const d = await daemon();
    const peer = rawClient(d.home, [bin, "mcp", "serve", "--stdio", "--home", d.home]);
    cleanups.push(async () => {
      if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
      await peer.closed;
    });
    await peer.initialize();
    peer.child.stdin.write(`${SECRET}\n`);
    expect((await peer.closed).code).toBe(1);
    expect(peer.stderr()).toBe("ant0: mcp: invalid MCP input frame\n");
    expect(peer.stdout()).not.toContain(SECRET);
  });

  it("shows the MCP command in help", async () => {
    const result = await command(["mcp", "serve", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--stdio");
  });

  it.each(["idle", "active HTTP"])(
    "output-only closure %s ends the CLI within five seconds without a follow-up write",
    async (phase) => {
      let disconnected = false;
      const d = await mockDaemon((_req, res) => {
        res.writeHead(200);
        res.write("{");
        res.on("close", () => {
          disconnected = true;
        });
      });
      cleanups.push(d.close);
      const peer = rawClient(d.home, [bin, "mcp", "serve", "--stdio", "--home", d.home]);
      cleanups.push(async () => {
        if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
        await peer.closed;
      });
      await peer.initialize();
      if (phase === "active HTTP") {
        peer.request("tools/call", { name: "ant0_daemon_status" });
        await expect.poll(() => d.requests.length).toBe(1);
      }
      const started = Date.now();
      peer.child.stdout.destroy();
      let exit: number | null | undefined;
      void peer.closed.then((result) => {
        exit = result.code;
      });
      await expect.poll(() => exit, { timeout: 4800 }).toBe(1);
      expect(Date.now() - started).toBeLessThan(5000);
      if (phase === "active HTTP") expect(disconnected).toBe(true);
      expect(peer.stderr()).toBe("ant0: mcp: MCP output failed\n");
    },
  );

  it("writes nothing before the first client message (the protocol era is not known yet)", async () => {
    const d = await mockDaemon((_req, res) => res.writeHead(200).end("{}"));
    cleanups.push(d.close);
    const peer = rawClient(d.home, [bin, "mcp", "serve", "--stdio", "--home", d.home]);
    cleanups.push(async () => {
      if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
      await peer.closed;
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(peer.messages).toEqual([]);
    expect(peer.stdout()).toBe("");
    expect(peer.child.exitCode).toBeNull();
  });

  it("a silent peer ends the CLI within five seconds and aborts active HTTP", async () => {
    let disconnected = false;
    const d = await mockDaemon((_req, res) => {
      res.writeHead(200);
      res.write("{");
      res.on("close", () => {
        disconnected = true;
      });
    });
    cleanups.push(d.close);
    const peer = rawClient(d.home, [bin, "mcp", "serve", "--stdio", "--home", d.home], false);
    cleanups.push(async () => {
      if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
      await peer.closed;
    });
    await peer.initialize();
    peer.request("tools/call", { name: "ant0_daemon_status" });
    await expect.poll(() => d.requests.length).toBe(1);
    const started = Date.now();
    let exit: number | null | undefined;
    void peer.closed.then((result) => {
      exit = result.code;
    });
    await expect.poll(() => exit, { timeout: 4800 }).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(disconnected).toBe(true);
    expect(peer.messages.filter((m) => m.method === "ping")).toHaveLength(1);
    expect(peer.stderr()).toBe("ant0: mcp: MCP peer did not answer ping\n");
  });

  it("rejects blocking file stdout before writing protocol data", async () => {
    const d = await daemon();
    const path = join(d.home, "unsupported-stdout");
    const fd = openSync(path, "w");
    const child = spawn(process.execPath, [bin, "mcp", "serve", "--stdio", "--home", d.home], {
      stdio: ["pipe", fd, "pipe"],
    });
    closeSync(fd);
    child.stdin!.on("error", () => {});
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
    });
    await expect.poll(() => child.exitCode, { timeout: 2000 }).toBe(1);
    await closed;
    expect(stderr).toBe("ant0: mcp: MCP requires pipe or socket stdout\n");
    expect(readFileSync(path, "utf8")).toBe("");
    expect(d.requests).toEqual([]);
  });
});
