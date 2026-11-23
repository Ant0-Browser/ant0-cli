import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { components } from "../src/api/index.js";
import { rows } from "./fixtures.js";
import { MockDaemon, apiError } from "./mock-daemon.js";

type InstalledBrowser = components["schemas"]["InstalledBrowser"];

const V153 = "153.0.7900.10-ant0.1";
const V154 = "154.0.7960.22-ant0.1";
const TAMPERED = "chrome.dll";
const JOB = "00000000-0000-4000-8000-000000000001";

function release(
  version: string,
  installed_at: string,
  over: Partial<InstalledBrowser> = {},
): InstalledBrowser {
  return {
    version,
    chromium: version.split("-")[0]!,
    target: "linux-x64",
    path: `/home/browsers/${version}`,
    executable: `/home/browsers/${version}/browser`,
    installed_at,
    size_bytes: 1_048_576,
    default: false,
    ...over,
  } satisfies InstalledBrowser;
}

const integrity = (status: "ok" | "failed" | "unchecked", path?: string) =>
  ({
    status,
    checked_at: "2026-09-13T10:00:00.000Z",
    message: status === "failed" ? "a file was changed" : status,
    ...(path ? { path } : {}),
  }) as InstalledBrowser["integrity"];

let h: MockDaemon;
let items: InstalledBrowser[];

beforeAll(async () => {
  h = await MockDaemon.start();
  items = [
    release(V154, "2026-02-01T00:00:00.000Z", { default: true }),
    release(V153, "2026-01-01T00:00:00.000Z"),
  ];
  h.on("GET", "/v1/browsers", () => ({ body: { items } }));
  h.on("PUT", "/v1/browsers/default", (req) => {
    const version = (req.body as { version: string }).version;
    if (!items.some((b) => b.version === version))
      return apiError(404, "browser.not_found", `${version} is not installed`);
    items = items.map((b) => ({ ...b, default: b.version === version }));
    return { body: { items } };
  });
  h.on("POST", "/v1/browsers/install", () => ({ status: 202, body: { job_id: JOB } }));
});
afterAll(async () => {
  await h.close();
});

function defaults(text: string): [string, string][] {
  const [, ...body] = rows(text);
  return body.map((row) => [row[0]!, row[1]!]);
}

describe("ant0 browsers", () => {
  it("ls asks for the integrity check and marks the default", async () => {
    const r = await h.cli("browsers", "ls");
    expect(r.code, r.stderr).toBe(0);
    expect(h.requests.at(-1)!.query.get("integrity")).toBe("true");
    expect(rows(r.stdout)[0]).toEqual([
      "VERSION",
      "DEFAULT",
      "CHROMIUM",
      "TARGET",
      "SIZE",
      "INSTALLED",
      "STATUS",
      "PATH",
    ]);
    expect(defaults(r.stdout)).toEqual([
      [V154, "*"],
      [V153, "-"],
    ]);
  });

  it("default <version> sends the choice and prints the updated list", async () => {
    const r = await h.cli("browsers", "default", V153);
    expect(r.code, r.stderr).toBe(0);
    expect(h.seen("PUT", "/v1/browsers/default")[0]!.body).toEqual({ version: V153 });
    expect(defaults(r.stdout)).toEqual([
      [V154, "-"],
      [V153, "*"],
    ]);
    const j = await h.cli("--json", "browsers", "ls");
    const shown = j.json<{ items: InstalledBrowser[] }>().items;
    expect(shown.filter((b) => b.default).map((b) => b.version)).toEqual([V153]);

    const missing = await h.cli("browsers", "default", "150.0.0.0-ant0.9");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^ant0: browser\.not_found: /);
  });
});

describe("ant0 browsers ls integrity column", () => {
  it("shows ok for an intact engine and unchecked for one without a signed proof", async () => {
    items = [
      release(V154, "2026-02-01T00:00:00.000Z", { default: true, integrity: integrity("ok") }),
      release(V153, "2026-01-01T00:00:00.000Z", { integrity: integrity("unchecked") }),
    ];
    const r = await h.cli("browsers", "ls");
    const byVersion = new Map(
      rows(r.stdout)
        .slice(1)
        .map((row) => [row[0]!, row[6]!]),
    );
    expect(byVersion.get(V154)).toBe("ok");
    expect(byVersion.get(V153)).toBe("unchecked");
    expect(r.stdout).not.toContain("failed its integrity check");
  });

  it("flags the release and the file, and says to reinstall that version", async () => {
    items = [
      release(V154, "2026-02-01T00:00:00.000Z", {
        default: true,
        integrity: integrity("failed", TAMPERED),
      }),
      release(V153, "2026-01-01T00:00:00.000Z", { integrity: integrity("ok") }),
    ];
    const r = await h.cli("browsers", "ls");
    expect(r.code, r.stderr).toBe(0);
    const byVersion = new Map(
      rows(r.stdout)
        .slice(1)
        .map((row) => [row[0]!, row[6]!]),
    );
    expect(byVersion.get(V154)).toBe(`FAILED ${TAMPERED}`);
    expect(r.stdout).toContain(`${V154} failed its integrity check`);
    expect(r.stdout).toContain(
      `ant0 browsers rm ${V154} && ant0 browsers install --release ${V154}, ` +
        `then set it as the default again: ant0 browsers default ${V154}`,
    );
    expect(r.stdout).not.toContain("install_engine");

    const j = await h.cli("--json", "browsers", "ls");
    const item = j.json<{ items: InstalledBrowser[] }>().items.find((b) => b.version === V154);
    expect(item?.integrity).toMatchObject({ status: "failed", path: TAMPERED });
  });
});

describe("ant0 browsers install --replace", () => {
  it("sends replace: true (a plain install does not)", async () => {
    const before = h.seen("POST", "/v1/browsers/install").length;
    await h.cli("browsers", "install", "--release", V154, "--replace", "--no-wait");
    await h.cli("browsers", "install", "--release", V154, "--no-wait");
    const [withReplace, plain] = h.seen("POST", "/v1/browsers/install").slice(before);
    expect(withReplace!.body).toMatchObject({ version: V154, replace: true });
    expect(plain!.body).not.toHaveProperty("replace");
  });

  it("needs an exact release and refuses --repair-proof together", async () => {
    const a = await h.cli("browsers", "install", "--replace");
    expect(a.code).toBe(1);
    expect(a.stderr).toContain("--replace needs an exact --release");
    const b = await h.cli("browsers", "install", "--release", V154, "--replace", "--repair-proof");
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("cannot be used together");
  });

  it("says clearly what to do when the daemon is too old for it", async () => {
    const old = await MockDaemon.start();
    try {
      old.on("POST", "/v1/browsers/install", () =>
        apiError(400, "validation_failed", "body must NOT have additional properties"),
      );
      const r = await old.cli("browsers", "install", "--release", V154, "--replace");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("does not support --replace");
      expect(r.stderr).toContain(
        `ant0 browsers rm ${V154} && ant0 browsers install --release ${V154}`,
      );
    } finally {
      await old.close();
    }
  });
});
