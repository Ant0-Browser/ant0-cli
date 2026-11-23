import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { Command } from "commander";
import {
  createAnt0Client,
  TokenFileNotPrivateError,
  isAnt0ApiError,
  unwrap,
  type Ant0Client,
  type paths,
} from "../api/index.js";
import { canonicalOrigin } from "@ant0/mcp";
import {
  CredentialFailure,
  CredentialCollision,
  keyId,
  keyName,
  lifetime,
  keyScopes,
  operateScopes,
  readScopes,
  newCredential,
  projectExpectedContext,
  projectKeyMetadata,
  projectKeyList,
  projectGrantStatus,
  matchingMetadata,
  readCredentialFile,
  saveCredentialFile,
  flushCredentialBeforeSubmission,
  rejectCredentialEcho,
  withCredentialLock,
  type ExpectedContext,
  type CredentialSnapshot,
} from "@ant0/mcp/credentials";
import type { Context } from "../context.js";
import { CliError, DaemonNotRunningError, UsageError } from "../errors.js";
import { keyValues, flatten, table } from "../format.js";
import { directManagementFetch } from "../management-transport.js";

const boundedClients = new WeakMap<Context, Ant0Client>();
/** Management remains local-master authenticated even when --credential-file selects its output. */
function management(ctx: Context): Ant0Client {
  const cached = boundedClients.get(ctx);
  if (cached) return cached;
  const connection = ctx.authenticatedConnection();
  if (!connection.token) throw new DaemonNotRunningError();
  const client = createAnt0Client({
    baseUrl: canonicalOrigin(connection.baseUrl),
    token: connection.token,
    fetch: ctx.io.fetch ?? directManagementFetch,
  });
  client.use({
    onRequest({ request }) {
      const url = new URL(request.url);
      const origin = canonicalOrigin(url.origin);
      if (
        !/^\/v1\/automation\/api-keys(?:\/(?:context|provision|[0-9a-f-]{36}))?$/.test(url.pathname)
      )
        throw new CliError("invalid local API key management destination");
      return new Request(new Request(`${origin}${url.pathname}${url.search}`, request), {
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(10_000),
          ...(ctx.io.signal ? [ctx.io.signal] : []),
        ]),
      });
    },
    async onResponse({ response }) {
      if (response.status === 204) return response;
      const reader = response.body?.getReader();
      if (!reader) throw new CliError("invalid API key response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new CliError("API key response exceeds limit");
          chunks.push(value);
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        return new Response(text, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  });
  boundedClients.set(ctx, client);
  return client;
}

async function safely<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof TokenFileNotPrivateError) throw new CliError(error.message);
    if (isAnt0ApiError(error)) throw new CliError(`API key request failed (HTTP ${error.status})`);
    if (error instanceof CredentialFailure) throw new CliError(error.message);
    throw new CliError("API key operation unavailable");
  }
}
function uuid(value: string): string {
  if (!keyId.safeParse(value).success) throw new UsageError("expected a lowercase UUID");
  return value;
}
function name(value: string): string {
  if (!keyName.safeParse(value).success)
    throw new UsageError("name requires 1–100 printable characters");
  return value;
}
function seconds(value: string): number {
  const n = Number(value);
  if (!lifetime.safeParse(n).success)
    throw new UsageError("lifetime must be 60–31536000 integer seconds");
  return n;
}
function pageSize(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new UsageError("limit must be 1–100");
  return n;
}
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
export function provisionScopes(preset: string, selected: readonly string[] = []) {
  if (preset !== "read" && preset !== "operate")
    throw new UsageError("preset must be read or operate");
  for (const scope of selected) {
    if (!keyScopes.includes(scope as (typeof keyScopes)[number]))
      throw new UsageError(`unsupported API key scope: ${scope}`);
  }
  return [
    ...new Set<(typeof keyScopes)[number]>([
      ...(preset === "operate" ? operateScopes : readScopes),
      ...(selected as (typeof keyScopes)[number][]),
    ]),
  ];
}
type ProvisionBody = NonNullable<
  paths["/v1/automation/api-keys/provision"]["post"]["requestBody"]
>["content"]["application/json"];
async function context(ctx: Context, workspace?: string): Promise<ExpectedContext> {
  const value = projectExpectedContext(
    unwrap(await management(ctx).GET("/v1/automation/api-keys/context")),
  );
  if (workspace !== undefined && workspace !== value.workspace_id)
    throw new UsageError("workspace must match the selected daemon workspace");
  return value;
}
function oneKey(value: unknown) {
  if (!value || typeof value !== "object" || !("key" in value))
    throw new CredentialFailure("invalid API key metadata");
  return projectKeyMetadata(value.key);
}
export function registerApiKeys(program: Command, ctx: Context): void {
  const keys = program
    .command("api-keys")
    .description("Manage delegated API keys using the local master bearer");
  keys
    .command("create [name]")
    .description("Durably provision or exactly replay a private credential file")
    .option("--name <name>", "key name", name)
    .requiredOption("--preset <preset>", "scope preset (read or operate)")
    .option(
      "--scope <scope>",
      "explicit scope added to the preset, such as profiles:cdp (repeatable)",
      collect,
      [],
    )
    .option("--lifetime-seconds <seconds>", "finite lifetime (default 2592000)", seconds)
    .option("--workspace <uuid>", "require selected workspace", uuid)
    .action(
      async (
        positional: string | undefined,
        opts: {
          name?: string;
          preset: string;
          scope: string[];
          lifetimeSeconds?: number;
          workspace?: string;
        },
      ) =>
        safely(async () => {
          const path = ctx.globals.credentialFile;
          if (!path) throw new UsageError("create requires --credential-file");
          const requestedScopes = provisionScopes(opts.preset, opts.scope);
          if (positional !== undefined) name(positional);
          if (positional !== undefined && opts.name !== undefined && positional !== opts.name)
            throw new UsageError("conflicting key names");
          const requestedName = opts.name ?? positional;
          await withCredentialLock(path, async () => {
            let saved: CredentialSnapshot | undefined;
            try {
              lstatSync(path);
              saved = readCredentialFile(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (saved) {
              if (
                (requestedName !== undefined && requestedName !== saved.value.create.name) ||
                (opts.lifetimeSeconds !== undefined &&
                  opts.lifetimeSeconds !== saved.value.create.lifetime_seconds) ||
                [...saved.value.create.scopes].sort().join() !==
                  [...requestedScopes].sort().join() ||
                (opts.workspace !== undefined &&
                  opts.workspace !== saved.value.expected.workspace_id)
              )
                throw new UsageError("creation options do not match the saved credential file");
            } else if (requestedName === undefined) throw new UsageError("new keys require a name");
            const expected = await context(ctx, opts.workspace);
            if (saved && JSON.stringify(saved.value.expected) !== JSON.stringify(expected))
              throw new UsageError("saved credential context does not match the daemon context");
            if (!saved) {
              const id = randomUUID();
              try {
                saved = saveCredentialFile(path, {
                  schema: "ant0-api-key/v1",
                  expected,
                  create: {
                    id,
                    credential: newCredential(id),
                    name: requestedName!,
                    scopes: requestedScopes,
                    lifetime_seconds: opts.lifetimeSeconds ?? 2_592_000,
                  },
                  phase: "pending",
                  key: null,
                });
              } catch (error) {
                if (!(error instanceof CredentialCollision)) throw error;
                saved = readCredentialFile(path);
                if (
                  JSON.stringify(saved.rawValue.expected) !== JSON.stringify(expected) ||
                  saved.rawValue.create.name !== requestedName ||
                  saved.rawValue.create.lifetime_seconds !== (opts.lifetimeSeconds ?? 2_592_000) ||
                  [...saved.rawValue.create.scopes].sort().join() !==
                    [...requestedScopes].sort().join()
                )
                  throw new UsageError("concurrent credential does not match creation options");
              }
            }
            const pinned = flushCredentialBeforeSubmission(saved);
            let response;
            try {
              const body: ProvisionBody = {
                expected: saved.rawValue.expected,
                create: saved.rawValue.create,
              };
              response = unwrap(
                await management(ctx).POST("/v1/automation/api-keys/provision", {
                  body,
                  ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
                }),
              );
            } finally {
              pinned.close();
            }
            const key = oneKey(response);
            rejectCredentialEcho(key, saved.value.create.credential);
            if (!matchingMetadata(saved.value, key))
              throw new CredentialFailure("API key reply does not match the saved request");
            // saveCredentialFile revalidates the exact source and receipt before publication.
            saveCredentialFile(path, { ...saved.value, phase: "ready", key }, saved);
            ctx.emit({ key, credential_file: saved.path }, () =>
              keyValues(flatten({ key, credential_file: saved!.path })),
            );
          });
        }),
    );
  keys
    .command("list")
    .option("--workspace <uuid>", "require selected workspace", uuid)
    .option("--limit <n>", "page size (default 50)", pageSize, 50)
    .option("--cursor <cursor>", "opaque next-page cursor")
    .action(async (opts: { workspace?: string; limit: number; cursor?: string }) =>
      safely(async () => {
        if (opts.cursor !== undefined && (opts.cursor.length === 0 || opts.cursor.length > 4096))
          throw new UsageError("invalid cursor length");
        const expected = await context(ctx, opts.workspace);
        const data = projectKeyList(
          unwrap(
            await management(ctx).GET("/v1/automation/api-keys", {
              params: {
                query: {
                  limit: opts.limit,
                  ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
                },
              },
            }),
          ),
        );
        if (
          data.items.length > opts.limit ||
          data.items.some((key) => key.workspace_id !== expected.workspace_id) ||
          (data.next_cursor !== null &&
            (data.items.length === 0 || data.next_cursor === opts.cursor))
        )
          throw new CredentialFailure("invalid API key metadata");
        ctx.emit(
          data,
          () =>
            table(
              ["id", "name", "status", "expires"],
              data.items.map((key) => [key.id, key.name, key.status, key.expires_at]),
            ) +
            (data.next_cursor === null ? "" : `\nnext_cursor: ${JSON.stringify(data.next_cursor)}`),
        );
      }),
    );
  keys
    .command("show <id>")
    .option("--workspace <uuid>", "require selected workspace", uuid)
    .action(async (id: string, opts: { workspace?: string }) =>
      safely(async () => {
        uuid(id);
        const expected = await context(ctx, opts.workspace);
        const key = oneKey(
          unwrap(
            await management(ctx).GET("/v1/automation/api-keys/{id}", { params: { path: { id } } }),
          ),
        );
        if (key.id !== id || key.workspace_id !== expected.workspace_id)
          throw new CredentialFailure("invalid API key metadata");
        ctx.emit({ key }, () => keyValues(flatten(key)));
      }),
    );
  keys
    .command("rename <id> <name>")
    .option("--workspace <uuid>", "require selected workspace", uuid)
    .action(async (id: string, newName: string, opts: { workspace?: string }) =>
      safely(async () => {
        uuid(id);
        name(newName);
        const expected = await context(ctx, opts.workspace);
        const key = oneKey(
          unwrap(
            await management(ctx).PATCH("/v1/automation/api-keys/{id}", {
              params: { path: { id } },
              body: { name: newName },
            }),
          ),
        );
        if (key.id !== id || key.workspace_id !== expected.workspace_id || key.name !== newName)
          throw new CredentialFailure("invalid API key metadata");
        ctx.emit({ key }, () => keyValues(flatten(key)));
      }),
    );
  keys
    .command("revoke <id>")
    .option("--workspace <uuid>", "require selected workspace", uuid)
    .action(async (id: string, opts: { workspace?: string }) =>
      safely(async () => {
        uuid(id);
        await context(ctx, opts.workspace);
        unwrap(
          await management(ctx).DELETE("/v1/automation/api-keys/{id}", {
            params: { path: { id } },
          }),
        );
        ctx.emit(undefined, () => `revoked ${id}`);
      }),
    );
  program
    .command("key-status")
    .description("Read current delegated key authorization status")
    .action(async () =>
      safely(async () => {
        if (!ctx.keyMode())
          throw new UsageError("key-status requires --credential-file or ANT0_API_KEY");
        const client = ctx.client();
        const grant = (await ctx.keyGrant())!;
        const data = projectGrantStatus(unwrap(await client.GET("/v1/automation/status")), grant);
        ctx.emit(data, () => keyValues(flatten(data)));
      }),
    );
}
