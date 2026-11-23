import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import type { NativeLoginStatus } from "../src/commands/account.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const pending = (): NativeLoginStatus => ({
  protocol: "ant0-native-auth/v1",
  status: "awaiting_browser",
  transaction_id: randomUUID(),
  expires_at: new Date(Date.now() + 900000).toISOString(),
  verification_uri: "https://ant0.link/account/authorize",
  user_code: "ABCDE-FGHJK",
  account: null,
  workspace: null,
  error: null,
  retry_after_s: 5,
});
async function invoke(
  args: string[],
  replies: (NativeLoginStatus | { error: string })[],
  options: { abort?: boolean; openFails?: boolean; marker?: string } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "ant0-cli-native-"));
  homes.push(home);
  writeFileSync(
    join(home, "ant0d.pid"),
    JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 27100 }),
  );
  writeFileSync(join(home, "ant0d.token"), "a".repeat(64), { mode: 0o600 });
  if (options.marker) {
    mkdirSync(join(home, "device"));
    writeFileSync(join(home, "device", options.marker), "x");
  }
  let stdout = "",
    stderr = "";
  const calls: { path: string; body: unknown }[] = [];
  const controller = new AbortController();
  const openBrowser = vi.fn(async () => {
    if (options.openFails) throw new Error("browser unavailable");
  });
  const wait = vi.fn(async () => {
    if (options.abort) {
      controller.abort();
      throw new Error("interrupted");
    }
  });
  const code = await run(["--home", home, ...args], {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    env: {},
    signal: controller.signal,
    openBrowser,
    wait,
    fetch: async (input) => {
      const request = input as Request;
      calls.push({
        path: new URL(request.url).pathname,
        body: request.method === "POST" ? await request.json() : null,
      });
      const result = replies.shift();
      if (!result) throw new Error("unexpected local API request");
      return new Response(JSON.stringify(result), {
        status: "error" in result && !("protocol" in result) ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { code, stdout, stderr, calls, openBrowser, wait };
}
describe("native CLI login", () => {
  it.each(["keys.bin", "auth-install.bin"])(
    "warns and continues when the app marker %s exists",
    async (marker) => {
      const result = await invoke(["login"], [{ error: "auth.native.unavailable" }], { marker });
      expect(result.stderr).toContain("The Ant0 app is installed on this computer.");
      expect(result.calls[0]?.path).toBe("/v1/licence/native/begin");
    },
  );

  it("is silent on a headless data folder and for status", async () => {
    const plain = await invoke(["login"], [{ error: "auth.native.unavailable" }]);
    expect(plain.stderr).not.toContain("app is installed");
    const status = await invoke(
      ["--json", "login", "status"],
      [{ error: "auth.native.unavailable" }],
      {
        marker: "keys.bin",
      },
    );
    expect(status.stderr).not.toContain("app is installed");
  });

  it("help says the app owns sign-in", async () => {
    const result = await invoke(["login", "--help"], []);
    expect(result.stdout).toContain("sign in from the app instead");
  });

  it("default login never falls back to password when the provider is unavailable", async () => {
    const result = await invoke(["login"], [{ error: "auth.native.unavailable" }]);
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.path).toBe("/v1/licence/native/begin");
    expect(result.stdout).toBe("");
    expect(result.openBrowser).not.toHaveBeenCalled();
  });
  it("JSON pending status is explicit, secret-free and opens no browser", async () => {
    const state = pending();
    const result = await invoke(["--json", "login", "--device-code"], [state]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(state);
    expect(result.stdout).not.toContain("signed in");
    expect(result.openBrowser).not.toHaveBeenCalled();
    expect(result.calls[0]?.body).toMatchObject({
      client: "cli",
      delivery: "device_code",
      expected_account_id: null,
    });
  });
  it("opens only the approved URI with human-code fragment and waits for signed-in status", async () => {
    const state = pending();
    const done: NativeLoginStatus = {
      ...state,
      status: "signed_in",
      verification_uri: null,
      user_code: null,
      retry_after_s: null,
    };
    const result = await invoke(["login", "--browser"], [state, done]);
    expect(result.code).toBe(0);
    expect(result.openBrowser).toHaveBeenCalledWith(
      "https://ant0.link/account/authorize#code=ABCDE-FGHJK",
    );
    expect(result.wait).toHaveBeenCalledWith(5000, expect.anything());
    expect(result.stdout).toBe("signed in\n");
  });
  it("device-code mode and status require no GUI", async () => {
    const state = pending();
    const result = await invoke(["--json", "login", "status"], [state]);
    expect(result.code).toBe(0);
    expect(result.calls[0]?.path).toBe("/v1/licence/native/status");
    expect(result.openBrowser).not.toHaveBeenCalled();
  });
  it("cancel prints pending state and exits unsuccessfully until cancellation is confirmed", async () => {
    const state = pending();
    const waiting = { ...state, user_code: null, verification_uri: null };
    const result = await invoke(["--json", "login", "cancel"], [state, waiting]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(waiting);
    expect(result.stderr).toContain("cancellation remains pending");
  });
  it("cancels the owned transaction on interruption", async () => {
    const state = pending();
    const cancelled: NativeLoginStatus = {
      ...state,
      status: "cancelled",
      user_code: null,
      verification_uri: null,
    };
    const result = await invoke(["login", "--device-code"], [state, cancelled], { abort: true });
    expect(result.code).toBe(1);
    expect(result.calls[1]).toEqual({
      path: "/v1/licence/native/cancel",
      body: { transaction_id: state.transaction_id },
    });
  });
  it("cancels when opening the browser fails without claiming sign-in", async () => {
    const state = pending();
    const cancelled: NativeLoginStatus = {
      ...state,
      status: "cancelled",
      user_code: null,
      verification_uri: null,
    };
    const result = await invoke(["login"], [state, cancelled], { openFails: true });
    expect(result.code).toBe(1);
    expect(result.calls[1]?.path).toBe("/v1/licence/native/cancel");
    expect(result.stdout).toBe("");
  });
  it("rejects additional secret-bearing fields instead of printing raw JSON", async () => {
    const state = { ...pending(), refresh: "synthetic-private-refresh" };
    const result = await invoke(["--json", "login"], [state]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("synthetic-private-refresh");
  });
  it("rejects mixed legacy and browser arguments before API use", async () => {
    const result = await invoke(["login", "email@example.test", "--browser"], []);
    expect(result.code).toBe(2);
    expect(result.calls).toHaveLength(0);
  });
});
