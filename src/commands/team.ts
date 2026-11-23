/** Team administration commands over the daemon's authenticated loopback API. */
import { isAnt0ApiError, unwrap } from "../api/index.js";
import { InvalidArgumentError, type Command } from "commander";
import { createHash } from "node:crypto";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { keyValues, table } from "../format.js";
import type { NativeTerminal } from "../native-terminal.js";
import { validateEmail } from "./account.js";
import { printActiveWorkspace } from "./workspace.js";

type TeamRole = "manager" | "operator" | "starter";
interface MutationOptions {
  idempotencyKey: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const OWNERSHIP_IDEMPOTENCY_DOMAIN = "ant0/cli/ownership-acceptance/idempotency/v1\0";
const HEADLESS_VAULT_WARNING =
  "Warning: standalone/headless sync protects its vault key with a mode-0600 file, not the OS keychain.";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRole(value: string): TeamRole {
  if (value === "manager" || value === "operator" || value === "starter") return value;
  throw new InvalidArgumentError("expected manager, operator or starter");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return parsed;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseIdempotencyKey(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new UsageError("idempotency key must be a lowercase canonical UUID");
  }
  return value;
}

function mutation(command: Command): Command {
  return command.requiredOption(
    "--idempotency-key <uuid>",
    "stable UUID to reuse when retrying this mutation",
    parseIdempotencyKey,
  );
}

function headers(opts: MutationOptions) {
  return { "idempotency-key": opts.idempotencyKey };
}

function withCursor(text: string, cursor: string | null): string {
  return cursor === null ? text : `${text}\nnext cursor: ${cursor}`;
}

function ensureFolders(folder: string[]): string[] {
  const unique = [...new Set(folder)];
  if (unique.length !== folder.length) throw new UsageError("--folder values must be unique");
  return unique;
}

function rejectSecretArgv(command: Command): void {
  if (command.args.length > 0) {
    throw new UsageError(
      "secret values cannot be supplied on argv; use the hidden terminal prompt",
    );
  }
}

/** Stable UUID with the same RFC 4122 version/variant normalization as daemon operation IDs. */
export function deriveOwnershipAcceptanceIdempotencyKey(token: Uint8Array): string {
  const digest = createHash("sha256").update(OWNERSHIP_IDEMPOTENCY_DOMAIN).update(token).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  digest.fill(0);
  try {
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } finally {
    bytes.fill(0);
  }
}

async function withToken<T>(
  terminal: NativeTerminal,
  question: string,
  action: (token: Buffer) => Promise<T>,
): Promise<T> {
  const input = await terminal.readSecret(question);
  try {
    const token = input.toString("ascii");
    if (!TOKEN_RE.test(token)) throw new UsageError("token must be 43 base64url characters");
    return await action(input);
  } finally {
    input.fill(0);
  }
}

async function acceptedOwnership(ctx: Context, operationKey: string) {
  try {
    return unwrap(
      await ctx.client().GET("/v1/team/ownership-transfers/accept", {
        params: { header: { "idempotency-key": operationKey } },
      }),
    );
  } catch (error) {
    if (
      isAnt0ApiError(error) &&
      (error.status === 404 || (error.status === 409 && error.code === "ownership.conflict"))
    ) {
      return undefined;
    }
    throw error;
  }
}

function writeOwnershipRecovery(
  terminal: NativeTerminal,
  result: { workspace_id: string; owner_user_id: string; recovery_code: string },
): { workspace_id: string; owner_user_id: string } {
  const recovery = Buffer.from(result.recovery_code, "ascii");
  try {
    terminal.writeLine("Store this replacement recovery code securely before acknowledging it.");
    terminal.writeSecret("Recovery code: ", recovery);
  } finally {
    recovery.fill(0);
  }
  return { workspace_id: result.workspace_id, owner_user_id: result.owner_user_id };
}

export function registerTeam(program: Command, ctx: Context): void {
  const team = program.command("team").description("Folders, members and invitations");
  team.hook("preAction", async () => printActiveWorkspace(ctx));

  const folders = team.command("folders").description("Team profile folders");
  folders
    .command("list")
    .alias("ls")
    .description("List visible team folders")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/team/folders", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["id", "name", "version", "updated"],
            result.items.map((folder) => [
              folder.id,
              folder.name,
              folder.metadata_version,
              folder.updated_at,
            ]),
          ),
          result.next_cursor,
        ),
      );
    });

  mutation(folders.command("create <name>").description("Create a team folder")).action(
    async (name: string, opts: MutationOptions) => {
      const result = unwrap(
        await ctx.client().POST("/v1/team/folders", {
          params: { header: headers(opts) },
          body: { name },
        }),
      );
      ctx.emit(result, () =>
        keyValues([
          ["folder", result.folder.id],
          ["name", result.folder.name],
          ["version", result.folder.metadata_version],
        ]),
      );
    },
  );

  mutation(
    folders
      .command("update <id> <name>")
      .description("Rename a team folder with metadata CAS")
      .requiredOption("--metadata-version <n>", "expected metadata version", parsePositiveInteger),
  ).action(
    async (id: string, name: string, opts: MutationOptions & { metadataVersion: number }) => {
      const result = unwrap(
        await ctx.client().PATCH("/v1/team/folders/{id}", {
          params: { path: { id }, header: headers(opts) },
          body: { expected_metadata_version: opts.metadataVersion, name },
        }),
      );
      ctx.emit(result, () =>
        keyValues([
          ["folder", result.folder.id],
          ["name", result.folder.name],
          ["version", result.folder.metadata_version],
        ]),
      );
    },
  );

  mutation(
    folders
      .command("remove <id>")
      .description("Delete a folder and optionally move its profiles")
      .requiredOption("--metadata-version <n>", "expected metadata version", parsePositiveInteger)
      .option("--move-profiles-to <id>", "destination folder UUID (default: unfiled)")
      .option("-y, --yes", "do not ask for confirmation"),
  ).action(
    async (
      id: string,
      opts: MutationOptions & {
        metadataVersion: number;
        moveProfilesTo?: string;
        yes?: boolean;
      },
    ) => {
      await ctx.confirm(`remove team folder ${id}?`, opts.yes);
      unwrap(
        await ctx.client().DELETE("/v1/team/folders/{id}", {
          params: { path: { id }, header: headers(opts) },
          body: {
            expected_metadata_version: opts.metadataVersion,
            move_profiles_to: opts.moveProfilesTo ?? null,
          },
        }),
      );
      ctx.emit(undefined, () => `removed folder ${id}`);
    },
  );

  const members = team.command("members").description("Accepted workspace members");
  members
    .command("list")
    .alias("ls")
    .description("List team members")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/team/members", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["id", "email", "role", "state", "key", "folders"],
            result.items.map((member) => [
              member.user_id,
              member.email,
              member.role,
              member.state,
              member.key_state,
              member.folder_ids.length ? member.folder_ids.join(",") : null,
            ]),
          ),
          result.next_cursor,
        ),
      );
    });

  mutation(
    members
      .command("update <id>")
      .description("Change a member role and folder grants")
      .requiredOption("--role <role>", "manager, operator or starter", parseRole)
      .option("--folder <id>", "granted folder UUID (repeatable)", collect, []),
  ).action(async (id: string, opts: MutationOptions & { role: TeamRole; folder: string[] }) => {
    const result = unwrap(
      await ctx.client().PATCH("/v1/team/members/{id}", {
        params: { path: { id }, header: headers(opts) },
        body: { role: opts.role, folder_ids: ensureFolders(opts.folder) },
      }),
    );
    ctx.emit(result, () =>
      keyValues([
        ["member", result.member.user_id],
        ["email", result.member.email],
        ["role", result.member.role],
        ["key state", result.member.key_state],
        ["folders", result.member.folder_ids.length ? result.member.folder_ids.join(",") : null],
      ]),
    );
  });

  mutation(
    members
      .command("remove <id>")
      .description("Remove a member and immediately revoke new access")
      .option("-y, --yes", "do not ask for confirmation"),
  ).action(async (id: string, opts: MutationOptions & { yes?: boolean }) => {
    await ctx.confirm(`remove team member ${id}?`, opts.yes);
    unwrap(
      await ctx.client().DELETE("/v1/team/members/{id}", {
        params: { path: { id }, header: headers(opts) },
      }),
    );
    ctx.emit(undefined, () => `removed member ${id}`);
  });

  const invites = team.command("invites").description("Workspace invitations");
  invites
    .command("list")
    .alias("ls")
    .description("List invitations (tokens are never returned)")
    .option("--cursor <cursor>", "continue an earlier listing")
    .action(async (opts: { cursor?: string }) => {
      const result = unwrap(
        await ctx.client().GET("/v1/team/invites", {
          params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
        }),
      );
      ctx.emit(result, () =>
        withCursor(
          table(
            ["id", "email", "role", "state", "folders", "expires"],
            result.items.map((invite) => [
              invite.id,
              invite.email,
              invite.role,
              invite.state,
              invite.folder_ids.length ? invite.folder_ids.join(",") : null,
              invite.expires_at,
            ]),
          ),
          result.next_cursor,
        ),
      );
    });

  mutation(
    invites
      .command("create <email>")
      .description("Invite a verified account to the workspace")
      .requiredOption("--role <role>", "manager, operator or starter", parseRole)
      .option("--folder <id>", "granted folder UUID (repeatable)", collect, []),
  ).action(async (email: string, opts: MutationOptions & { role: TeamRole; folder: string[] }) => {
    const result = unwrap(
      await ctx.client().POST("/v1/team/invites", {
        params: { header: headers(opts) },
        body: {
          email: validateEmail(email),
          role: opts.role,
          folder_ids: ensureFolders(opts.folder),
        },
      }),
    );
    ctx.emit(result, () =>
      keyValues([
        ["invite", result.invite.id],
        ["email", result.invite.email],
        ["role", result.invite.role],
        ["state", result.invite.state],
        ["expires", result.invite.expires_at],
      ]),
    );
  });

  mutation(invites.command("revoke <id>").description("Revoke a pending invitation")).action(
    async (id: string, opts: MutationOptions) => {
      unwrap(
        await ctx.client().POST("/v1/team/invites/{id}/revoke", {
          params: { path: { id }, header: headers(opts) },
          body: {},
        }),
      );
      ctx.emit(undefined, () => `revoked invite ${id}`);
    },
  );

  mutation(
    invites
      .command("accept")
      .description(
        "Accept an invitation; reads its token without echo from an interactive terminal",
      )
      // Absorb unexpected values so Commander never reflects a token-looking `--value` in errors.
      .allowUnknownOption()
      .allowExcessArguments(),
  ).action(async (opts: MutationOptions, command: Command) => {
    rejectSecretArgv(command);
    const result = await ctx.withNativeTerminal("invitation acceptance", async (terminal) => {
      return withToken(terminal, "Invitation token: ", async (token) =>
        unwrap(
          await ctx.client().POST("/v1/team/invites/accept", {
            params: { header: headers(opts) },
            body: { token: token.toString("ascii") },
          }),
        ),
      );
    });
    ctx.emit(
      result,
      () =>
        `${keyValues([
          ["workspace", result.workspace_id],
          ["member", result.member.user_id],
          ["role", result.member.role],
          ["key state", result.key_state],
        ])}\nRun \`ant0 workspace switch ${result.workspace_id}\` to use the accepted workspace.`,
    );
  });

  const ownership = team.command("ownership").description("Workspace ownership transfer");
  for (const direction of ["outgoing", "incoming"] as const) {
    ownership
      .command(direction)
      .description(`List ${direction} ownership transfers`)
      .option("--cursor <cursor>", "continue an earlier listing")
      .action(async (opts: { cursor?: string }) => {
        const path = `/v1/team/ownership-transfers/${direction}` as const;
        const result = unwrap(
          await ctx.client().GET(path, {
            params: { query: opts.cursor === undefined ? {} : { cursor: opts.cursor } },
          }),
        );
        ctx.emit(result, () =>
          withCursor(
            table(
              ["id", "workspace", "name", "from", "to", "state", "expires"],
              result.items.map((item) => [
                item.transfer_id,
                item.workspace_id,
                item.workspace_name,
                item.from_user_id,
                item.to_user_id,
                item.state,
                item.expires_at,
              ]),
            ),
            result.next_cursor,
          ),
        );
      });
  }
  mutation(
    ownership
      .command("start <user>")
      .description("Offer workspace ownership to an accepted key-ready member"),
  ).action(async (user: string, opts: MutationOptions) => {
    const result = unwrap(
      await ctx.client().POST("/v1/team/ownership-transfers", {
        params: { header: headers(opts) },
        body: { target_user_id: user },
      }),
    );
    ctx.emit(result, () =>
      keyValues([
        ["transfer", result.transfer_id],
        ["expires", result.expires_at],
      ]),
    );
  });

  ownership
    .command("accept")
    .description("Accept ownership and show its recovery code on the controlling terminal")
    // Absorb unexpected values so Commander never reflects a token-looking `--value` in errors.
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_opts: object, command: Command) => {
      rejectSecretArgv(command);
      const publicResult = await ctx.withNativeTerminal(
        "ownership acceptance",
        async (terminal) => {
          terminal.writeLine(HEADLESS_VAULT_WARNING);
          return withToken(terminal, "Ownership transfer token: ", async (token) => {
            const operationKey = deriveOwnershipAcceptanceIdempotencyKey(token);
            const recovered = await acceptedOwnership(ctx, operationKey);
            let result = recovered;
            if (!result) {
              const workspaces = unwrap(await ctx.client().GET("/v1/workspaces"));
              if (workspaces.current_workspace_id === null) {
                throw new UsageError("ownership acceptance requires a current workspace");
              }
              result = unwrap(
                await ctx.client().POST("/v1/team/ownership-transfers/accept", {
                  params: { header: { "idempotency-key": operationKey } },
                  body: {
                    token: token.toString("ascii"),
                    expected_workspace_id: workspaces.current_workspace_id,
                  },
                }),
              );
            }
            return writeOwnershipRecovery(terminal, result);
          });
        },
      );
      ctx.emit(publicResult, () =>
        keyValues([
          ["workspace", publicResult.workspace_id],
          ["owner", publicResult.owner_user_id],
        ]),
      );
    });

  ownership
    .command("status")
    .description("Retrieve a retained recovery code using the emailed token")
    // Absorb unexpected values so Commander never reflects a token-looking `--value` in errors.
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_opts: object, command: Command) => {
      rejectSecretArgv(command);
      const publicResult = await ctx.withNativeTerminal(
        "ownership recovery retrieval",
        async (terminal) => {
          terminal.writeLine(HEADLESS_VAULT_WARNING);
          return withToken(terminal, "Ownership transfer token: ", async (token) => {
            const result = unwrap(
              await ctx.client().GET("/v1/team/ownership-transfers/accept", {
                params: {
                  header: {
                    "idempotency-key": deriveOwnershipAcceptanceIdempotencyKey(token),
                  },
                },
              }),
            );
            return writeOwnershipRecovery(terminal, result);
          });
        },
      );
      ctx.emit(publicResult, () =>
        keyValues([
          ["workspace", publicResult.workspace_id],
          ["owner", publicResult.owner_user_id],
        ]),
      );
    });

  ownership
    .command("acknowledge")
    .description("Clear a retained recovery code after storing it safely")
    .option("-y, --yes", "do not ask for confirmation")
    // Absorb unexpected values so Commander never reflects a token-looking `--value` in errors.
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (opts: { yes?: boolean }, command: Command) => {
      rejectSecretArgv(command);
      const operationKey = await ctx.withNativeTerminal(
        "ownership recovery acknowledgement",
        async (terminal) =>
          withToken(terminal, "Ownership transfer token: ", async (token) =>
            deriveOwnershipAcceptanceIdempotencyKey(token),
          ),
      );
      await ctx.confirm("clear the retained ownership recovery code?", opts.yes);
      unwrap(
        await ctx.client().DELETE("/v1/team/ownership-transfers/accept", {
          params: { header: { "idempotency-key": operationKey } },
        }),
      );
      ctx.emit(undefined, () => "ownership recovery code acknowledged and cleared");
    });

  mutation(
    ownership
      .command("cancel <id>")
      .description("Cancel a pending ownership transfer")
      .option("-y, --yes", "do not ask for confirmation"),
  ).action(async (id: string, opts: MutationOptions & { yes?: boolean }) => {
    await ctx.confirm(`cancel ownership transfer ${id}?`, opts.yes);
    unwrap(
      await ctx.client().POST("/v1/team/ownership-transfers/{id}/cancel", {
        params: { path: { id }, header: headers(opts) },
        body: {},
      }),
    );
    ctx.emit(undefined, () => `cancelled ownership transfer ${id}`);
  });
}
