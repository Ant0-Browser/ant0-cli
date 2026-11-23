import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mockDaemon, TOKEN } from "./mcp-helpers.js";
import { expectedContext, metadata, privateTestDirectory, readyFile } from "./mcp-key-helpers.js";
import { readCredentialFile, saveCredentialFile } from "@ant0/mcp/credentials";
import { run } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/credential-faults.mjs", import.meta.url));
function cli(args: string[], env: NodeJS.ProcessEnv = {}, fault = false) {
  const child = spawn(process.execPath, [...(fault ? ["--import", preload] : []), bin, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  return new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
}
async function daemonFixture(beforePost?: () => void) {
  let posts = 0;
  const daemon = await mockDaemon(async (req, res) => {
    if (req.url === "/v1/automation/api-keys/context")
      return void res.end(JSON.stringify(expectedContext));
    if (req.method === "POST") {
      beforePost?.();
      posts++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(
        JSON.stringify({ key: metadata(JSON.parse(Buffer.concat(chunks).toString()).create) }),
      );
    } else res.end(JSON.stringify({ items: [], next_cursor: null }));
  });
  cleanups.push(daemon.close);
  privateTestDirectory(daemon.home);
  const path = join(daemon.home, "key.json");
  return {
    daemon,
    path,
    posts: () => posts,
    args: [
      "--home",
      daemon.home,
      "api-keys",
      "create",
      "Review",
      "--preset",
      "read",
      "--credential-file",
      path,
    ],
  };
}
describe("API-key review regressions", () => {
  it("actual CLI bypasses an environment CONNECT proxy for context, provision and list", async () => {
    let requests = 0;
    let connects = 0;
    let bytes = 0;
    const proxy = createServer((req, res) => {
      requests++;
      req.on("data", (b) => {
        bytes += b.length;
      });
      res.writeHead(502);
      res.end();
    });
    proxy.on("connect", (_req, socket, head) => {
      connects++;
      bytes += head.length;
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
    });
    const f = await daemonFixture();
    const address = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const env = {
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: address,
      HTTPS_PROXY: address,
      ALL_PROXY: address,
      http_proxy: address,
      https_proxy: address,
      all_proxy: address,
      NO_PROXY: "",
      no_proxy: "",
    };
    // Negative control proves this process's global fetch really would use the configured proxy.
    await new Promise<void>((resolve) => {
      const child = spawn(
        process.execPath,
        ["-e", "fetch(process.env.PROBE_URL).catch(() => {})"],
        {
          env: { ...process.env, ...env, PROBE_URL: `http://127.0.0.1:${f.daemon.port}/probe` },
          stdio: "ignore",
        },
      );
      child.on("close", () => resolve());
    });
    expect(requests + connects).toBeGreaterThan(0);
    requests = 0;
    connects = 0;
    bytes = 0;
    expect((await cli(f.args, env)).code).toBe(0);
    expect((await cli(["--home", f.daemon.home, "api-keys", "list"], env)).code).toBe(0);
    expect(f.posts()).toBe(1);
    expect(f.daemon.requests.map((r) => [r.method, r.url.split("?")[0]])).toEqual([
      ["GET", "/v1/automation/api-keys/context"],
      ["POST", "/v1/automation/api-keys/provision"],
      ["GET", "/v1/automation/api-keys/context"],
      ["GET", "/v1/automation/api-keys"],
    ]);
    expect(f.daemon.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect({ requests, connects, bytes }).toEqual({ requests: 0, connects: 0, bytes: 0 });
  });
  it("preserves an explicitly injected management fetch for tests", async () => {
    const f = await daemonFixture();
    const calls: Request[] = [];
    let output = "";
    const code = await run(["--home", f.daemon.home, "--json", "api-keys", "list"], {
      env: {},
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: { write: () => {} },
      fetch: async (input) => {
        const request = input as Request;
        calls.push(request);
        return Response.json(
          request.url.endsWith("/context") ? expectedContext : { items: [], next_cursor: null },
        );
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(f.daemon.requests).toEqual([]);
    expect(JSON.parse(output)).toEqual({ items: [], next_cursor: null });
  });
  it.skipIf(process.platform === "win32")(
    "persistent directory EIO blocks both initial creation and pending replay before POST",
    async () => {
      const f = await daemonFixture();
      const trace = join(f.daemon.home, "trace");
      const env = {
        ANT0_TEST_CREDENTIAL: f.path,
        ANT0_TEST_TRACE: trace,
        ANT0_TEST_FAULT: "eio-directory",
      };
      expect((await cli(f.args, env, true)).code).toBe(1);
      expect(readCredentialFile(f.path).value.phase).toBe("pending");
      writeFileSync(trace, "");
      expect((await cli(f.args, env, true)).code).toBe(1);
      expect(f.posts()).toBe(0);
      const events = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual({ event: "complete", kind: "credential" });
      expect(events).toContainEqual({ event: "attempt", kind: "directory" });
    },
  );
  it.skipIf(process.platform === "win32")(
    "credential EIO on an existing pending file blocks POST",
    async () => {
      const f = await daemonFixture();
      const ready = readyFile();
      ready.create.name = "Review";
      saveCredentialFile(f.path, { ...ready, phase: "pending", key: null });
      const result = await cli(
        f.args,
        {
          ANT0_TEST_CREDENTIAL: f.path,
          ANT0_TEST_TRACE: join(f.daemon.home, "trace"),
          ANT0_TEST_FAULT: "eio-credential",
        },
        true,
      );
      expect(result.code).toBe(1);
      expect(f.posts()).toBe(0);
    },
  );
  it.skipIf(process.platform === "win32")(
    "SIGKILL before initial parent fsync recovers only after credential and parent flush complete",
    async () => {
      let trace = "";
      const f = await daemonFixture(() => {
        const events = readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toContainEqual({ event: "complete", kind: "credential" });
        expect(events).toContainEqual({ event: "complete", kind: "directory" });
      });
      trace = join(f.daemon.home, "trace");
      const env = {
        ANT0_TEST_CREDENTIAL: f.path,
        ANT0_TEST_TRACE: trace,
        ANT0_TEST_FAULT: "kill-directory",
      };
      expect((await cli(f.args, env, true)).signal).toBe("SIGKILL");
      expect(f.posts()).toBe(0);
      expect(existsSync(f.path)).toBe(true);
      const original = readCredentialFile(f.path).value.create;
      writeFileSync(trace, "");
      const result = await cli(f.args, { ...env, ANT0_TEST_FAULT: "trace" }, true);
      expect(result.code, result.stderr).toBe(0);
      expect(f.posts()).toBe(1);
      expect(readCredentialFile(f.path).value.create).toEqual(original);
    },
  );
});
