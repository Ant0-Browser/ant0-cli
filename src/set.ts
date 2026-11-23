/**
 * `--set key=value` parsing for `ant0 profiles edit`.
 *
 * Keys are dotted paths into the PATCH body (`network.geo.timezone`). Values: `true`/`false`,
 * `null`, numbers, comma lists (`tags=a,b`), and JSON when the value starts with `[`, `{` or `"`
 * (the way to force a string containing commas or digits: `--set 'notes="1,2"'`). Paths known to
 * hold arrays are always sent as arrays, so `--set tags=a` yields `["a"]`.
 */
import { UsageError } from "./errors.js";

const KEY_RE = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/;

/** Manifest paths whose value is a list (the profile manifest). */
export const ARRAY_PATHS: ReadonlySet<string> = new Set([
  "tags",
  "network.geo.languages",
  "launch.start_urls",
  "launch.extensions",
  "launch.extra_args",
]);

export type Scalar = string | number | boolean | null;

export function parseScalar(raw: string): Scalar {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

export function parseSetValue(raw: string, path: string): unknown {
  const text = raw.trim();
  if (text.startsWith("[") || text.startsWith("{") || text.startsWith('"')) {
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new UsageError(`--set ${path}: invalid JSON value (${(err as Error).message})`);
    }
  }
  if (ARRAY_PATHS.has(path)) {
    if (text === "") return [];
    return text.split(",").map((part) => parseScalar(part));
  }
  if (text.includes(",")) return text.split(",").map((part) => parseScalar(part));
  return parseScalar(text);
}

/** Parse one `key=value` pair. */
export function parseSetPair(item: string): { path: string; value: unknown } {
  const eq = item.indexOf("=");
  if (eq <= 0) throw new UsageError(`--set expects key=value, got "${item}"`);
  const path = item.slice(0, eq).trim();
  if (!KEY_RE.test(path)) throw new UsageError(`--set: invalid key "${path}"`);
  return { path, value: parseSetValue(item.slice(eq + 1), path) };
}

/** Assign `value` at the dotted `path` inside `target`, creating intermediate objects. */
export function assignPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = node[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[parts[parts.length - 1]!] = value;
}

/** Build the PATCH body from every `--set` argument. */
export function parseSetArgs(items: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const item of items) {
    const { path, value } = parseSetPair(item);
    assignPath(body, path, value);
  }
  return body;
}
