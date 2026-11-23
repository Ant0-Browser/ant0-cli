import { Ant0ApiError, isAnt0ApiError, type components, type ProfileSummary } from "./api/index.js";
import { CliError, isConnectionRefused } from "./errors.js";

type Lifecycle = components["schemas"]["Lifecycle"];
type ProxyInventory = components["schemas"]["ProxyInventory"];
type ProfileInventory = components["schemas"]["ProfileInventory"];

const invalid = () => new CliError("invalid inventory response");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length > max) throw invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw invalid();
  return value as T;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))
    throw invalid();
  return result;
}
function folderUuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result))
    throw invalid();
  return result;
}
function date(value: unknown): string {
  const result = text(value, 40);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(`${result.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== result.slice(0, 10)
  )
    throw invalid();
  return result;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
  return value;
}
function count(value: unknown): number {
  const result = finite(value);
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

function summary(value: unknown): ProfileSummary {
  const p = object(value);
  if (!Array.isArray(p.tags) || p.tags.length > 1000) throw invalid();
  // Explicit copies keep future or unexpected secret fields out of JSON and table output.
  return {
    id: uuid(p.id),
    name: text(p.name),
    group: nullable(p.group, text),
    local_folder_id: nullable(p.local_folder_id, folderUuid),
    tags: p.tags.map((tag) => text(tag, 128)),
    notes: text(p.notes, 16000),
    status: nullable(p.status, text),
    pinned: bool(p.pinned),
    platform: nullable(p.platform, (v) => oneOf(v, ["windows", "linux", "macos", "android"])),
    proxy_id: nullable(p.proxy_id, uuid),
    browser_version: nullable(p.browser_version, text),
    identity_mode: oneOf(p.identity_mode, ["synthetic", "captured", "native"]),
    created_at: date(p.created_at),
    updated_at: date(p.updated_at),
    last_launched_at: nullable(p.last_launched_at, date),
    deleted_at: nullable(p.deleted_at, date),
  };
}
function lifecycle(value: unknown): Lifecycle {
  const p = object(value);
  const result: Lifecycle = {
    profile_id: uuid(p.profile_id),
    state: oneOf(p.state, ["starting", "running", "stopping", "stopped", "crashed"]),
    started_at: nullable(p.started_at, date),
    browser_version: nullable(p.browser_version, text),
    headless: nullable(p.headless, bool),
  };
  const fields = [result.started_at, result.browser_version, result.headless];
  if (
    !fields.every((field) => field !== null) &&
    !(result.state !== "running" && fields.every((field) => field === null))
  )
    throw invalid();
  return result;
}
function proxy(value: unknown): ProxyInventory {
  const p = object(value);
  return {
    id: uuid(p.id),
    type: oneOf(p.type, ["http", "https", "socks5", "socks4"]),
    last_check: nullable(p.last_check, (value) => {
      const check = object(value);
      return {
        ok: bool(check.ok),
        country: nullable(check.country, text),
        latency_ms: nullable(check.latency_ms, finite),
        at: date(check.at),
      };
    }),
  };
}
export function projectProfileInventory(value: unknown, readOnly = false): ProfileInventory {
  const item = object(value);
  const permissions = object(item.permissions);
  const result: ProfileInventory = {
    profile: summary(item.profile),
    lifecycle: lifecycle(item.lifecycle),
    proxy: nullable(item.proxy, proxy),
    permissions: { edit: bool(permissions.edit), cdp: bool(permissions.cdp) },
    // Absent on a daemon that does not report a per-row status: treat as ok.
    authority: item.authority === undefined ? "ok" : oneOf(item.authority, ["ok", "needs_review"]),
    authority_reason:
      item.authority_reason === undefined
        ? null
        : nullable(item.authority_reason, (value) =>
            oneOf(value, ["legacy_unclassified", "restricted_origin_missing"]),
          ),
  };
  if (
    (readOnly && (result.permissions.edit || result.permissions.cdp)) ||
    result.profile.id !== result.lifecycle.profile_id ||
    (result.proxy !== null && result.proxy.id !== result.profile.proxy_id)
  )
    throw invalid();
  return result;
}
export function projectProfileList(
  value: unknown,
  limit = 100,
  offset = 0,
  running?: boolean,
  readOnly = false,
) {
  const list = object(value);
  const total = count(list.total);
  if (
    !Array.isArray(list.items) ||
    list.items.length > 1000 ||
    list.items.length !== Math.min(limit, Math.max(0, total - offset))
  )
    throw invalid();
  const items = list.items.map((item) => projectProfileInventory(item, readOnly));
  if (
    new Set(items.map((item) => item.profile.id)).size !== items.length ||
    items.some((item) => running !== undefined && (item.lifecycle.state === "running") !== running)
  )
    throw invalid();
  const result = { items: items.map((item) => item.profile), total };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
    throw new CliError("inventory result exceeds limit; request fewer items");
  return result;
}
export function projectProfileStatus(value: unknown, ref: string, readOnly = false) {
  const item = projectProfileInventory(value, readOnly);
  if (item.profile.id.toLowerCase() !== ref.toLowerCase() && item.profile.name !== ref)
    throw invalid();
  const s = item.lifecycle;
  return {
    state: s.state,
    session:
      s.started_at === null
        ? null
        : {
            profile_id: s.profile_id,
            started_at: s.started_at,
            browser_version: s.browser_version,
            headless: s.headless,
          },
  };
}

export function projectProxyList(value: unknown, limit: number, offset: number) {
  const list = object(value);
  const total = count(list.total);
  if (
    !Array.isArray(list.items) ||
    list.items.length !== Math.min(limit, Math.max(0, total - offset))
  )
    throw invalid();
  const items = list.items.map(proxy);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw invalid();
  return { items, total };
}

/** Keep API error identity/status while rejecting raw upstream diagnostics on metadata reads. */
export async function inventoryRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isAnt0ApiError(error)) {
      const known = [
        "profile.not_found",
        "team.forbidden",
        "sync.store_unavailable",
        "sync.conflict",
        "sync.offline",
        "sync.unauthorized",
        "unauthorized",
        "forbidden",
        "validation_failed",
      ];
      throw new Ant0ApiError(
        error.status,
        known.includes(error.code) ? error.code : `http_${error.status}`,
        "inventory unavailable",
      );
    }
    if (error instanceof CliError || isConnectionRefused(error)) throw error;
    throw new CliError("inventory unavailable");
  }
}
