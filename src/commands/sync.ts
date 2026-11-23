/** Sync commands over the daemon's authenticated loopback API. */
import { unwrap, type components, type paths } from "../api/index.js";
import { formatRecoveryCode, parseRecoveryCode } from "../shared/recovery-code.js";
import { InvalidArgumentError, type Command } from "commander";
import { timingSafeEqual } from "node:crypto";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { keyValues, table } from "../format.js";
import type { NativeTerminal } from "../native-terminal.js";
import { printActiveWorkspace } from "./workspace.js";

type LocalMapping = components["schemas"]["LocalSyncMapping"];
type LocalKeyState = components["schemas"]["LocalSyncKeyState"];
type SyncStatus = paths["/v1/sync/status"]["get"]["responses"][200]["content"]["application/json"];
type RemoteProfile =
  paths["/v1/sync/profiles/remote"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type ConflictAction = "rebase" | "keep_both" | "discard";
type ProfileTransfer =
  paths["/v1/sync/transfers"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return parsed;
}

function parseConflictAction(value: string): ConflictAction {
  if (value === "rebase" || value === "keep_both" || value === "discard") return value;
  throw new InvalidArgumentError("expected rebase, keep_both or discard");
}

function withCursor(text: string, cursor: string | null): string {
  return cursor === null ? text : `${text}\nnext cursor: ${cursor}`;
}

function mappingRows(items: LocalMapping[]) {
  return items.map((mapping) => [
    mapping.local_profile_id,
    mapping.profile_id,
    mapping.state,
    mapping.dirty,
    mapping.head_revision_no,
    mapping.key_version,
    mapping.folder_id,
    mapping.last_error_code,
  ]);
}

function mappingTable(items: LocalMapping[]): string {
  return table(
    ["local", "remote", "state", "dirty", "revision", "key", "folder", "error"],
    mappingRows(items),
  );
}

function mappingText(mapping: LocalMapping): string {
  return keyValues([
    ["local profile", mapping.local_profile_id],
    ["remote profile", mapping.profile_id],
    ["workspace", mapping.workspace_id],
    ["folder", mapping.folder_id],
    ["state", mapping.state],
    ["dirty", mapping.dirty],
    ["head revision", mapping.head_revision_id],
    ["revision number", mapping.head_revision_no],
    ["key version", mapping.key_version],
    ["change sequence", mapping.change_seq],
    ["synced sequence", mapping.synced_change_seq],
    ["last error", mapping.last_error_code],
  ]);
}

function keyText(key: LocalKeyState): string {
  return keyValues([
    ["workspace", key.workspace_id],
    ["state", key.state],
    ["active key version", key.active_key_version],
    ["missing versions", key.missing_versions.length ? key.missing_versions.join(",") : null],
    [
      "unconfirmed versions",
      key.unconfirmed_versions.length ? key.unconfirmed_versions.join(",") : null,
    ],
  ]);
}

function statusText(status: SyncStatus): string {
  const summary = keyValues([
    ["workspace", status.workspace_id],
    ["mode", status.mode],
    ["key state", status.key.state],
    ["active key version", status.key.active_key_version],
    ["profiles", status.profiles.length],
  ]);
  return `${summary}\n\n${mappingTable(status.profiles)}`;
}

function remoteRows(items: RemoteProfile[]) {
  return items.map((profile) => [
    profile.profile_id,
    profile.name,
    profile.folder_id,
    profile.metadata_version,
    profile.current_revision?.revision_no ?? null,
    profile.current_revision?.key_version ?? null,
    profile.lease?.device_label ?? null,
  ]);
}

const HEADLESS_VAULT_WARNING =
  "Warning: standalone/headless sync protects its vault key with a mode-0600 file, not the OS keychain.";

async function readRecoveryCode(terminal: NativeTerminal, question: string): Promise<Buffer> {
  const input = await terminal.readSecret(question);
  try {
    return parseRecoveryCode(input.toString("ascii"));
  } catch (error) {
    throw new UsageError((error as Error).message);
  } finally {
    input.fill(0);
  }
}

async function readConfirmedRecoveryCode(
  terminal: NativeTerminal,
  firstQuestion: string,
  confirmationQuestion: string,
): Promise<Buffer> {
  const first = await readRecoveryCode(terminal, firstQuestion);
  try {
    const confirmation = await readRecoveryCode(terminal, confirmationQuestion);
    try {
      if (!timingSafeEqual(first, confirmation)) {
        throw new UsageError("recovery code confirmation does not match");
      }
      return first;
    } finally {
      confirmation.fill(0);
    }
  } catch (error) {
    first.fill(0);
    throw error;
  }
}

function rejectSecretArgv(command: Command): void {
  if (command.args.length > 0) {
    throw new UsageError(
      "secret values cannot be supplied on argv; use the hidden terminal prompt",
    );
  }
}

export function registerSync(program: Command, ctx: Context): void {
  const sync = program.command("sync").description("Encrypted profile sync and transfers");
  sync.hook("preAction", async () => printActiveWorkspace(ctx));

  sync
    .command("status")
    .description("Show local sync, key and profile state")
    .action(async () => {
      const result = unwrap(await ctx.client().GET("/v1/sync/status"));
      ctx.emit(result, () => statusText(result));
    });

  const remote = sync.command("remote").description("Cloud profiles visible to this device");
  remote
    .command("list")
    .alias("ls")
    .description("List remote profiles")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/sync/profiles/remote", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["id", "name", "folder", "metadata", "revision", "key", "lease device"],
            remoteRows(result.items),
          ),
          result.next_cursor,
        ),
      );
    });

  remote
    .command("materialize <profile>")
    .description("Download a cloud-only profile into a new local profile")
    .requiredOption("--revision <id>", "expected cloud revision UUID")
    .option("--name <name>", "local profile name override")
    .action(async (profile: string, opts: { revision: string; name?: string }) => {
      const result = unwrap(
        await ctx.client().POST("/v1/sync/profiles/remote/{profile}/materialize", {
          params: { path: { profile } },
          body: {
            expected_revision_id: opts.revision,
            ...(opts.name === undefined ? {} : { local_name: opts.name }),
          },
        }),
      );
      ctx.emit(result, () => mappingText(result.mapping));
    });

  sync
    .command("enroll <local>")
    .description("Enroll a stopped local profile in workspace sync")
    .option("--folder <id>", "destination team folder UUID")
    .option("--indexeddb", "include IndexedDB in encrypted bundles")
    .action(async (local: string, opts: { folder?: string; indexeddb?: boolean }) => {
      const result = unwrap(
        await ctx.client().POST("/v1/sync/profiles/{local}/enroll", {
          params: { path: { local } },
          body: { folder_id: opts.folder ?? null, sync_indexeddb: opts.indexeddb === true },
        }),
      );
      ctx.emit(result, () => mappingText(result.mapping));
    });

  sync
    .command("pull <local>")
    .description("Pull the current remote revision without overwriting dirty state")
    .option(
      "--replace-held",
      "replace a stopped profile whose cookies are held, including its local changes, with the cloud copy",
    )
    .action(async (local: string, opts: { replaceHeld?: boolean }) => {
      const result = unwrap(
        await ctx.client().POST("/v1/sync/profiles/{local}/pull", {
          params: { path: { local } },
          body: opts.replaceHeld ? { force: false, replace_held: true } : { force: false },
        }),
      );
      ctx.emit(result, () => mappingText(result.mapping));
    });

  sync
    .command("push <local>")
    .description("Capture a stopped profile and queue an encrypted upload")
    .option(
      "--allow-empty-cookies",
      "upload even if the profile has no cookies but had some at the last sync",
    )
    .action(async (local: string, opts: { allowEmptyCookies?: boolean }) => {
      const result = unwrap(
        await ctx.client().POST("/v1/sync/profiles/{local}/push", {
          params: { path: { local } },
          body: opts.allowEmptyCookies ? { allow_cookie_drop: true } : {},
        }),
      );
      ctx.emit(
        result,
        () =>
          `${keyValues([
            ["queue", result.queue_id],
            ["captured sequence", result.captured_change_seq],
          ])}\n${mappingText(result.mapping)}`,
      );
    });

  sync
    .command("disable <local>")
    .description("Stop syncing locally, or permanently delete the remote profile")
    .option("--permanent", "delete remote sync state and release its cloud claim")
    .option(
      "--metadata-version <n>",
      "expected metadata version (required with --permanent)",
      parsePositiveInteger,
    )
    .option("-y, --yes", "do not ask before permanent remote deletion")
    .action(
      async (
        local: string,
        opts: { permanent?: boolean; metadataVersion?: number; yes?: boolean },
      ) => {
        if (opts.permanent && opts.metadataVersion === undefined) {
          throw new UsageError("--permanent requires --metadata-version <n>");
        }
        if (!opts.permanent && opts.metadataVersion !== undefined) {
          throw new UsageError("--metadata-version is only valid with --permanent");
        }
        if (opts.permanent) {
          await ctx.confirm(`permanently delete remote sync state for ${local}?`, opts.yes);
        }
        const result = unwrap(
          await ctx.client().POST("/v1/sync/profiles/{local}/disable", {
            params: { path: { local } },
            body: {
              mode: opts.permanent ? "permanent_remote" : "local_only",
              expected_metadata_version: opts.metadataVersion ?? null,
            },
          }),
        );
        ctx.emit(result, () =>
          result.mapping === null ? `disabled sync for ${local}` : mappingText(result.mapping),
        );
      },
    );

  const conflicts = sync.command("conflicts").description("Preserved offline and CAS conflicts");
  conflicts
    .command("list")
    .alias("ls")
    .description("List unresolved local conflict copies")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/sync/conflicts", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["local", "source", "revision", "reason", "pending claim"],
            result.items.map((conflict) => [
              conflict.local_profile_id,
              conflict.source_profile_id,
              conflict.source_revision_id,
              conflict.reason,
              conflict.pending_claim,
            ]),
          ),
          result.next_cursor,
        ),
      );
    });

  conflicts
    .command("resolve")
    .description("Resolve with rebase, keep_both or discard")
    .argument("<local>", "local conflict profile UUID")
    .argument("<action>", "rebase, keep_both or discard", parseConflictAction)
    .option("--name <name>", "destination name for keep_both")
    .option("-y, --yes", "do not ask before discard")
    .action(
      async (local: string, action: ConflictAction, opts: { name?: string; yes?: boolean }) => {
        if (action === "discard") await ctx.confirm(`discard conflict copy ${local}?`, opts.yes);
        if (action !== "keep_both" && opts.name !== undefined) {
          throw new UsageError("--name is only valid with keep_both");
        }
        const result = unwrap(
          await ctx.client().POST("/v1/sync/conflicts/{local}/resolve", {
            params: { path: { local } },
            body: {
              action,
              ...(opts.name === undefined ? {} : { destination_name: opts.name }),
            },
          }),
        );
        ctx.emit(result, () =>
          result.mapping === null
            ? keyValues([
                ["state", result.state],
                ["mapping", null],
              ])
            : `${keyValues([["state", result.state]])}\n${mappingText(result.mapping)}`,
        );
      },
    );

  const recipients = sync.command("recipients").description("Workspace-key device recipients");
  recipients
    .command("list")
    .alias("ls")
    .description("List devices and key enrollment state")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/sync/keys/recipients", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["device", "state", "fingerprint"],
            result.items.map((recipient) => [
              recipient.device_id,
              recipient.key_state,
              recipient.recipient_kx_fingerprint,
            ]),
          ),
          result.next_cursor,
        ),
      );
    });

  recipients
    .command("enroll <device>")
    .description("Seal all readable workspace keys to a pending device")
    .action(async (device: string) => {
      const result = unwrap(
        await ctx.client().POST("/v1/sync/keys/enroll", { body: { device_id: device } }),
      );
      ctx.emit(result, () => `key state: ${result.key_state}`);
    });

  recipients
    .command("confirm")
    .description("Unwrap and confirm this device's pending key envelopes")
    .action(async () => {
      const result = unwrap(await ctx.client().POST("/v1/sync/keys/confirm", { body: {} }));
      ctx.emit(result, () => keyText(result.key));
    });

  const keys = sync.command("keys").description("CLI-only workspace recovery-key operations");
  keys
    .command("setup")
    .description("Set up sync keys with a securely pre-saved recovery code")
    .allowExcessArguments()
    .action(async (_opts: object, command: Command) => {
      rejectSecretArgv(command);
      const result = await ctx.withNativeTerminal("sync key setup", async (terminal) => {
        terminal.writeLine(HEADLESS_VAULT_WARNING);
        terminal.writeLine("Enter a recovery code that you have already stored securely.");
        const raw = await readConfirmedRecoveryCode(
          terminal,
          "Recovery code: ",
          "Confirm recovery code: ",
        );
        try {
          return unwrap(
            await ctx.client().POST("/v1/sync/keys/setup", {
              body: { recovery_code: formatRecoveryCode(raw) },
            }),
          );
        } finally {
          raw.fill(0);
        }
      });
      ctx.emit(result, () => keyText(result.key));
    });

  keys
    .command("recover")
    .description("Recover sync keys using a securely pre-saved replacement code")
    .allowExcessArguments()
    .action(async (_opts: object, command: Command) => {
      rejectSecretArgv(command);
      const result = await ctx.withNativeTerminal("sync key recovery", async (terminal) => {
        terminal.writeLine(HEADLESS_VAULT_WARNING);
        terminal.writeLine("Enter a replacement code that you have already stored securely.");
        const current = await readRecoveryCode(terminal, "Current recovery code: ");
        let replacement: Buffer | undefined;
        try {
          replacement = await readConfirmedRecoveryCode(
            terminal,
            "Replacement recovery code: ",
            "Confirm replacement recovery code: ",
          );
          if (timingSafeEqual(current, replacement)) {
            throw new UsageError("replacement recovery code must differ from the current code");
          }
          return unwrap(
            await ctx.client().POST("/v1/sync/keys/recover", {
              body: {
                recovery_code: formatRecoveryCode(current),
                replacement_recovery_code: formatRecoveryCode(replacement),
              },
            }),
          );
        } finally {
          current.fill(0);
          replacement?.fill(0);
        }
      });
      ctx.emit(result, () => keyText(result.key));
    });

  keys
    .command("lock")
    .description("Zeroize and lock workspace keys held by the daemon")
    .action(async () => {
      unwrap(await ctx.client().POST("/v1/sync/keys/lock", { body: {} }));
      ctx.emit(undefined, () => "sync keys locked");
    });

  const transfer = sync.command("transfer").description("Cross-workspace profile transfer");
  transfer
    .command("list")
    .alias("ls")
    .description("List authorized cross-workspace profile transfers")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/sync/transfers", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["id", "direction", "state", "source", "destination", "profile", "name", "expires"],
            result.items.map((item: ProfileTransfer) => [
              item.transfer_id,
              item.direction,
              item.state,
              item.source_workspace_id,
              item.destination_workspace_id,
              item.source_profile_id,
              item.destination_name,
              item.expires_at,
            ]),
          ),
          result.next_cursor,
        ),
      );
    });

  transfer
    .command("start <local> <workspace> <name>")
    .description("Start an encrypted transfer of a local synced profile")
    .option("--folder <id>", "destination folder UUID")
    .action(async (local: string, workspace: string, name: string, opts: { folder?: string }) => {
      const result = unwrap(
        await ctx.client().POST("/v1/sync/transfers", {
          body: {
            local_profile_id: local,
            destination_workspace_id: workspace,
            destination_folder_id: opts.folder ?? null,
            destination_name: name,
          },
        }),
      );
      ctx.emit(result, () =>
        keyValues([
          ["transfer", result.transfer_id],
          ["state", result.state],
        ]),
      );
    });

  transfer
    .command("status <transfer>")
    .description("Show durable profile-transfer state")
    .action(async (transferId: string) => {
      const result = unwrap(
        await ctx.client().GET("/v1/sync/transfers/{transfer}", {
          params: { path: { transfer: transferId } },
        }),
      );
      ctx.emit(result, () =>
        keyValues([
          ["transfer", result.transfer_id],
          ["state", result.state],
          ["error", result.error_code],
        ]),
      );
    });

  transfer
    .command("accept <transfer>")
    .description("Move a ready profile into its destination workspace")
    .option("-y, --yes", "confirm the move and source deletion")
    .action(async (transferId: string, opts: { yes?: boolean }) => {
      await ctx.confirm(
        `accept profile transfer ${transferId}? This moves the profile and deletes its source cloud copy`,
        opts.yes,
      );
      const result = unwrap(
        await ctx.client().POST("/v1/sync/transfers/{transfer}/accept", {
          params: { path: { transfer: transferId } },
          body: {},
        }),
      );
      ctx.emit(result, () => mappingText(result.mapping));
    });

  transfer
    .command("abort <transfer>")
    .description("Abort a pending or ready profile transfer")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (transferId: string, opts: { yes?: boolean }) => {
      await ctx.confirm(`abort profile transfer ${transferId}?`, opts.yes);
      unwrap(
        await ctx.client().POST("/v1/sync/transfers/{transfer}/abort", {
          params: { path: { transfer: transferId } },
          body: {},
        }),
      );
      ctx.emit(undefined, () => `aborted transfer ${transferId}`);
    });
}
