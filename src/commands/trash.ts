/**
 * `ant0 trash ls [-q --group --tag --limit --offset] | empty [--yes]`.
 *
 * Trashed profiles keep everything (`GET /trash` lists them with `purge_at`); the daemon's sweeper
 * purges them after `trash_retention_days`. `empty` purges them all now, running ones excepted.
 */
import type { Command } from "commander";
import { unwrap } from "../api/index.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { table } from "../format.js";
import { SUMMARY_HEADERS, summaryRows } from "./profiles.js";

function positiveInt(flag: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0)
      throw new UsageError(`${flag} expects a non-negative integer`);
    return n;
  };
}

export function registerTrash(program: Command, ctx: Context): void {
  const trash = program
    .command("trash")
    .description("Profiles waiting in the trash (restore with `ant0 profiles restore`)");

  trash
    .command("ls")
    .description("List trashed profiles and when each will be purged")
    .option("-q, --query <text>", "filter by name substring")
    .option("--group <name>", "filter by group")
    .option("--tag <tag>", "filter by tag")
    .option("--limit <n>", "page size", positiveInt("--limit"))
    .option("--offset <n>", "page offset", positiveInt("--offset"))
    .action(
      async (opts: {
        query?: string;
        group?: string;
        tag?: string;
        limit?: number;
        offset?: number;
      }) => {
        const data = unwrap(
          await ctx.client().GET("/v1/trash", {
            params: {
              query: {
                ...(opts.query !== undefined ? { q: opts.query } : {}),
                ...(opts.group !== undefined ? { group: opts.group } : {}),
                ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
                ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
                ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
              },
            },
          }),
        );
        ctx.emit(data, () => {
          const body = table(
            [...SUMMARY_HEADERS, "deleted", "purge at"],
            data.items.map((p) => [...summaryRows([p])[0]!, p.deleted_at, p.purge_at]),
          );
          return data.items.length === 0
            ? body
            : `${body}\n(${data.total} trashed; kept ${data.trash_retention_days} day(s) after deletion)`;
        });
      },
    );

  trash
    .command("empty")
    .description("Permanently delete every trashed profile now (running ones are skipped)")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (opts: { yes?: boolean }) => {
      await ctx.confirm("permanently delete every profile in the trash?", opts.yes);
      const result = unwrap(await ctx.client().DELETE("/v1/trash"));
      ctx.emit(result, () => `purged ${result.purged} profile(s)`);
    });
}
