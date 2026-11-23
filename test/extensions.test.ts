import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { components } from "../src/api/index.js";
import { AT, rows } from "./fixtures.js";
import { MockDaemon, apiError } from "./mock-daemon.js";

type Extension = components["schemas"]["Extension"];

const PROFILE = "00000000-0000-4000-8000-000000000001";
const HELLO_ID = "hello-ant0-0a1b2c3d";
const HELLO_PATH = "/library/hello-ant0-0a1b2c3d";

function hello(used_by: string[] = []): Extension {
  return {
    id: HELLO_ID,
    name: "Hello Ant0",
    version: "1.62",
    description: "Hello Ant0 says hello",
    manifest_version: 3,
    icon_path: null,
    icon_data_url: "data:image/png;base64,AAAA",
    path: HELLO_PATH,
    size_bytes: 2048,
    added_at: AT,
    used_by,
  } satisfies Extension;
}

let h: MockDaemon;
let library: Extension[] = [];

beforeAll(async () => {
  h = await MockDaemon.start();
  h.on("GET", "/v1/extensions", () => ({ body: { items: library } }));
  h.on("POST", "/v1/extensions", (req) => {
    const path = (req.body as { path: string }).path;
    if (path.endsWith("not-an-extension"))
      return apiError(400, "extension.invalid", "no manifest.json in this folder");
    const existing = library.length > 0;
    if (!existing) library = [hello()];
    return { status: existing ? 200 : 201, body: { ...library[0]!, existing } };
  });
  h.on("GET", "/v1/extensions/:id", (req) => {
    const found = library.find((e) => e.id === req.params.id);
    return found ? { body: found } : apiError(404, "extension.not_found", "no such extension");
  });
  h.on("DELETE", "/v1/extensions/:id", (req) => {
    const found = library.find((e) => e.id === req.params.id);
    if (!found) return apiError(404, "extension.not_found", "no such extension");
    if (found.used_by.length > 0 && req.query.get("force") !== "true")
      return apiError(409, "extension.in_use", "used by 1 profile");
    library = library.filter((e) => e !== found);
    return { body: { id: found.id, updated_profiles: found.used_by } };
  });
});
afterAll(async () => {
  await h.close();
});

describe("ant0 extensions", () => {
  it("ls prints only the header for an empty library", async () => {
    const r = await h.cli("extensions", "ls");
    expect(r.code, r.stderr).toBe(0);
    expect(rows(r.stdout)).toEqual([["ID", "NAME", "VERSION", "MV", "SIZE", "USED BY", "PATH"]]);
  });

  it("add sends the absolute path and prints its fields without the icon data URL", async () => {
    const r = await h.cli("extensions", "add", "some/relative/hello");
    expect(r.code, r.stderr).toBe(0);
    expect(h.seen("POST", "/v1/extensions")[0]!.body).toEqual({
      path: resolve("some/relative/hello"),
    });
    const kv = new Map(rows(r.stdout).map(([k, v]) => [k, v]));
    expect(kv.get("name")).toBe("Hello Ant0");
    expect(kv.get("version")).toBe("1.62");
    expect(kv.get("manifest_version")).toBe("3");
    expect(kv.get("existing")).toBe("false");
    expect(kv.has("icon_data_url")).toBe(false);
    expect(kv.get("id")).toBe(HELLO_ID);

    const again = await h.cli("--json", "extensions", "add", "some/relative/hello");
    expect(again.code, again.stderr).toBe(0);
    expect(again.json<Extension & { existing: boolean }>()).toMatchObject({
      id: HELLO_ID,
      existing: true,
    });
    const human = await h.cli("extensions", "add", "some/relative/hello");
    expect(human.stdout.split("\n")[0]).toBe(`already in the library as ${HELLO_ID}`);
  });

  it("add reports a folder the daemon rejects", async () => {
    const r = await h.cli("extensions", "add", "/scratch/not-an-extension");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^ant0: extension\.invalid: .*manifest\.json/);
  });

  it("ls and show report the profiles using an extension", async () => {
    library = [hello([PROFILE])];
    const ls = await h.cli("extensions", "ls");
    const [, row] = rows(ls.stdout);
    expect(row).toEqual([HELLO_ID, "Hello Ant0", "1.62", "3", row![4], "1", HELLO_PATH]);

    const show = await h.cli("--json", "extensions", "show", HELLO_ID);
    expect(show.code, show.stderr).toBe(0);
    expect(show.json<Extension>().used_by).toEqual([PROFILE]);

    const missing = await h.cli("extensions", "show", "nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^ant0: extension\.not_found: /);
  });

  it("rm is refused while in use; --force reports the rewritten profiles", async () => {
    const refused = await h.cli("extensions", "rm", HELLO_ID);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/^ant0: extension\.in_use: /);

    const r = await h.cli("extensions", "rm", HELLO_ID, "--force");
    expect(r.code, r.stderr).toBe(0);
    expect(h.requests.at(-1)!.query.get("force")).toBe("true");
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      `removed ${HELLO_ID}`,
      "updated 1 profile(s)",
      `  ${PROFILE}`,
    ]);
    expect((await h.cli("--json", "extensions", "ls")).json()).toEqual({ items: [] });
  });
});
