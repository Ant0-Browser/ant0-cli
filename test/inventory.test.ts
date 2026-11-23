import { afterEach, describe, expect, it } from "vitest";
import { Ant0ApiError } from "../src/api/index.js";
import { inventoryRead } from "../src/inventory.js";
import { ID, DATE, SECRET, inventoryProfile, mockDaemon, profile } from "./mcp-helpers.js";
import { runCli } from "./mock-daemon.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const summary = {
  id: ID,
  name: "A profile",
  group: null,
  local_folder_id: null,
  tags: ["work"],
  notes: "ordinary user-authored notes",
  status: null,
  pinned: false,
  platform: "linux",
  created_at: DATE,
  updated_at: DATE,
  proxy_id: ID,
  browser_version: profile.browser_version,
  identity_mode: "synthetic",
  last_launched_at: null,
  deleted_at: null,
};
const item = { ...inventoryProfile, profile: { ...profile, ...summary } };
async function setup(handler: Parameters<typeof mockDaemon>[0]) {
  const daemon = await mockDaemon(handler);
  cleanups.push(daemon.close);
  return { daemon, cli: (...args: string[]) => runCli(["--home", daemon.home, ...args]) };
}

describe("CLI profile inventory consumers", () => {
  it("keeps the list JSON summary shape, filters on the server and strips nested canary extras", async () => {
    const { cli, daemon } = await setup((_req, res) =>
      res.end(JSON.stringify({ items: [item], total: 11 })),
    );
    const result = await cli(
      "--json",
      "profiles",
      "ls",
      "--running",
      "--limit",
      "1",
      "--offset",
      "10",
      "--group",
      "folder &?",
      "--tag",
      "a&b",
      "-q",
      "inventory",
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toEqual({ items: [summary], total: 11 });
    expect(result.stdout).not.toContain(SECRET);
    expect(daemon.requests).toHaveLength(1);
    const url = new URL(daemon.requests[0]!.url, "http://localhost");
    expect(url.pathname).toBe("/v1/inventory/profiles");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      running: "true",
      limit: "1",
      offset: "10",
      group: "folder &?",
      tag: "a&b",
      q: "inventory",
    });
  });

  it("preserves a valid assigned local folder ID in list JSON", async () => {
    const localFolderId = "87654321-4321-4abc-8abc-cba987654321";
    const assignedItem = {
      ...item,
      profile: { ...item.profile, local_folder_id: localFolderId },
    };
    const { cli, daemon } = await setup((_req, res) =>
      res.end(JSON.stringify({ items: [assignedItem], total: 1 })),
    );
    const result = await cli("--json", "profiles", "ls");
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toEqual({
      items: [{ ...summary, local_folder_id: localFolderId }],
      total: 1,
    });
    expect(result.stdout).not.toContain(SECRET);
    expect(daemon.requests).toHaveLength(1);
  });

  it.each([
    ["malformed", "not-a-uuid"],
    ["uppercase noncanonical", "87654321-4321-4ABC-8ABC-CBA987654321"],
    ["non-v4", "87654321-4321-3abc-8abc-cba987654321"],
    ["non-RFC variant", "87654321-4321-4abc-7abc-cba987654321"],
    ["missing", undefined],
  ])("rejects %s local folder IDs in list JSON", async (_kind, localFolderId) => {
    const invalidProfile = { ...item.profile, local_folder_id: localFolderId };
    const { cli } = await setup((_req, res) =>
      res.end(JSON.stringify({ items: [{ ...item, profile: invalidProfile }], total: 1 })),
    );
    const result = await cli("--json", "profiles", "ls");
    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "ant0: invalid inventory response\n",
    });
    expect(result.stdout).not.toContain(SECRET);
  });

  it("does not cache visible totals or substitute an empty result after a fresh authorization failure", async () => {
    let available = true;
    const { cli, daemon } = await setup((_req, res) => {
      if (!available) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "sync.store_unavailable", message: SECRET }));
      } else res.end(JSON.stringify({ items: [item], total: 1 }));
    });
    expect((await cli("--json", "profiles", "ls")).json()).toEqual({ items: [summary], total: 1 });
    available = false;
    const failed = await cli("--json", "profiles", "ls");
    expect(failed).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "ant0: sync.store_unavailable: inventory unavailable\n",
    });
    expect(daemon.requests).toHaveLength(2);
  });

  it("preserves status wrapper with only lifecycle metadata in JSON and text", async () => {
    const { cli, daemon } = await setup((_req, res) => res.end(JSON.stringify(item)));
    const result = await cli("--json", "profiles", "status", ID);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toEqual({
      state: "running",
      session: {
        profile_id: ID,
        started_at: DATE,
        browser_version: profile.browser_version,
        headless: true,
      },
    });
    const text = await cli("profiles", "status", ID);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("running");
    for (const forbidden of [SECRET, "ws_endpoint", "debug_port", "cdp_http", "pid", "password"]) {
      expect(result.stdout).not.toContain(forbidden);
      expect(text.stdout).not.toContain(forbidden);
    }
    expect(daemon.requests.map((request) => request.url)).toEqual([
      `/v1/inventory/profiles/${ID}`,
      `/v1/inventory/profiles/${ID}`,
    ]);
  });

  it.each(["inventory", "sessions", "proxies", "status", "bulk-start", "a/b ?#&"])(
    "resolves exact name %s once through the inventory namespace",
    async (name) => {
      const { cli, daemon } = await setup((_req, res) =>
        res.end(
          JSON.stringify({
            ...item,
            profile: { ...item.profile, name },
          }),
        ),
      );
      const result = await cli("--json", "profiles", "status", name);
      expect(result.code, result.stderr).toBe(0);
      expect(daemon.requests.map((request) => request.url)).toEqual([
        `/v1/inventory/profiles/${encodeURIComponent(name)}`,
      ]);
    },
  );

  it.each([403, 404, 409, 503])(
    "fails safely on HTTP %s without full-session fallback",
    async (status) => {
      const { cli, daemon } = await setup((_req, res) => {
        res.writeHead(status);
        res.end(JSON.stringify({ error: SECRET, message: SECRET, details: { raw: SECRET } }));
      });
      for (const command of [["ls"], ["status", ID]]) {
        const result = await cli("--json", "profiles", ...command);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`ant0: http_${status}: inventory unavailable\n`);
      }
      expect(daemon.requests.every((request) => request.url.startsWith("/v1/inventory/"))).toBe(
        true,
      );
    },
  );

  it.each([
    ["missing lifecycle", { ...item, lifecycle: undefined }],
    ["invalid state", { ...item, lifecycle: { ...item.lifecycle, state: SECRET } }],
    ["partial session", { ...item, lifecycle: { ...item.lifecycle, headless: null } }],
    [
      "invalid date",
      { ...item, lifecycle: { ...item.lifecycle, started_at: "2026-02-30T00:00:00Z" } },
    ],
    ["invalid profile", { ...item, profile: { ...item.profile, tags: SECRET } }],
    ["invalid permission", { ...item, permissions: { edit: true, cdp: SECRET } }],
    ["invalid proxy", { ...item, proxy: { ...item.proxy, type: SECRET } }],
    [
      "wrong profile",
      { ...item, profile: { ...item.profile, id: "00000000-0000-0000-0000-000000000000" } },
    ],
  ])("rejects %s without output or raw diagnostics", async (_kind, body) => {
    const { cli } = await setup((_req, res) => res.end(JSON.stringify(body)));
    const result = await cli("--json", "profiles", "status", ID);
    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "ant0: invalid inventory response\n",
    });
  });

  it.each([
    { items: [], total: 1 },
    { items: [item], total: 0 },
    { items: [item] },
    { items: [item, item], total: 2 },
    { items: [item], total: "1" },
  ])("rejects incomplete or invalid inventory page %#", async (body) => {
    const { cli } = await setup((_req, res) => res.end(JSON.stringify(body)));
    expect(await cli("--json", "profiles", "ls")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "ant0: invalid inventory response\n",
    });
  });

  it("keeps typed API errors and status while discarding raw diagnostic fields", async () => {
    const failure = new Ant0ApiError(403, "team.forbidden", SECRET, { secret: SECRET });
    const result = await inventoryRead(async () => {
      throw failure;
    }).catch((error) => error);
    expect(result).toBeInstanceOf(Ant0ApiError);
    expect(result).toMatchObject({
      status: 403,
      code: "team.forbidden",
      message: "inventory unavailable",
    });
    expect(result.details).toBeUndefined();
  });

  it("rejects malformed JSON without echoing its contents", async () => {
    const { cli } = await setup((_req, res) => res.end(`{${SECRET}`));
    expect(await cli("--json", "profiles", "ls")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "ant0: inventory unavailable\n",
    });
  });

  it("bounds complete JSON results before emitting any partial inventory", async () => {
    const items = Array.from({ length: 600 }, (_, i) => {
      const id = `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`;
      return {
        ...item,
        profile: { ...item.profile, id, notes: "x".repeat(16000) },
        lifecycle: { ...item.lifecycle, profile_id: id },
      };
    });
    const { cli } = await setup((_req, res) =>
      res.end(JSON.stringify({ items, total: items.length })),
    );
    expect(await cli("--json", "profiles", "ls", "--limit", "600")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "ant0: inventory result exceeds limit; request fewer items\n",
    });
  });

  it("retains guarded full show, single start and bulk-start without inventory-based admission", async () => {
    const { cli, daemon } = await setup((_req, res) => {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "team.forbidden", message: "operation denied" }));
    });
    for (const command of [
      ["show", ID],
      ["start", ID],
      ["start", ID, "other"],
    ]) {
      const result = await cli("--json", "profiles", ...command);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("team.forbidden");
    }
    expect(daemon.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", `/v1/profiles/${ID}`],
      ["POST", `/v1/profiles/${ID}/start`],
      ["POST", "/v1/profiles/bulk-start"],
    ]);
  });
});
