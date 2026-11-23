/**
 * `ant0 extensions ls | add <path> | show <id> | rm <id> [--force]`.
 *
 * The library keeps one unpacked copy per extension under `<home>/extensions/<id>/`; profiles
 * reference that folder in `launch.extensions`. `add` takes a folder, a `.zip` or a `.crx`; the
 * path is made absolute here because the daemon may run with another working directory.
 */
import { resolve } from "node:path";
import type { Command } from "commander";
import { unwrap, type components } from "../api/index.js";
import type { Context } from "../context.js";
import { flatten, formatBytes, keyValues, table } from "../format.js";

type Extension = components["schemas"]["Extension"];

const HEADERS = ["id", "name", "version", "mv", "size", "used by", "path"];

function extensionRows(items: Extension[]) {
  return items.map((e) => [
    e.id,
    e.name,
    e.version,
    e.manifest_version,
    formatBytes(e.size_bytes),
    e.used_by.length,
    e.path,
  ]);
}

/** `show`/`add` rendering: every field except the inline icon, which is not for a terminal. */
function extensionText(e: Extension & { existing?: boolean }): string {
  const { icon_data_url: _icon, ...rest } = e;
  return keyValues(flatten(rest));
}

export function registerExtensions(program: Command, ctx: Context): void {
  const extensions = program
    .command("extensions")
    .description("Extension library shared by profiles (unpacked folders under <home>/extensions)");

  extensions
    .command("ls")
    .description("List library extensions and how many profiles use each")
    .action(async () => {
      const data = unwrap(await ctx.client().GET("/v1/extensions"));
      ctx.emit(data, () => table(HEADERS, extensionRows(data.items)));
    });

  extensions
    .command("add <path>")
    .description("Add an unpacked extension folder, a .zip or a .crx to the library")
    .action(async (path: string) => {
      const added = unwrap(
        await ctx.client().POST("/v1/extensions", { body: { path: resolve(path) } }),
      );
      ctx.emit(added, () =>
        added.existing
          ? `already in the library as ${added.id}\n${extensionText(added)}`
          : extensionText(added),
      );
    });

  extensions
    .command("show <id>")
    .description("Show one library extension")
    .action(async (id: string) => {
      const data = unwrap(
        await ctx.client().GET("/v1/extensions/{id}", { params: { path: { id } } }),
      );
      ctx.emit(data, () => extensionText(data));
    });

  extensions
    .command("rm <id>")
    .description("Remove an extension from the library (refused while a profile uses it)")
    .option("--force", "also drop it from the launch.extensions of every profile using it")
    .action(async (id: string, opts: { force?: boolean }) => {
      const result = unwrap(
        await ctx.client().DELETE("/v1/extensions/{id}", {
          params: { path: { id }, query: opts.force ? { force: true } : {} },
        }),
      );
      ctx.emit(result, () => {
        const lines = [`removed ${result.id}`];
        if (result.updated_profiles.length > 0) {
          lines.push(`updated ${result.updated_profiles.length} profile(s)`);
          for (const p of result.updated_profiles) lines.push(`  ${p}`);
        }
        return lines.join("\n");
      });
    });
}
