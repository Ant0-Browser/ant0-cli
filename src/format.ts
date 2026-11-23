/**
 * Human output helpers: aligned columns, key/value listings and a generic flattener for API
 * documents. No colors, no terminal tricks; output is stable enough to grep.
 */

export type Cell = string | number | boolean | null | undefined;

/** Render one cell: `-` for null/undefined, `true`/`false` for booleans. */
export function cell(value: Cell): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  return String(value);
}

/**
 * Aligned columns separated by two spaces, header in upper case, no trailing whitespace.
 * With no rows only the header line is printed.
 */
export function table(headers: string[], rows: Cell[][]): string {
  const text = [headers.map((h) => h.toUpperCase()), ...rows.map((r) => r.map(cell))];
  const widths = headers.map((_, i) => Math.max(...text.map((row) => (row[i] ?? "").length)));
  return text
    .map((row) =>
      row
        .map((v, i) => (i === row.length - 1 ? v : v.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** `key   value` lines with keys padded to the longest key. */
export function keyValues(pairs: [string, Cell][]): string {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${cell(v)}`.trimEnd()).join("\n");
}

/**
 * Flatten a JSON document into dotted-path/value pairs for `show`-style commands. Arrays of
 * scalars become comma-separated lists; other arrays and empty containers are shown as JSON.
 */
export function flatten(value: unknown, prefix = ""): [string, Cell][] {
  if (value === null || typeof value !== "object") {
    return [[prefix || "value", value as Cell]];
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) {
      return [[prefix, value.length === 0 ? "[]" : value.map((v) => cell(v as Cell)).join(", ")]];
    }
    return [[prefix, JSON.stringify(value)]];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [[prefix, "{}"]];
  const out: [string, Cell][] = [];
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push(...flatten(v, key));
  }
  return out;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}
