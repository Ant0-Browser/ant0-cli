import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mockDaemon, ID, SECRET, TOKEN, inventoryProfile } from "./mcp-helpers.js";
import {
  createKey,
  expectedContext,
  keyStatus,
  metadata,
  privateTestDirectory,
  readyFile,
  WORKSPACE,
} from "./mcp-key-helpers.js";
import { readCredentialFile, saveCredentialFile } from "@ant0/mcp/credentials";
import { runCli } from "./mock-daemon.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(handler: Parameters<typeof mockDaemon>[0]) {
  const daemon = await mockDaemon(handler);
  cleanups.push(daemon.close);
  privateTestDirectory(daemon.home);
  const path = join(daemon.home, "key.json");
  return { daemon, path, cli: (...args: string[]) => runCli(["--home", daemon.home, ...args]) };
}
describe("CLI API-key durable provisioning and management", () => {
  it.each(["credential", "secret"])(
    "rejects a provisioning reply echoing the %s as its allowed name",
    async (kind) => {
      let echoed = "";
      const f = await fixture(async (req, res) => {
        if (req.method === "GET") return void res.end(JSON.stringify(expectedContext));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const { create } = JSON.parse(Buffer.concat(chunks).toString());
        echoed = kind === "credential" ? create.credential : create.credential.slice(-43);
        res.end(JSON.stringify({ key: { ...metadata(create), name: echoed } }));
      });
      const result = await f.cli(
        "--json",
        "api-keys",
        "create",
        "Read",
        "--credential-file",
        f.path,
        "--preset",
        "read",
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(echoed);
      expect(readCredentialFile(f.path).value.phase).toBe("pending");
    },
  );
  it("rejects a credential echoed as list metadata or a cursor", async () => {
    const key = metadata();
    const f = await fixture((req, res) =>
      res.end(
        JSON.stringify(
          req.url === "/v1/automation/api-keys/context"
            ? expectedContext
            : {
                items: [{ ...key, name: createKey.credential }],
                next_cursor: createKey.credential,
              },
        ),
      ),
    );
    const result = await f.cli("--json", "api-keys", "list");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(createKey.credential);
  });
  it("creates the operate preset with explicit CDP without changing the read preset", async () => {
    let submitted: any;
    const f = await fixture(async (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify(expectedContext));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submitted = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ key: metadata(submitted.create) }));
    });
    const result = await f.cli(
      "--json",
      "api-keys",
      "create",
      "Operator",
      "--credential-file",
      f.path,
      "--preset",
      "operate",
      "--scope",
      "profiles:cdp",
    );
    expect(result.code, result.stderr).toBe(0);
    expect(submitted.create.scopes).toEqual([
      "status:read",
      "profiles:read",
      "proxies:read",
      "profiles:run",
      "profiles:stop",
      "profiles:cdp",
    ]);
    expect(readCredentialFile(f.path).value.create.scopes).toEqual(submitted.create.scopes);
  });
  it("recovers the exact durable request after the actual CLI process is killed without a PID lock", async () => {
    const bodies: any[] = [];
    let resultKey: ReturnType<typeof metadata> | undefined;
    let recovering = false;
    const f = await fixture(async (req, res) => {
      if (req.url === "/v1/automation/api-keys/context")
        return void res.end(JSON.stringify(expectedContext));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      resultKey ??= metadata(body.create);
      if (recovering) res.end(JSON.stringify({ key: resultKey }));
      else {
        res.writeHead(200);
        res.write("{");
      }
    });
    const command = [
      "--home",
      f.daemon.home,
      "api-keys",
      "create",
      "Crash test",
      "--credential-file",
      f.path,
      "--preset",
      "read",
    ];
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...command],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    try {
      await expect.poll(() => bodies.length, { timeout: 20_000 }).toBe(1);
      const pending = readCredentialFile(f.path).value;
      expect(pending.phase).toBe("pending");
      expect(pending.create).toEqual(bodies[0].create);
      child.kill("SIGKILL");
      await closed;
      expect(existsSync(`${f.path}.lock`)).toBe(false);
      recovering = true;
      const result = await f.cli(
        "--json",
        "api-keys",
        "create",
        "--credential-file",
        f.path,
        "--preset",
        "read",
      );
      expect(result.code, result.stderr).toBe(0);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(readCredentialFile(f.path).value.create).toEqual(pending.create);
      expect(existsSync(`${f.path}.lock`)).toBe(false);
      expect(output + result.stdout + result.stderr).not.toContain(pending.create.credential);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  }, 30_000);
  it("uses master context, saves owner-only pending before POST, emits metadata only and recovers exactly after a lost reply", async () => {
    let path = "";
    let lost = true;
    const bodies: any[] = [];
    let key: ReturnType<typeof metadata>;
    const f = await fixture(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      if (req.url === "/v1/automation/api-keys/context")
        return void res.end(JSON.stringify(expectedContext));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      expect(req.url).toBe("/v1/automation/api-keys/provision");
      const disk = readCredentialFile(path).value;
      expect(disk.phase).toBe("pending");
      expect(disk.key).toBeNull();
      expect(body).toEqual({ expected: disk.expected, create: disk.create });
      if (lost) {
        key = metadata(body.create);
        res.destroy();
      } else res.end(JSON.stringify({ key: { ...key, credential: SECRET }, credential: SECRET }));
    });
    path = f.path;
    const command = [
      "--json",
      "api-keys",
      "create",
      "Original",
      "--credential-file",
      path,
      "--preset",
      "read",
    ];
    const first = await f.cli(...command);
    expect(first.code).toBe(1);
    expect(first.stdout).toBe("");
    const pendingBytes = readFileSync(path, "utf8");
    expect(readCredentialFile(path).value.phase).toBe("pending");
    lost = false;
    const second = await f.cli(...command);
    expect(second.code, second.stderr).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    const ready = readCredentialFile(path).value;
    expect(ready.phase).toBe("ready");
    expect(ready.create).toEqual(JSON.parse(pendingBytes).create);
    expect(second.json()).toEqual({ key: key!, credential_file: path });
    expect(second.stdout).not.toContain(ready.create.credential);
    expect(second.stdout).not.toContain(SECRET);
  });
  it.each([
    ["--name", "Different"],
    ["--lifetime-seconds", "60"],
    ["--workspace", ID],
  ])("rejects recovery option mismatch before HTTP: %s", async (...options) => {
    const f = await fixture((_req, res) => res.end(JSON.stringify(expectedContext)));
    const ready = readyFile();
    saveCredentialFile(f.path, { ...ready, phase: "pending", key: null });
    const before = readFileSync(f.path, "utf8");
    const result = await f.cli(
      "api-keys",
      "create",
      "--credential-file",
      f.path,
      "--preset",
      "read",
      ...options,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("do not match");
    expect(f.daemon.requests).toEqual([]);
    expect(readFileSync(f.path, "utf8")).toBe(before);
  });
  it.each(["workspace_id", "user_id", "device_id", "device_sign_pub"])(
    "rejects changed daemon %s without resubmission",
    async (field) => {
      const context = {
        ...expectedContext,
        [field]:
          field === "device_id"
            ? "B".repeat(26)
            : field === "device_sign_pub"
              ? Buffer.alloc(32, 9).toString("base64")
              : ID,
      };
      const f = await fixture((_req, res) => res.end(JSON.stringify(context)));
      const ready = readyFile();
      saveCredentialFile(f.path, { ...ready, phase: "pending", key: null });
      const before = readFileSync(f.path, "utf8");
      const result = await f.cli(
        "api-keys",
        "create",
        "--credential-file",
        f.path,
        "--preset",
        "read",
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("context does not match");
      expect(f.daemon.requests).toHaveLength(1);
      expect(readFileSync(f.path, "utf8")).toBe(before);
    },
  );
  it("requires explicit workspace to match the selection and never switches it", async () => {
    const f = await fixture((_req, res) => res.end(JSON.stringify(expectedContext)));
    const result = await f.cli(
      "api-keys",
      "create",
      "Read",
      "--credential-file",
      f.path,
      "--preset",
      "read",
      "--workspace",
      ID,
    );
    expect(result.code).toBe(2);
    expect(existsSync(f.path)).toBe(false);
    expect(f.daemon.requests.map((r) => r.url)).toEqual(["/v1/automation/api-keys/context"]);
  });
  it.each(["renamed", "revoked", "expired"])(
    "recovers %s metadata without regenerating the key",
    async (state) => {
      const ready = readyFile();
      if (state === "renamed") ready.key!.name = "New label";
      if (state === "revoked") {
        ready.key!.status = "revoked";
        ready.key!.revoked_at = new Date().toISOString();
      }
      if (state === "expired") {
        ready.key!.status = "expired";
        ready.key!.created_at = "2020-01-01T00:00:00.000Z";
        ready.key!.expires_at = "2020-01-31T00:00:00.000Z";
      }
      const f = await fixture((req, res) =>
        res.end(JSON.stringify(req.method === "GET" ? expectedContext : { key: ready.key })),
      );
      saveCredentialFile(f.path, { ...ready, phase: "pending", key: null });
      const result = await f.cli(
        "--json",
        "api-keys",
        "create",
        "--credential-file",
        f.path,
        "--preset",
        "read",
      );
      expect(result.code, result.stderr).toBe(0);
      expect(readCredentialFile(f.path).value).toEqual(ready);
    },
  );
  it("refuses a file changed during provision and leaves replacement data untouched", async () => {
    let path = "";
    const f = await fixture(async (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify(expectedContext));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { create } = JSON.parse(Buffer.concat(chunks).toString());
      writeFileSync(path, "CHANGED");
      res.end(JSON.stringify({ key: metadata(create) }));
    });
    path = f.path;
    const result = await f.cli(
      "api-keys",
      "create",
      "Read",
      "--credential-file",
      path,
      "--preset",
      "read",
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(readFileSync(path, "utf8")).toBe("CHANGED");
  });
  it.each(["id", "workspace", "scopes", "expiry", "name", "malformed"])(
    "rejects a malformed or mismatched %s provisioning reply and retains pending recovery",
    async (kind) => {
      const f = await fixture(async (req, res) => {
        if (req.method === "GET") return void res.end(JSON.stringify(expectedContext));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const { create } = JSON.parse(Buffer.concat(chunks).toString());
        const key = metadata(create);
        if (kind === "id") key.id = ID;
        if (kind === "workspace") key.workspace_id = ID;
        if (kind === "scopes") key.scopes = ["profiles:read"];
        if (kind === "expiry")
          key.expires_at = new Date(Date.parse(key.expires_at) + 1000).toISOString();
        if (kind === "name") key.name = SECRET.repeat(20);
        res.end(kind === "malformed" ? `{${SECRET}` : JSON.stringify({ key }));
      });
      const result = await f.cli(
        "--json",
        "api-keys",
        "create",
        "Read",
        "--credential-file",
        f.path,
        "--preset",
        "read",
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(SECRET);
      expect(readCredentialFile(f.path).value.phase).toBe("pending");
    },
  );
  it("manages closed metadata list/show/rename/revoke with master authentication", async () => {
    const key = metadata();
    const f = await fixture(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      if (req.url === "/v1/automation/api-keys/context")
        return void res.end(JSON.stringify(expectedContext));
      if (req.method === "DELETE") {
        res.writeHead(204);
        return void res.end();
      }
      if (req.method === "PATCH") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        key.name = JSON.parse(Buffer.concat(chunks).toString()).name;
      }
      res.end(
        JSON.stringify(
          req.url!.includes("?")
            ? { items: [{ ...key, credential: SECRET }], next_cursor: "next" }
            : { key: { ...key, hash: SECRET } },
        ),
      );
    });
    const list = await f.cli("--json", "api-keys", "list", "--limit", "1", "--cursor", "a&b");
    expect(list.code).toBe(0);
    expect(list.json()).toEqual({ items: [key], next_cursor: "next" });
    const show = await f.cli("--json", "api-keys", "show", key.id);
    expect(show.json()).toEqual({ key });
    const rename = await f.cli("--json", "api-keys", "rename", key.id, "Renamed");
    expect(rename.json()).toEqual({ key });
    const revoke = await f.cli("--json", "api-keys", "revoke", key.id);
    expect(revoke).toMatchObject({ code: 0, stdout: "" });
    expect(list.stdout + show.stdout + rename.stdout).not.toContain(SECRET);
    expect(new URL(f.daemon.requests[1]!.url, "http://localhost").searchParams.get("cursor")).toBe(
      "a&b",
    );
  });
});

describe("CLI private-key read mode", () => {
  it("reads profiles/status/proxies/key-status without the master file and sends api consumer", async () => {
    const ready = readyFile();
    const f = await fixture((req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname;
      res.end(
        JSON.stringify(
          path === "/v1/automation/status"
            ? keyStatus(ready)
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
    saveCredentialFile(f.path, ready);
    rmSync(join(f.daemon.home, "ant0d.token"));
    for (const command of [
      ["profiles", "ls"],
      ["profiles", "status", ID],
      ["proxies", "ls"],
      ["key-status"],
    ]) {
      const result = await f.cli("--json", "--credential-file", f.path, ...command);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(ready.create.credential);
      if (command[0] !== "profiles" || command[1] !== "ls")
        expect(result.stdout).not.toContain(SECRET);
    }
    expect(f.daemon.requests).toHaveLength(4);
    expect(
      f.daemon.requests.every(
        (r) => r.authorization === `Bearer ${ready.create.credential}` && r.consumer === "api",
      ),
    ).toBe(true);
  });
  it.each([
    ["profiles", "show", ID],
    ["profiles", "promote", ID, "--folder-id", "null"],
    ["api-keys", "list"],
    ["account"],
    ["proxies", "show", ID],
  ])(
    "rejects unsupported --credential-file use before master discovery: %s",
    async (...command) => {
      const f = await fixture((_req, res) => res.end());
      const result = await f.cli("--credential-file", f.path, ...command);
      expect(result.code).toBe(2);
      expect(f.daemon.requests).toEqual([]);
    },
  );
  it("routes run/status/stop/CDP start and bulk operations only through the key allowlist", async () => {
    const ready = readyFile();
    ready.create.scopes = [
      "status:read",
      "profiles:read",
      "proxies:read",
      "profiles:run",
      "profiles:stop",
      "profiles:cdp",
    ];
    ready.key!.scopes = [...ready.create.scopes];
    const bodies: unknown[] = [];
    const f = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      const path = new URL(req.url!, "http://localhost").pathname;
      if (req.method === "GET")
        return void res.end(
          JSON.stringify(
            path === `/v1/inventory/profiles/${ID}` ? inventoryProfile : inventoryProfile.lifecycle,
          ),
        );
      if (path.endsWith("/stop")) {
        res.writeHead(204);
        return void res.end();
      }
      if (path.endsWith("/start"))
        return void res.end(JSON.stringify(inventoryProfile.profile.runtime));
      if (path.endsWith("/bulk-start"))
        return void res.end(JSON.stringify({ updated: 2, errors: [] }));
      if (path.endsWith("/bulk-stop"))
        return void res.end(JSON.stringify({ updated: 2, errors: [] }));
      return void res.end(
        JSON.stringify({
          requested_profile_id: ID,
          profile_id: ID,
          redirected: false,
          lifecycle: inventoryProfile.lifecycle,
        }),
      );
    });
    saveCredentialFile(f.path, ready);
    rmSync(join(f.daemon.home, "ant0d.token"));
    const base = ["--json", "--credential-file", f.path, "profiles"];
    for (const command of [
      ["run", ID, "--timeout", "1"],
      ["status", ID],
      ["stop", ID, "--force"],
      ["start", ID, "--headless"],
      ["start", ID, "other"],
      ["stop", ID, "other"],
    ]) {
      const result = await f.cli(...base, ...command);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(ready.create.credential);
    }
    expect(f.daemon.requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", `/v1/profiles/${ID}/run`],
      ["GET", `/v1/inventory/profiles/${ID}`],
      ["POST", `/v1/profiles/${ID}/stop`],
      ["POST", `/v1/profiles/${ID}/start`],
      ["POST", "/v1/profiles/bulk-start"],
      ["POST", "/v1/profiles/bulk-stop"],
    ]);
    expect(f.daemon.requests.every((request) => request.consumer === "api")).toBe(true);
    expect(
      f.daemon.requests.every(
        (request) => request.authorization === `Bearer ${ready.create.credential}`,
      ),
    ).toBe(true);
    expect(bodies).toEqual([
      { timeout_s: 1 },
      { force: true },
      { headless: true },
      { ids: [ID, "other"] },
      { ids: [ID, "other"] },
    ]);
  });
  it("rejects missing operational scopes before HTTP", async () => {
    const f = await fixture((_req, res) => res.end());
    saveCredentialFile(f.path, readyFile());
    for (const command of [
      ["profiles", "run", ID],
      ["profiles", "stop", ID],
      ["profiles", "start", ID],
    ]) {
      const result = await f.cli("--credential-file", f.path, ...command);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("credential file does not grant");
    }
    expect(f.daemon.requests).toEqual([]);
  });
  it("does not fall back to the master token on a missing key file or a rejected key", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(403);
      res.end(JSON.stringify({ error: SECRET, message: SECRET }));
    });
    expect((await f.cli("--credential-file", f.path, "profiles", "ls")).code).toBe(1);
    expect(f.daemon.requests).toEqual([]);
    const ready = readyFile();
    saveCredentialFile(f.path, ready);
    const result = await f.cli("--credential-file", f.path, "profiles", "ls");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(SECRET);
    expect(f.daemon.requests).toHaveLength(1);
    expect(f.daemon.requests[0]!.authorization).toBe(`Bearer ${ready.create.credential}`);
  });
});
