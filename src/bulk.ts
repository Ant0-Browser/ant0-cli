/**
 * Multi-ref commands report the daemon's bulk envelopes. Existing operations use
 * `{ updated, errors: [{ id, error, message }] }`; endpoint-free bulk run uses `code` instead.
 * Successes are counted, every failure is printed on its own line, and any failure exits 1.
 */
import { isAnt0ApiError } from "./api/index.js";
import type { Context } from "./context.js";
import { CliError } from "./errors.js";

export interface BulkError {
  id: string;
  error: string;
  message: string;
}

export interface BulkResult {
  updated: number;
  errors: BulkError[];
}

/** The endpoint-free bulk-run route deliberately calls its failure field `code`. */
export interface CodedBulkResult {
  updated: number;
  errors: { id: string; code: string; message: string }[];
}

export const BULK_MAX_IDS = 50;

/** Drop repeated refs while keeping the order of first appearance. */
export function uniqueRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

/** Turn a thrown value into the per-id error shape (API errors keep their code). */
export function toBulkError(id: string, err: unknown): BulkError {
  if (isAnt0ApiError(err)) return { id, error: err.code, message: err.message };
  return { id, error: "error", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Run `fn` once per ref, sequentially (the daemon serializes launches anyway), and collect the
 * outcome. Used for routes that have no bulk twin (delete, restore).
 */
export async function forEachRef<T>(
  refs: readonly string[],
  fn: (ref: string) => Promise<T>,
): Promise<BulkResult & { results: T[] }> {
  const results: T[] = [];
  const errors: BulkError[] = [];
  for (const ref of refs) {
    try {
      results.push(await fn(ref));
    } catch (err) {
      errors.push(toBulkError(ref, err));
    }
  }
  return { updated: results.length, errors, results };
}

/** Human rendering: `<verb> N profile(s)` then one indented line per failure. */
export function bulkText(verb: string, result: BulkResult, extra: string[] = []): string {
  const lines = [`${verb} ${result.updated} profile(s)`, ...extra];
  if (result.errors.length > 0) lines.push(`failed ${result.errors.length}`);
  for (const e of result.errors) lines.push(`  ${e.id}: ${e.error}: ${e.message}`);
  return lines.join("\n");
}

/** Emit the result (verbatim with `--json`) and exit 1 when any id failed. */
export function finishBulk(
  ctx: Context,
  verb: string,
  result: BulkResult,
  extra: string[] = [],
): void {
  ctx.emit({ updated: result.updated, errors: result.errors }, () => bulkText(verb, result, extra));
  if (result.errors.length > 0) {
    throw new CliError(
      `${result.errors.length} of ${result.updated + result.errors.length} failed`,
    );
  }
}

/** Keep the new bulk-run wire envelope intact while retaining old `{ error }` bulk envelopes. */
export function finishCodedBulk(ctx: Context, verb: string, result: CodedBulkResult): void {
  ctx.emit(result, () => {
    const lines = [`${verb} ${result.updated} profile(s)`];
    if (result.errors.length > 0) lines.push(`failed ${result.errors.length}`);
    for (const e of result.errors) lines.push(`  ${e.id}: ${e.code}: ${e.message}`);
    return lines.join("\n");
  });
  if (result.errors.length > 0) {
    throw new CliError(
      `${result.errors.length} of ${result.updated + result.errors.length} failed`,
    );
  }
}
