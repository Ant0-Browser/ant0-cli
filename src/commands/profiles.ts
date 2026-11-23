/**
 * `ant0 profiles ...`:
 *
 *   ls [--group --tag -q --running --trashed --limit --offset] | create <name> [...]
 *   show <id|name> | edit <id> --set key=value...
 *   set <ref...> [--group|--no-group] [--tag-add]* [--tag-remove]* [--pin|--no-pin]
 *   rm <ref...> [--permanent | --cloud] [--yes] | restore <ref...>
 *   run <id|name> [--timeout] [--conflict-profile-id] | start <ref...> [--headless]
 *   stop <ref...> [--force] | status <id|name> | identity <id> | promote <id> --folder-id ...
 *   cookies import <id> <file> | cookies export <id> [--format] [-o file] | bulk <file.csv>
 *
 * `:id`/`<ref>` parameters accept the UUID or the exact profile name (the daemon resolves both).
 * Commands that take several refs use the daemon's bulk routes when they exist (start, stop,
 * set) and loop otherwise (rm, restore); either way they print one line per failed id and exit 1
 * when anything failed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parseProxyLine } from "../shared/proxy-parse.js";
import {
  isAnt0ApiError,
  unwrap,
  type ProfileCreate,
  type ProfileInput,
  type ProfileManifest,
  type ProfileSummary,
  type Session,
  type paths,
} from "../api/index.js";
import { BULK_MAX_IDS, finishBulk, finishCodedBulk, forEachRef, uniqueRefs } from "../bulk.js";
import type { Context } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { flatten, keyValues, table } from "../format.js";
import { parseSetArgs } from "../set.js";
import { inventoryRead, projectProfileList, projectProfileStatus } from "../inventory.js";
import type { KeyScope } from "@ant0/mcp/credentials";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveInt(flag: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0)
      throw new UsageError(`${flag} expects a non-negative integer`);
    return n;
  };
}

function boundedInt(flag: string, minimum: number, maximum: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < minimum || n > maximum) {
      throw new UsageError(`${flag} expects an integer from ${minimum} to ${maximum}`);
    }
    return n;
  };
}

function uuid(flag: string) {
  return (value: string): string => {
    if (!UUID_RE.test(value)) throw new UsageError(`${flag} expects a UUID`);
    return value;
  };
}

function folderId(value: string): string | null {
  if (value === "null") return null;
  if (!UUID_RE.test(value)) throw new UsageError("--folder-id expects a UUID or null");
  return value;
}

export const SUMMARY_HEADERS = [
  "id",
  "name",
  "group",
  "tags",
  "platform",
  "status",
  "pinned",
  "identity",
  "proxy",
  "browser",
];

export function summaryRows(items: ProfileSummary[]) {
  return items.map((p) => [
    p.id,
    p.name,
    p.group,
    p.tags.length ? p.tags.join(",") : null,
    p.platform,
    p.status,
    p.pinned,
    p.identity_mode,
    p.proxy_id,
    p.browser_version,
  ]);
}

function refsOrUsage(refs: string[], command: string): string[] {
  const unique = uniqueRefs(refs);
  if (unique.length > BULK_MAX_IDS) {
    throw new UsageError(`${command} accepts at most ${BULK_MAX_IDS} profiles per call`);
  }
  return unique;
}

interface SetOptions {
  /** `--group <name>` = string, `--no-group` = false, absent = undefined. */
  group?: string | false;
  tagAdd: string[];
  tagRemove: string[];
  /** `--pin` = true, `--no-pin` = false. */
  pin?: boolean;
  /** `--proxy <id>` = proxy id, `--no-proxy` = false (direct connection). */
  proxy?: string | false;
  /** `--status <text>` = status, `--no-status` = false (clear). */
  status?: string | false;
  webrtc?: string;
}

const WEBRTC_MODES = ["proxy-only", "disabled", "host"] as const;

type BulkPatch = NonNullable<
  paths["/v1/profiles/bulk-update"]["post"]["requestBody"]
>["content"]["application/json"]["patch"];

/** `profiles set` flags -> `patch` of `POST /profiles/bulk-update`; empty patch is a usage error. */
export function setPatch(opts: SetOptions): BulkPatch {
  const patch: BulkPatch = {};
  if (opts.group === false) patch.group = null;
  else if (typeof opts.group === "string") patch.group = opts.group;
  if (opts.tagAdd.length > 0) patch.tags_add = opts.tagAdd;
  if (opts.tagRemove.length > 0) patch.tags_remove = opts.tagRemove;
  if (opts.pin !== undefined) patch.pinned = opts.pin;
  if (opts.status === false) patch.status = null;
  else if (typeof opts.status === "string") patch.status = opts.status;
  if (opts.proxy === false) patch.proxy_id = null;
  else if (typeof opts.proxy === "string") {
    if (!UUID_RE.test(opts.proxy)) {
      throw new UsageError("--proxy takes a saved proxy id (see `ant0 proxies ls`)");
    }
    patch.proxy_id = opts.proxy;
  }
  if (opts.webrtc !== undefined) {
    const mode = WEBRTC_MODES.find((m) => m === opts.webrtc);
    if (mode === undefined) {
      throw new UsageError(`--webrtc must be one of ${WEBRTC_MODES.join(", ")}`);
    }
    patch.webrtc = mode;
  }
  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      "set needs at least one of --group, --no-group, --tag-add, --tag-remove, --pin, --no-pin, " +
        "--status, --no-status, --proxy, --no-proxy, --webrtc",
    );
  }
  return patch;
}

/** `--proxy <id|url|line>` -> `network` fragment of a create/patch body. */
export function proxyNetwork(value: string): NonNullable<ProfileCreate["network"]> {
  if (UUID_RE.test(value)) return { proxy_id: value };
  try {
    parseProxyLine(value); // early, local validation with a precise message
  } catch (err) {
    throw new UsageError(`--proxy: ${(err as Error).message}`);
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
    ? { proxy: { url: value } }
    : { proxy: { line: value } };
}

interface CreateOptions {
  proxy?: string;
  group?: string;
  tag: string[];
  startUrl: string[];
  pin?: boolean;
  headless?: boolean;
  notes?: string;
}

export function createBody(name: string, opts: CreateOptions): ProfileCreate {
  const body: ProfileCreate = { name };
  if (opts.group !== undefined) body.group = opts.group;
  if (opts.tag.length > 0) body.tags = opts.tag;
  if (opts.notes !== undefined) body.notes = opts.notes;
  if (opts.pin) body.pinned = true;
  if (opts.startUrl.length > 0 || opts.headless) {
    body.launch = {
      ...(opts.startUrl.length > 0 ? { start_urls: opts.startUrl } : {}),
      ...(opts.headless ? { headless: true } : {}),
    };
  }
  if (opts.proxy !== undefined) body.network = proxyNetwork(opts.proxy);
  return body;
}

function manifestText(m: ProfileManifest | Record<string, unknown>): string {
  return keyValues(flatten(m));
}

function sessionText(s: Session): string {
  return keyValues([
    ["ws_endpoint", s.ws_endpoint],
    ["debug_port", s.debug_port],
    ["pid", s.pid],
    ["cdp_http", s.cdp_http],
    ["browser_version", s.browser_version],
    ["headless", s.headless],
    ["started_at", s.started_at],
  ]);
}

type RunResult =
  paths["/v1/profiles/{id}/run"]["post"]["responses"][200]["content"]["application/json"];
type Lifecycle =
  paths["/v1/profiles/{id}/run"]["get"]["responses"][200]["content"]["application/json"];

function runResultText(result: RunResult): string {
  return keyValues([
    ["requested_profile_id", result.requested_profile_id],
    ["profile_id", result.profile_id],
    ["redirected", result.redirected],
    ["state", result.lifecycle.state],
    ["started_at", result.lifecycle.started_at],
    ["browser_version", result.lifecycle.browser_version],
    ["headless", result.lifecycle.headless],
  ]);
}

/** A run may have spawned before a late delivery failure. Inspect once; never replay it. */
async function inspectFailedRun(ctx: Context, id: string, error: unknown): Promise<void> {
  if (isAnt0ApiError(error) && !error.message.includes("inspect lifecycle before retrying")) return;
  let lifecycle: Lifecycle | undefined;
  try {
    lifecycle = unwrap(
      await ctx.client().GET("/v1/profiles/{id}/run", { params: { path: { id } } }),
    );
  } catch {
    // The original failure remains authoritative. Do not turn inspection into a retry.
  }
  ctx.err(
    lifecycle
      ? `run outcome was not confirmed; ${lifecycle.profile_id} is ${lifecycle.state}. Inspect status before retrying`
      : `run outcome was not confirmed; inspect with \`ant0 profiles status ${id}\` before retrying`,
  );
}

/** Offer only what the private key actually carries; the daemon and cloud still decide. */
async function requireCredentialScopes(ctx: Context, ...required: KeyScope[]): Promise<void> {
  const grant = await ctx.keyGrant();
  if (!grant) return;
  const missing = required.filter((scope) => !grant.scopes.includes(scope));
  if (missing.length > 0)
    throw new CliError(
      `${ctx.globals.credentialFile !== undefined ? "credential file" : "API key"} does not grant ${missing.join(" and ")}`,
    );
}

export function registerProfiles(program: Command, ctx: Context): void {
  const profiles = program.command("profiles").description("Browser profiles");

  profiles
    .command("ls")
    .description("List profiles")
    .option("-q, --query <text>", "filter by name substring")
    .option("--group <name>", "filter by group")
    .option("--tag <tag>", "filter by tag")
    .option("--running", "only profiles whose browser is running (filtered before pagination)")
    .option("--trashed", "list the trash instead of live profiles (same as `ant0 trash ls`)")
    .option("--limit <n>", "page size", positiveInt("--limit"))
    .option("--offset <n>", "page offset", positiveInt("--offset"))
    .action(
      async (opts: {
        query?: string;
        group?: string;
        tag?: string;
        running?: boolean;
        trashed?: boolean;
        limit?: number;
        offset?: number;
      }) => {
        const client = ctx.client();
        const data = await inventoryRead(async () =>
          projectProfileList(
            unwrap(
              await client.GET("/v1/inventory/profiles", {
                ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
                params: {
                  query: {
                    ...(opts.query !== undefined ? { q: opts.query } : {}),
                    ...(opts.group !== undefined ? { group: opts.group } : {}),
                    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
                    ...(opts.trashed ? { trashed: true } : {}),
                    ...(opts.running ? { running: true } : {}),
                    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
                    ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
                  },
                },
              }),
            ),
            opts.limit,
            opts.offset,
            opts.running,
            ctx.keyMode(),
          ),
        );
        ctx.emit(data, () =>
          opts.trashed
            ? table(
                [...SUMMARY_HEADERS, "deleted"],
                data.items.map((p) => [...summaryRows([p])[0]!, p.deleted_at]),
              )
            : table(SUMMARY_HEADERS, summaryRows(data.items)),
        );
      },
    );

  profiles
    .command("create <name>")
    .description(
      "Create a profile. Its OS follows this computer: Linux on Linux when a Linux identity " +
        "can be issued (else a Windows profile, logged), Windows otherwise",
    )
    .option("--proxy <id|url|line>", "existing proxy id, or an inline proxy URL / provider line")
    .option("--group <name>", "folder")
    .option("--tag <tag>", "tag (repeatable)", collect, [])
    .option("--start-url <url>", "URL opened at launch (repeatable)", collect, [])
    .option("--pin", "pin the profile")
    .option("--headless", "launch headless by default")
    .option("--notes <text>", "free-form notes")
    .action(async (name: string, opts: CreateOptions) => {
      const created = unwrap(
        await ctx.client().POST("/v1/profiles", { body: createBody(name, opts) }),
      );
      ctx.emit(created, () => manifestText(created));
    });

  profiles
    .command("show <id>")
    .description("Show a profile (UUID or exact name) and its runtime state")
    .action(async (id: string) => {
      const data = unwrap(
        await ctx.client().GET("/v1/profiles/{id}", { params: { path: { id } } }),
      );
      ctx.emit(data, () => manifestText(data));
    });

  profiles
    .command("edit <id>")
    .description(
      "Patch fields: --set network.geo.timezone=Europe/Berlin --set tags=a,b --set pinned=true",
    )
    .requiredOption("--set <key=value>", "field to change (repeatable)", collect, [])
    .action(async (id: string, opts: { set: string[] }) => {
      if (opts.set.length === 0) throw new UsageError("edit needs at least one --set key=value");
      const body = parseSetArgs(opts.set) as ProfileInput;
      const updated = unwrap(
        await ctx.client().PATCH("/v1/profiles/{id}", { params: { path: { id } }, body }),
      );
      ctx.emit(updated, () => manifestText(updated));
    });

  profiles
    .command("set <ref...>")
    .description(
      "Change group, tags, pin, status, proxy or WebRTC on one or more profiles " +
        "(POST /profiles/bulk-update); use `edit --set` for any other field",
    )
    .option("--group <name>", "move into a folder")
    .option("--no-group", "remove from its folder")
    .option("--tag-add <tag>", "add a tag (repeatable)", collect, [])
    .option("--tag-remove <tag>", "remove a tag (repeatable)", collect, [])
    .option("--pin", "pin")
    .option("--no-pin", "unpin")
    .option("--status <text>", "set the status")
    .option("--no-status", "clear the status")
    .option("--proxy <id>", "use this saved proxy (id from `proxies ls`)")
    .option("--no-proxy", "use a direct connection")
    .option("--webrtc <mode>", "WebRTC mode: proxy-only, disabled or host")
    .action(async (refs: string[], opts: SetOptions) => {
      const patch = setPatch(opts);
      const ids = refsOrUsage(refs, "set");
      const result = unwrap(
        await ctx.client().POST("/v1/profiles/bulk-update", { body: { ids, patch } }),
      );
      finishBulk(ctx, "updated", result);
    });

  profiles
    .command("rm <ref...>")
    .description(
      "Move profiles to the trash (kept for 30 days by default, `profiles restore` brings them back); " +
        "--permanent deletes them for good, data directory included; --cloud also moves the " +
        "cloud copy of Cloud profiles to the cloud Trash. Refused while running",
    )
    .option("--permanent", "delete for good instead of trashing (asks unless --yes)")
    .option("--purge", "alias of --permanent")
    .option(
      "--cloud",
      "Cloud profiles: also move the cloud copy to the cloud Trash, removing it from your " +
        "other computers (asks unless --yes)",
    )
    .option("-y, --yes", "do not ask for confirmation")
    .action(
      async (
        refs: string[],
        opts: { permanent?: boolean; purge?: boolean; cloud?: boolean; yes?: boolean },
      ) => {
        const ids = refsOrUsage(refs, "rm");
        const permanent = opts.permanent === true || opts.purge === true;
        const cloud = opts.cloud === true;
        if (permanent && cloud) throw new UsageError("--cloud cannot be combined with --permanent");
        if (permanent) {
          await ctx.confirm(
            `permanently delete ${ids.length} profile(s) (${ids.join(", ")}) and their data?`,
            opts.yes,
          );
        }
        if (cloud) {
          await ctx.confirm(
            `move ${ids.length} profile(s) (${ids.join(", ")}) to the trash? Cloud profiles are ` +
              "also removed from the cloud and your other computers.",
            opts.yes,
          );
        }
        const client = ctx.client();
        const call = (id: string) =>
          client.DELETE("/v1/profiles/{id}", {
            params: {
              path: { id },
              query: permanent ? { permanent: true } : cloud ? { cloud: "trash" } : {},
            },
          });
        if (ids.length === 1) {
          unwrap(await call(ids[0]!));
          ctx.emit(undefined, () =>
            permanent
              ? `deleted ${ids[0]} permanently`
              : `moved ${ids[0]} to the trash (undo: ant0 profiles restore ${ids[0]})`,
          );
          return;
        }
        const result = await forEachRef(ids, async (id) => unwrap(await call(id)));
        finishBulk(
          ctx,
          permanent ? "deleted" : "trashed",
          result,
          permanent || result.updated === 0 ? [] : ["  undo: ant0 profiles restore <ref...>"],
        );
      },
    );

  profiles
    .command("restore <ref...>")
    .description("Bring profiles back from the trash")
    .action(async (refs: string[]) => {
      const ids = refsOrUsage(refs, "restore");
      const client = ctx.client();
      const call = async (id: string) =>
        unwrap(await client.POST("/v1/profiles/{id}/restore", { params: { path: { id } } }));
      if (ids.length === 1) {
        const restored = await call(ids[0]!);
        ctx.emit(restored, () => `restored ${ids[0]}`);
        return;
      }
      finishBulk(ctx, "restored", await forEachRef(ids, call));
    });

  profiles
    .command("run <id>")
    .description("Run a profile's saved configuration without requesting a CDP endpoint")
    .option(
      "--timeout <seconds>",
      "launch timeout (1-600 seconds)",
      boundedInt("--timeout", 1, 600),
    )
    .option(
      "--conflict-profile-id <uuid>",
      "explicitly reuse this exact stopped unresolved conflict",
      uuid("--conflict-profile-id"),
    )
    .action(async (id: string, opts: { timeout?: number; conflictProfileId?: string }) => {
      const client = ctx.client();
      await requireCredentialScopes(ctx, "profiles:run");
      try {
        const result = unwrap(
          await client.POST("/v1/profiles/{id}/run", {
            params: { path: { id } },
            body: {
              ...(opts.timeout !== undefined ? { timeout_s: opts.timeout } : {}),
              ...(opts.conflictProfileId !== undefined
                ? { conflict_profile_id: opts.conflictProfileId }
                : {}),
            },
          }),
        );
        ctx.emit(result, () => runResultText(result));
      } catch (error) {
        await inspectFailedRun(ctx, id, error);
        throw error;
      }
    });

  profiles
    .command("start <ref...>")
    .description(
      "Developer launch with CDP details and optional overrides; several refs use the " +
        "endpoint-free bulk run route",
    )
    .option("--headless", "run headless (single profile)")
    .option(
      "--start-url <url>",
      "override the start URLs (repeatable, single profile)",
      collect,
      [],
    )
    .option("--timeout <seconds>", "launch timeout (single profile)", positiveInt("--timeout"))
    .action(
      async (
        refs: string[],
        opts: { headless?: boolean; startUrl: string[]; timeout?: number },
      ) => {
        const ids = refsOrUsage(refs, "start");
        const client = ctx.client();
        if (ids.length > 1) {
          await requireCredentialScopes(ctx, "profiles:run");
          if (opts.headless || opts.startUrl.length > 0 || opts.timeout !== undefined) {
            throw new UsageError(
              "--headless, --start-url and --timeout apply to a single profile only",
            );
          }
          const result = unwrap(await client.POST("/v1/profiles/bulk-start", { body: { ids } }));
          finishCodedBulk(ctx, "started", result);
          return;
        }
        const id = ids[0]!;
        await requireCredentialScopes(ctx, "profiles:run", "profiles:cdp");
        try {
          const session = unwrap(
            await client.POST("/v1/profiles/{id}/start", {
              params: { path: { id } },
              body: {
                ...(opts.headless ? { headless: true } : {}),
                ...(opts.startUrl.length > 0 ? { start_urls: opts.startUrl } : {}),
                ...(opts.timeout !== undefined ? { timeout_s: opts.timeout } : {}),
              },
            }),
          );
          ctx.emit(session, () => sessionText(session));
        } catch (error) {
          await inspectFailedRun(ctx, id, error);
          throw error;
        }
      },
    );

  profiles
    .command("stop <ref...>")
    .description("Stop the running browser of one or more profiles (POST /profiles/bulk-stop)")
    .option("--force", "SIGKILL immediately (single profile)")
    .action(async (refs: string[], opts: { force?: boolean }) => {
      const ids = refsOrUsage(refs, "stop");
      const client = ctx.client();
      await requireCredentialScopes(ctx, "profiles:stop");
      if (ids.length > 1) {
        if (opts.force) throw new UsageError("--force applies to a single profile only");
        const result = unwrap(await client.POST("/v1/profiles/bulk-stop", { body: { ids } }));
        finishBulk(ctx, "stopped", result);
        return;
      }
      const id = ids[0]!;
      const stopped = await client.POST("/v1/profiles/{id}/stop", {
        params: { path: { id } },
        body: opts.force ? { force: true } : {},
      });
      unwrap(stopped);
      // The daemon normally sets Ant0-Sync (done, or pending when the upload outlasts 30 s); it may be
      // absent if there is nothing to sync.
      const pending = stopped.response.headers.get("ant0-sync") === "pending";
      ctx.emit(pending ? { sync: "pending" } : undefined, () =>
        pending ? `stopped ${id}; sync still uploading in the background` : `stopped ${id}`,
      );
    });

  profiles
    .command("status <id>")
    .description("Run state and endpoint-free lifecycle metadata of a profile")
    .action(async (id: string) => {
      const client = ctx.client();
      const data = await inventoryRead(async () =>
        projectProfileStatus(
          unwrap(
            await client.GET("/v1/inventory/profiles/{id}", {
              ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
              params: { path: { id } },
            }),
          ),
          id,
          ctx.keyMode(),
        ),
      );
      ctx.emit(data, () =>
        data.session
          ? keyValues([["state", data.state], ...Object.entries(data.session)])
          : keyValues([["state", data.state]]),
      );
    });

  profiles
    .command("promote <id>")
    .description("Publish an inherited local copy independently in the current workspace")
    .requiredOption("--folder-id <uuid|null>", "destination workspace folder, or null")
    .option("--name <name>", "rename the promoted profile")
    .action(async (id: string, opts: { folderId: string; name?: string }) => {
      const result = unwrap(
        await ctx.client().POST("/v1/profiles/{id}/promote", {
          params: { path: { id } },
          body: {
            folder_id: folderId(opts.folderId),
            ...(opts.name !== undefined ? { name: opts.name } : {}),
          },
        }),
      );
      ctx.emit(result, () => keyValues(flatten(result.receipt)));
    });

  profiles
    .command("identity <id>")
    .description("Preview the fingerprint persona the profile will launch with")
    .action(async (id: string) => {
      const data = unwrap(
        await ctx.client().GET("/v1/profiles/{id}/identity", { params: { path: { id } } }),
      );
      ctx.emit(data, () => {
        const head = keyValues([
          ["mode", data.mode],
          ["source", data.source ? `${data.source.kind} ${data.source.version}` : null],
          ["persisted", data.persisted],
          ["warnings", data.warnings.length === 0 ? "none" : null],
        ]);
        const warnings = data.warnings.map((w) => `  ${JSON.stringify(w)}`).join("\n");
        const persona = data.persona ? keyValues(flatten(data.persona, "persona")) : "";
        return [head, warnings, persona].filter((s) => s.length > 0).join("\n");
      });
    });

  const cookies = profiles.command("cookies").description("Import and export cookies");

  cookies
    .command("import <id> <file>")
    .description(
      "Import cookies (Cookie-Editor JSON, Puppeteer/Playwright arrays, or Netscape cookies.txt)",
    )
    .action(async (id: string, file: string) => {
      const data = readFileSync(file, "utf8");
      const result = unwrap(
        await ctx.client().POST("/v1/profiles/{id}/cookies", {
          params: { path: { id } },
          body: { format: "auto", data },
        }),
      );
      ctx.emit(result, () => keyValues(flatten(result)));
    });

  cookies
    .command("export <id>")
    .description("Export cookies")
    .option("--format <format>", "json or netscape", "json")
    .option("-o, --output <file>", "write to a file instead of stdout")
    .action(async (id: string, opts: { format: string; output?: string }) => {
      let text: string;
      if (opts.format === "netscape") {
        text = unwrap(
          await ctx.client().GET("/v1/profiles/{id}/cookies", {
            params: { path: { id }, query: { format: "netscape" } },
            parseAs: "text",
          }),
        );
      } else if (opts.format === "json") {
        const data = unwrap(
          await ctx.client().GET("/v1/profiles/{id}/cookies", {
            params: { path: { id }, query: { format: "json" } },
          }),
        );
        text = JSON.stringify(data, null, 2);
      } else {
        throw new UsageError(`--format must be json or netscape, got "${opts.format}"`);
      }
      if (opts.output) {
        writeFileSync(opts.output, text.endsWith("\n") ? text : `${text}\n`);
        if (!ctx.json) ctx.out(`wrote ${opts.output}`);
      } else {
        ctx.out(text);
      }
    });

  profiles
    .command("bulk <file>")
    .description("Create profiles from a CSV file (header row + one profile per row)")
    .action(async (file: string) => {
      const csv = readFileSync(file, "utf8");
      const result = unwrap(await ctx.client().POST("/v1/profiles/bulk", { body: { csv } }));
      ctx.emit(result, () => {
        const lines = [`created ${result.created.length} profile(s)`];
        for (const id of result.created) lines.push(`  ${id}`);
        if (result.errors.length > 0) lines.push(`errors ${result.errors.length}`);
        for (const e of result.errors) lines.push(`  row ${e.row}: ${e.message}`);
        return lines.join("\n");
      });
      if (result.created.length === 0 && result.errors.length > 0) {
        throw new CliError("no profiles created", 1);
      }
    });
}
