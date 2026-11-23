import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows, trashedFixture } from "./fixtures.js";
import { MockDaemon } from "./mock-daemon.js";

const ONE = "00000000-0000-4000-8000-000000000001";
const TWO = "00000000-0000-4000-8000-000000000002";

let h: MockDaemon;
let items = [trashedFixture(ONE, "t-one"), trashedFixture(TWO, "t-two")];

beforeAll(async () => {
  h = await MockDaemon.start();
  h.on("GET", "/v1/trash", (req) => {
    const tag = req.query.get("tag");
    const shown = items.filter((p) => tag === null || p.tags.includes(tag));
    return { body: { items: shown, total: shown.length, trash_retention_days: 30 } };
  });
  h.on("DELETE", "/v1/trash", () => {
    const purged = items.length;
    items = [];
    return { body: { purged } };
  });
});
afterAll(async () => {
  await h.close();
});

describe("ant0 trash", () => {
  it("ls lists trashed profiles with deleted/purge columns and the retention footer", async () => {
    const r = await h.cli("trash", "ls");
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("(2 trashed; kept 30 day(s) after deletion)");
    const [header, ...body] = rows(lines.slice(0, -1).join("\n"));
    expect(header!.slice(-2)).toEqual(["DELETED", "PURGE AT"]);
    expect(body.map((row) => row[1]).sort()).toEqual(["t-one", "t-two"]);
    expect(body[0]!.at(-1)).toMatch(/^\d{4}-/);

    const filtered = await h.cli("trash", "ls", "--tag", "t-two");
    expect(h.requests.at(-1)!.query.get("tag")).toBe("t-two");
    expect(rows(filtered.stdout.split("\n(")[0]!)).toHaveLength(2);
  });

  it("ls --json is the daemon payload verbatim", async () => {
    const r = await h.cli("--json", "trash", "ls");
    expect(r.code, r.stderr).toBe(0);
    expect(r.json()).toEqual({ items, total: 2, trash_retention_days: 30 });
  });

  it("empty refuses without --yes off a terminal, then purges everything trashed", async () => {
    const refused = await h.cli("trash", "empty");
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--yes");
    expect(h.seen("DELETE", "/v1/trash")).toHaveLength(0);

    const r = await h.cli("trash", "empty", "--yes");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("purged 2 profile(s)\n");
    const j = await h.cli("--json", "trash", "empty", "-y");
    expect(j.json()).toEqual({ purged: 0 });
  });
});
