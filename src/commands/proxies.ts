/**
 * `ant0 proxies ls [-q --tag] | add <url|line> [--name] | show|check|change-ip|rm <ref>`.
 *
 * `add` parses the argument locally with `@ant0/schemas` (`parseProxyLine` accepts both
 * `scheme://user:pass@host:port` and provider lines such as `host:port:user:pass`) so `--name`
 * can travel in the same request; the password is sent plaintext once and stored as a secret ref.
 *
 * `<ref>` is the proxy UUID or its exact name. The `/v1/proxies/{id}` routes only take UUIDs, so
 * the CLI resolves a name through `GET /v1/proxies` first (`resolveProxyId`), the way the daemon
 * resolves profile names for `ant0 profiles …`: exactly one live proxy must carry the name.
 */
import type { Command } from "commander";
import { formatHostPort, parseProxyLine } from "../shared/proxy-parse.js";
import { unwrap, type Proxy, type ProxyCheck, type ProxyCreate } from "../api/index.js";
import type { Context } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { flatten, keyValues, table } from "../format.js";
import { inventoryRead, projectProxyList } from "../inventory.js";

function checkSummary(c: ProxyCheck): string | null {
  if (!c) return null;
  if (!c.ok) return `fail${c.error ? `: ${c.error}` : ""}`;
  return ["ok", c.ip, c.country, c.latency_ms !== null ? `${c.latency_ms}ms` : null]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

function proxyRows(items: Proxy[]) {
  return items.map((p) => [
    p.id,
    p.name,
    p.type,
    formatHostPort(p.host, p.port),
    p.username,
    p.provider,
    p.tags.length ? p.tags.join(",") : null,
    checkSummary(p.last_check),
  ]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The UUID for a `<ref>`: a UUID passes through untouched; anything else must be the exact name
 * of one proxy. Errors mirror the daemon's profile resolution codes: `proxy.not_found` (exit 1)
 * and `proxy.ambiguous_name` listing the candidate ids.
 */
export async function resolveProxyId(ctx: Context, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const data = unwrap(await ctx.client().GET("/v1/proxies", { params: { query: { q: ref } } }));
  const matches = data.items.filter((p) => p.name === ref);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) {
    throw new CliError(`proxy.not_found: no proxy named ${JSON.stringify(ref)}`);
  }
  throw new CliError(
    `proxy.ambiguous_name: ${matches.length} proxies are named ${JSON.stringify(ref)}; use the id: ` +
      matches.map((p) => p.id).join(", "),
  );
}

export function parseProxyArg(value: string, name: string | undefined): ProxyCreate {
  let parsed: ReturnType<typeof parseProxyLine>;
  try {
    parsed = parseProxyLine(value);
  } catch (err) {
    throw new UsageError(`invalid proxy: ${(err as Error).message}`);
  }
  const body: ProxyCreate = { type: parsed.type, host: parsed.host, port: parsed.port };
  body.name = name ?? parsed.name;
  if (parsed.username !== undefined) body.username = parsed.username;
  if (parsed.password !== undefined) body.password = parsed.password;
  if (parsed.change_ip_url !== undefined) body.change_ip_url = parsed.change_ip_url;
  if (parsed.session_pattern !== undefined) body.session_pattern = parsed.session_pattern;
  if (parsed.provider !== undefined) body.provider = parsed.provider;
  if (parsed.udp !== undefined) body.udp = parsed.udp;
  if (parsed.tags !== undefined) body.tags = parsed.tags;
  if (parsed.notes !== undefined) body.notes = parsed.notes;
  return body;
}

export function registerProxies(program: Command, ctx: Context): void {
  const proxies = program.command("proxies").description("Shared proxy objects");

  proxies
    .command("ls")
    .description("List proxies")
    .option("-q, --query <text>", "filter by name/host substring")
    .option("--tag <tag>", "filter by tag")
    .option("--limit <n>", "inventory page size in credential-file mode", (v) => Number(v), 100)
    .option("--offset <n>", "inventory page offset in credential-file mode", (v) => Number(v), 0)
    .action(async (opts: { query?: string; tag?: string; limit: number; offset: number }) => {
      if (ctx.keyMode()) {
        if (opts.query !== undefined || opts.tag !== undefined)
          throw new UsageError("key proxy inventory does not support name or tag filters");
        if (
          !Number.isInteger(opts.limit) ||
          opts.limit < 1 ||
          opts.limit > 100 ||
          !Number.isSafeInteger(opts.offset) ||
          opts.offset < 0
        )
          throw new UsageError("inventory requires limit 1–100 and non-negative offset");
        const client = ctx.client();
        const data = await inventoryRead(async () =>
          projectProxyList(
            unwrap(
              await client.GET("/v1/inventory/proxies", {
                params: { query: { limit: opts.limit, offset: opts.offset } },
              }),
            ),
            opts.limit,
            opts.offset,
          ),
        );
        ctx.emit(data, () =>
          table(
            ["id", "type", "ok", "country", "latency_ms"],
            data.items.map((p) => [
              p.id,
              p.type,
              p.last_check?.ok,
              p.last_check?.country,
              p.last_check?.latency_ms,
            ]),
          ),
        );
        return;
      }
      const data = unwrap(
        await ctx.client().GET("/v1/proxies", {
          params: {
            query: {
              ...(opts.query !== undefined ? { q: opts.query } : {}),
              ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
            },
          },
        }),
      );
      ctx.emit(data, () =>
        table(
          ["id", "name", "type", "host", "user", "provider", "tags", "last check"],
          proxyRows(data.items),
        ),
      );
    });

  proxies
    .command("add <proxy>")
    .description("Add a proxy from scheme://user:pass@host:port or host:port:user:pass")
    .option("--name <name>", "display name (default host:port)")
    .action(async (value: string, opts: { name?: string }) => {
      const body = parseProxyArg(value, opts.name);
      const created = unwrap(await ctx.client().POST("/v1/proxies", { body }));
      ctx.emit(created, () => keyValues(flatten(created)));
    });

  proxies
    .command("show <ref>")
    .description("Show one proxy (UUID or exact name)")
    .action(async (ref: string) => {
      const id = await resolveProxyId(ctx, ref);
      const proxy = unwrap(
        await ctx.client().GET("/v1/proxies/{id}", { params: { path: { id } } }),
      );
      ctx.emit(proxy, () => keyValues(flatten(proxy)));
    });

  proxies
    .command("check <ref>")
    .description("Connect through the proxy and report exit IP, country and latency")
    .action(async (ref: string) => {
      const id = await resolveProxyId(ctx, ref);
      const result = unwrap(
        await ctx.client().POST("/v1/proxies/{id}/check", { params: { path: { id } } }),
      );
      ctx.emit(result, () =>
        result
          ? keyValues([
              ["ok", result.ok],
              ["ip", result.ip],
              ["country", result.country],
              ["timezone", result.timezone],
              ["latency_ms", result.latency_ms],
              ["error", result.error],
              ["at", result.at],
            ])
          : "no result",
      );
      if (!result || !result.ok) throw new CliError("proxy check failed", 1);
    });

  proxies
    .command("change-ip <ref>")
    .description("Ask the provider for a new exit IP (GETs the proxy's change_ip_url)")
    .action(async (ref: string) => {
      const id = await resolveProxyId(ctx, ref);
      const result = unwrap(
        await ctx.client().POST("/v1/proxies/{id}/change-ip", { params: { path: { id } } }),
      );
      ctx.emit(result, () => `provider answered HTTP ${result.status}`);
    });

  proxies
    .command("rm <ref>")
    .description("Delete a proxy (refused while a profile references it)")
    .action(async (ref: string) => {
      const id = await resolveProxyId(ctx, ref);
      unwrap(await ctx.client().DELETE("/v1/proxies/{id}", { params: { path: { id } } }));
      ctx.emit(undefined, () => `removed ${id}`);
    });
}
