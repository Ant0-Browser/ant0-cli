import { rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { mockDaemon, ID, SECRET, TOKEN, inventoryProfile } from "./mcp-helpers.js";
import { createKey, keyStatus, readyFile } from "./mcp-key-helpers.js";
import { runCli } from "./mock-daemon.js";

const KEY = createKey.credential;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(status: unknown = keyStatus(readyFile()), code = 200) {
  const daemon = await mockDaemon((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    res.writeHead(code);
    if (code !== 200) return void res.end(JSON.stringify({ error: SECRET, message: SECRET }));
    res.end(
      JSON.stringify(
        path === "/v1/automation/status"
          ? status
          : path === `/v1/inventory/profiles/${ID}`
            ? inventoryProfile
            : {
                items: [
                  path === "/v1/inventory/proxies" ? inventoryProfile.proxy : inventoryProfile,
                ],
                total: 1,
              },
      ),
    );
  });
  cleanups.push(daemon.close);
  rmSync(join(daemon.home, "ant0d.pid"));
  const env = { ANT0D_PORT: String(daemon.port) };
  const cli = (extraEnv: Record<string, string>, ...args: string[]) =>
    runCli(["--home", daemon.home, ...args], { ...env, ...extraEnv });
  return { daemon, env, cli };
}

function leaks(result: { stdout: string; stderr: string }): boolean {
  const text = result.stdout + result.stderr;
  return text.includes(KEY) || text.includes(KEY.slice(-43));
}

describe("CLI with ANT0_API_KEY or --api-key-stdin", () => {
  it("authenticates supported commands with the environment key only", async () => {
    const f = await fixture();
    rmSync(join(f.daemon.home, "ant0d.token"));
    for (const command of [
      ["profiles", "ls"],
      ["profiles", "status", ID],
      ["proxies", "ls"],
      ["key-status"],
    ]) {
      const result = await f.cli({ ANT0_API_KEY: KEY }, "--json", ...command);
      expect(result.code, result.stderr).toBe(0);
      expect(leaks(result)).toBe(false);
    }
    expect(
      f.daemon.requests.every((r) => r.authorization === `Bearer ${KEY}` && r.consumer === "api"),
    ).toBe(true);
  });

  it("reads the key from the first stdin line", async () => {
    const f = await fixture();
    const result = await runCli(
      ["--home", f.daemon.home, "--json", "--api-key-stdin", "profiles", "ls"],
      f.env,
      { stdin: Readable.from([`${KEY}\n`]) },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(leaks(result)).toBe(false);
    expect(f.daemon.requests.map((r) => r.authorization)).toEqual([`Bearer ${KEY}`]);
  });

  it.each([
    [["--api-key", KEY, "profiles", "ls"]],
    [[`--api-key=${KEY}`, "profiles", "ls"]],
    [["profiles", "ls", "-q", KEY]],
    [["mcp", "serve", "--stdio", "--api-key", KEY]],
  ])("refuses a key in argv without echoing it: %s", async (args) => {
    const f = await fixture();
    const result = await f.cli({}, ...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("API keys are not accepted as arguments");
    expect(leaks(result)).toBe(false);
    expect(f.daemon.requests).toEqual([]);
  });

  it("refuses combined key sources and an invalid key without using the local token", async () => {
    const f = await fixture();
    for (const [extraEnv, args] of [
      [
        { ANT0_API_KEY: KEY },
        ["--credential-file", join(f.daemon.home, "k.json"), "profiles", "ls"],
      ],
      [{ ANT0_API_KEY: KEY }, ["--api-key-stdin", "profiles", "ls"]],
      [{ ANT0_API_KEY: TOKEN }, ["profiles", "ls"]],
      [{ ANT0_API_KEY: "" }, ["profiles", "ls"]],
      [{ ANT0_API_KEY: KEY }, ["api-keys", "list"]],
      [{ ANT0_API_KEY: KEY }, ["profiles", "create", "x"]],
    ] as const) {
      const result = await f.cli(extraEnv, ...args);
      expect(result.code, result.stderr).toBe(2);
      expect(leaks(result)).toBe(false);
    }
    const stdin = await runCli(
      ["--home", f.daemon.home, "--api-key-stdin", "mcp", "serve", "--stdio"],
      f.env,
      { stdin: Readable.from([`${KEY}\n`]) },
    );
    expect(stdin.code).toBe(2);
    expect(f.daemon.requests).toEqual([]);
  });

  it("does not fall back to the local token when the daemon refuses the key", async () => {
    const f = await fixture(undefined, 401);
    const result = await f.cli({ ANT0_API_KEY: KEY }, "profiles", "ls");
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain(SECRET);
    expect(leaks(result)).toBe(false);
    expect(f.daemon.requests.map((r) => r.authorization)).toEqual([`Bearer ${KEY}`]);
  });

  it("checks operation scopes from the key's own status", async () => {
    const f = await fixture();
    const result = await f.cli({ ANT0_API_KEY: KEY }, "profiles", "run", ID);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("API key does not grant profiles:run");
    expect(f.daemon.requests.map((r) => r.url)).toEqual(["/v1/automation/status"]);
  });
});
