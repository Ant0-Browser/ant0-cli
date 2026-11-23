import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AT } from "./fixtures.js";
import { MockDaemon } from "./mock-daemon.js";

const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const TEAM = "00000000-0000-4000-8000-000000000002";

function workspace(
  id: string,
  name: string,
  usability: "usable" | "unusable" | "requires_cloud_check",
) {
  return {
    id,
    name,
    role: "owner" as const,
    status: usability === "usable" ? ("active" as const) : ("suspended" as const),
    plan: { id: "p50", name: "P50", profiles: 50, seats: 2, features: ["sync", "teams"] },
    seats: 2,
    seats_extra: 0,
    period_end: null,
    grace_until: null,
    created_at: AT,
    usability,
  };
}

describe("ant0 workspace", () => {
  let h: MockDaemon;

  beforeAll(async () => {
    h = await MockDaemon.start();
    h.on("GET", "/v1/workspaces", () => ({
      body: {
        account: { id: ACCOUNT, email: "owner@example.com" },
        current_workspace_id: PERSONAL,
        workspaces: [
          workspace(PERSONAL, "Personal", "usable"),
          workspace(TEAM, "Operations", "unusable"),
        ],
      },
    }));
    h.on("POST", "/v1/workspaces/current", () => ({
      body: { workspace: { id: TEAM, name: "Operations" } },
    }));
  });

  afterAll(async () => h.close());

  it("lists the account, current marker and explicit usability", async () => {
    const result = await h.cli("workspace", "list");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`account            owner@example.com (${ACCOUNT})`);
    expect(result.stdout).toContain(`current workspace  ${PERSONAL}`);
    expect(result.stdout).toContain("Operations");
    expect(result.stdout).toContain("unusable");

    const json = await h.cli("--json", "workspace", "list");
    expect(json.json()).toMatchObject({
      account: { email: "owner@example.com" },
      current_workspace_id: PERSONAL,
      workspaces: [
        { id: PERSONAL, usability: "usable" },
        { id: TEAM, usability: "unusable" },
      ],
    });
  });

  it("switches by UUID and rejects malformed ids before the API call", async () => {
    const result = await h.cli("workspace", "switch", TEAM);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`active workspace  Operations (${TEAM})\n`);
    expect(h.seen("POST", "/v1/workspaces/current")[0]!.body).toEqual({ workspace_id: TEAM });

    const invalid = await h.cli("workspace", "switch", "not-a-uuid");
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("lowercase canonical UUID");
    expect(h.seen("POST", "/v1/workspaces/current")).toHaveLength(1);
  });

  it("is documented in root and nested help", async () => {
    expect((await h.cli("--help")).stdout).toContain("workspace");
    const help = await h.cli("workspace", "--help");
    expect(help.stdout).toContain("list");
    expect(help.stdout).toContain("switch");
  });
});
