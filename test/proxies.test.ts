import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { components } from "../src/api/index.js";
import { UUID_RE, proxyFixture, rows } from "./fixtures.js";
import { MockDaemon, apiError } from "./mock-daemon.js";

type Proxy = components["schemas"]["Proxy"];

let h: MockDaemon;
const store = new Map<string, Proxy>();
let next = 0;

beforeAll(async () => {
  h = await MockDaemon.start();
  h.on("GET", "/v1/proxies", (req) => {
    const q = req.query.get("q");
    const items = [...store.values()].filter(
      (p) => q === null || p.name.includes(q) || p.host.includes(q),
    );
    return { body: { items, total: items.length } };
  });
  h.on("POST", "/v1/proxies", (req) => {
    const body = req.body as Record<string, unknown>;
    const id = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    const proxy = proxyFixture(id, {
      name: String(body.name),
      type: body.type as Proxy["type"],
      host: String(body.host),
      port: Number(body.port),
      username: typeof body.username === "string" ? body.username : null,
      // The daemon stores the password and returns only a reference.
      password_ref: typeof body.password === "string" ? `secret:${id}` : null,
      change_ip_url: typeof body.change_ip_url === "string" ? body.change_ip_url : null,
    });
    store.set(id, proxy);
    return { status: 201, body: proxy };
  });
  h.on("GET", "/v1/proxies/:id", (req) => {
    const proxy = store.get(req.params.id!);
    return proxy ? { body: proxy } : apiError(404, "proxy.not_found", "no such proxy");
  });
  h.on("DELETE", "/v1/proxies/:id", (req) =>
    store.delete(req.params.id!) ? undefined : apiError(404, "proxy.not_found", "no such proxy"),
  );
  h.on("POST", "/v1/proxies/:id/check", (req) => {
    const proxy = store.get(req.params.id!);
    if (!proxy) return apiError(404, "proxy.not_found", "no such proxy");
    const check = {
      at: "2026-09-13T10:00:01.000Z",
      ok: proxy.host !== "dead.example",
      ip: "203.0.113.7",
      country: "DE",
      timezone: "Europe/Berlin",
      latency_ms: 42,
      error: null,
      udp: { ok: true, mapped_ip: null, same_ip: null, dns_ok: true, reason: null },
    };
    store.set(proxy.id, { ...proxy, last_check: check });
    return { body: check };
  });
  h.on("POST", "/v1/proxies/:id/change-ip", (req) => {
    const proxy = store.get(req.params.id!);
    if (!proxy) return apiError(404, "proxy.not_found", "no such proxy");
    if (!proxy.change_ip_url)
      return apiError(400, "validation_failed", "this proxy has no change_ip_url");
    return { body: { status: 200 } };
  });
});
afterAll(async () => {
  await h.close();
});

describe("ant0 proxies", () => {
  it("add accepts a provider line with --name and never echoes the password", async () => {
    const r = await h.cli("proxies", "add", "10.0.0.1:1080:alice:s3cret", "--name", "residential");
    expect(r.code, r.stderr).toBe(0);
    const kv = new Map(rows(r.stdout).map(([k, v]) => [k, v]));
    expect(kv.get("name")).toBe("residential");
    expect(kv.get("host")).toBe("10.0.0.1");
    expect(kv.get("port")).toBe("1080");
    expect(kv.get("username")).toBe("alice");
    expect(kv.get("password_ref")).toMatch(/^secret:/);
    expect(r.stdout).not.toContain("s3cret");
    // The CLI parsed the line itself and sent structured fields.
    expect(h.seen("POST", "/v1/proxies")[0]!.body).toMatchObject({
      type: "http",
      host: "10.0.0.1",
      port: 1080,
      username: "alice",
      password: "s3cret",
    });
  });

  it("add accepts a URL and defaults the name to host:port", async () => {
    const r = await h.cli("--json", "proxies", "add", "socks5://bob:pw@proxy.example:9050");
    expect(r.code, r.stderr).toBe(0);
    const p = r.json<Proxy>();
    expect(p).toMatchObject({
      name: "proxy.example:9050",
      type: "socks5",
      host: "proxy.example",
      port: 9050,
      username: "bob",
    });
    expect(p.id).toMatch(UUID_RE);
    expect(JSON.stringify(p)).not.toContain("pw");
  });

  it("add rejects an unparsable argument as a usage error before calling the daemon", async () => {
    const before = h.requests.length;
    const r = await h.cli("proxies", "add", "nonsense");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^ant0: invalid proxy: /);
    expect(h.requests).toHaveLength(before);
  });

  it("ls lists proxies in a table and verbatim with --json", async () => {
    const r = await h.cli("proxies", "ls");
    expect(r.code, r.stderr).toBe(0);
    const [header, ...body] = rows(r.stdout);
    expect(header).toEqual([
      "ID",
      "NAME",
      "TYPE",
      "HOST",
      "USER",
      "PROVIDER",
      "TAGS",
      "LAST CHECK",
    ]);
    expect(body.map((row) => row[1]).sort()).toEqual(["proxy.example:9050", "residential"]);

    const j = await h.cli("--json", "proxies", "ls");
    expect(j.json()).toEqual({ items: [...store.values()], total: 2 });
    const filtered = await h.cli("proxies", "ls", "-q", "resid");
    expect(h.requests.at(-1)!.query.get("q")).toBe("resid");
    expect(rows(filtered.stdout)).toHaveLength(2);
  });

  it("check prints the result and exits 1 when the check failed", async () => {
    const ok = await h.cli("proxies", "check", "residential");
    expect(ok.code, ok.stderr).toBe(0);
    const kv = new Map(rows(ok.stdout).map(([k, v]) => [k, v]));
    expect(kv.get("ok")).toBe("true");
    expect(kv.get("country")).toBe("DE");
    expect(kv.get("latency_ms")).toBe("42");

    await h.cli("proxies", "add", "http://dead.example:80", "--name", "dead");
    const bad = await h.cli("proxies", "check", "dead");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toBe("ant0: proxy check failed\n");
  });

  it("show/check/change-ip resolve an exact name to the id first", async () => {
    const residential = [...store.values()].find((p) => p.name === "residential")!;
    const show = await h.cli("--json", "proxies", "show", "residential");
    expect(show.code, show.stderr).toBe(0);
    expect(show.json<Proxy>().id).toBe(residential.id);
    expect(h.seen("GET", `/v1/proxies/${residential.id}`)).not.toHaveLength(0);
    expect(show.json<Proxy>().last_check).not.toBeNull();

    const noUrl = await h.cli("proxies", "change-ip", "residential");
    expect(noUrl.code).toBe(1);
    expect(noUrl.stderr).toMatch(/^ant0: validation_failed: .*change_ip_url/);

    await h.cli("proxies", "add", "http://rot.example:8080", "--name", "rotating");
    const rotating = [...store.values()].find((p) => p.name === "rotating")!;
    store.set(rotating.id, { ...rotating, change_ip_url: "http://rot.example/rotate" });
    const rotated = await h.cli("proxies", "change-ip", "rotating");
    expect(rotated.code, rotated.stderr).toBe(0);
    expect(rotated.stdout).toBe("provider answered HTTP 200\n");
    expect((await h.cli("proxies", "rm", "rotating")).code).toBe(0);
  });

  it("an unknown name is proxy.not_found and a shared name is proxy.ambiguous_name with the ids", async () => {
    const missing = await h.cli("proxies", "check", "nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('ant0: proxy.not_found: no proxy named "nope"\n');

    const a = await h.cli("--json", "proxies", "add", "http://a.example:1", "--name", "twin");
    const b = await h.cli("--json", "proxies", "add", "http://b.example:2", "--name", "twin");
    const ids = [a.json<Proxy>().id, b.json<Proxy>().id];
    const dup = await h.cli("proxies", "rm", "twin");
    expect(dup.code).toBe(1);
    expect(dup.stderr).toMatch(
      /^ant0: proxy\.ambiguous_name: 2 proxies are named "twin"; use the id: /,
    );
    for (const id of ids) expect(dup.stderr).toContain(id);
    for (const id of ids) expect((await h.cli("proxies", "rm", id)).code).toBe(0);
  });

  it("rm deletes; a second rm is proxy.not_found", async () => {
    const id = [...store.keys()][0]!;
    const r = await h.cli("proxies", "rm", id);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`removed ${id}\n`);
    const again = await h.cli("proxies", "rm", id);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/^ant0: proxy\.not_found: /);
  });
});
