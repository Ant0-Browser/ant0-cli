import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows, summaryFixture } from "./fixtures.js";
import { MockDaemon, apiError } from "./mock-daemon.js";

const ALPHA = "00000000-0000-4000-8000-0000000000a1";
const BULK = "00000000-0000-4000-8000-0000000000b1";

let h: MockDaemon;
let list = [
  summaryFixture(ALPHA, "alpha", { group: "team", tags: ["a", "b"], pinned: true }),
  summaryFixture(BULK, "bulk-1"),
];

beforeAll(async () => {
  h = await MockDaemon.start();
  h.on("GET", "/v1/inventory/profiles", (req) => {
    const group = req.query.get("group");
    const tag = req.query.get("tag");
    const items = list
      .filter(
        (p) => (group === null || p.group === group) && (tag === null || p.tags.includes(tag)),
      )
      .map((profile) => ({
        profile,
        lifecycle: {
          profile_id: profile.id,
          state: "stopped",
          started_at: null,
          browser_version: null,
          headless: null,
        },
        proxy: null,
        permissions: { edit: true, cdp: true },
      }));
    return { body: { items, total: items.length } };
  });
  h.on("GET", "/v1/profiles/:id", (req) => {
    const found = list.find((p) => p.id === req.params.id || p.name === req.params.id);
    return found ? { body: found } : apiError(404, "profile.not_found", "no such profile");
  });
});
afterAll(async () => {
  await h.close();
});

describe("ant0 profiles", () => {
  it("ls prints only the header when there are no profiles", async () => {
    const empty = await MockDaemon.start();
    try {
      empty.on("GET", "/v1/inventory/profiles", { body: { items: [], total: 0 } });
      const r = await empty.cli("profiles", "ls");
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(rows(r.stdout)).toEqual([
        [
          "ID",
          "NAME",
          "GROUP",
          "TAGS",
          "PLATFORM",
          "STATUS",
          "PINNED",
          "IDENTITY",
          "PROXY",
          "BROWSER",
        ],
      ]);
    } finally {
      await empty.close();
    }
  });

  it("ls renders a row per profile and passes --group and --tag to the daemon", async () => {
    const all = await h.cli("profiles", "ls");
    expect(rows(all.stdout)).toHaveLength(3);
    const team = await h.cli("profiles", "ls", "--group", "team");
    expect(h.requests.at(-1)!.query.get("group")).toBe("team");
    const [, ...body] = rows(team.stdout);
    expect(body).toHaveLength(1);
    expect(body[0]![1]).toBe("alpha");
    expect(body[0]![2]).toBe("team");
    expect(body[0]![3]).toBe("a,b");
    expect(body[0]![4]).toBe("windows");
    expect(body[0]![6]).toBe("true");

    const tagged = await h.cli("--json", "profiles", "ls", "--tag", "b");
    expect(h.requests.at(-1)!.query.get("tag")).toBe("b");
    expect(tagged.json<{ items: { name: string }[] }>().items.map((p) => p.name)).toEqual([
      "alpha",
    ]);
  });

  it("unknown profiles exit 1 with the namespaced code", async () => {
    const r = await h.cli("profiles", "show", "does-not-exist");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^ant0: profile\.not_found: /);
  });

  it("create --proxy rejects garbage locally with a usage error", async () => {
    const before = h.requests.length;
    const r = await h.cli("profiles", "create", "bad", "--proxy", "nonsense");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^ant0: --proxy: /);
    expect(h.requests).toHaveLength(before);
  });

  it("edit without --set is a usage error", async () => {
    const r = await h.cli("profiles", "edit", "alpha");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--set");
  });

  it("validation failures exit 1 with the code, message and one line per issue", async () => {
    h.on("POST", "/v1/profiles", () =>
      apiError(400, "validation_failed", "invalid profile", [
        { instancePath: "/launch/start_urls/0", message: 'must match format "uri"' },
      ]),
    );
    const r = await h.cli("profiles", "create", "broken", "--start-url", "not a url");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ant0: validation_failed: /);
    expect(lines.slice(1)).toEqual(['  launch.start_urls.0: must match format "uri"']);
  });

  it("run rejects out-of-contract timeout and conflict consent locally", async () => {
    const before = h.requests.length;
    expect((await h.cli("profiles", "run", "alpha", "--timeout", "0")).code).toBe(2);
    expect((await h.cli("profiles", "run", "alpha", "--timeout", "601")).code).toBe(2);
    expect(
      (await h.cli("profiles", "run", "alpha", "--conflict-profile-id", "not-a-uuid")).code,
    ).toBe(2);
    expect(h.requests).toHaveLength(before);
  });

  it("rm --permanent without --yes refuses off a terminal (exit 2) and deletes nothing", async () => {
    const r = await h.cli("profiles", "rm", "bulk-1", "--permanent");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(h.requests.filter((req) => req.method === "DELETE")).toHaveLength(0);
  });

  it("set without a change is a usage error", async () => {
    const none = await h.cli("profiles", "set", "bulk-1");
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("--tag-add");
  });
});
