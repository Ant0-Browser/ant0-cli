/** Account workspace selection over the daemon's persisted cloud session. */
import { unwrap, type components, type paths } from "../api/index.js";
import { InvalidArgumentError, type Command } from "commander";
import type { Context } from "../context.js";
import { keyValues, table } from "../format.js";

type LicenceState = components["schemas"]["LicenceState"];
type WorkspaceList =
  paths["/v1/workspaces"]["get"]["responses"][200]["content"]["application/json"];
type Workspace = WorkspaceList["workspaces"][number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function workspaceId(value: string): string {
  if (!UUID_RE.test(value)) throw new InvalidArgumentError("expected a lowercase canonical UUID");
  return value;
}

export function activeWorkspaceLine(workspace: LicenceState["workspace"]): string {
  return workspace === null
    ? "active workspace  unavailable (run `ant0 workspace list`)"
    : `active workspace  ${workspace.name ?? "-"} (${workspace.id})`;
}

export async function printActiveWorkspace(ctx: Context): Promise<void> {
  const licence = unwrap(await ctx.client().GET("/v1/licence"));
  if (!ctx.json) ctx.out(activeWorkspaceLine(licence.workspace));
}

function workspaceRows(result: WorkspaceList) {
  return result.workspaces.map((workspace: Workspace) => [
    workspace.id === result.current_workspace_id ? "*" : "",
    workspace.id,
    workspace.name,
    workspace.role,
    workspace.status,
    workspace.usability,
    workspace.plan.id,
    workspace.plan.profiles,
    workspace.seats,
  ]);
}

export function registerWorkspace(program: Command, ctx: Context): void {
  const workspace = program.command("workspace").description("List and select account workspaces");

  workspace
    .command("list")
    .alias("ls")
    .description("List workspaces available to the signed-in account")
    .action(async () => {
      const result = unwrap(await ctx.client().GET("/v1/workspaces"));
      ctx.emit(
        result,
        () =>
          `${keyValues([
            ["account", `${result.account.email} (${result.account.id})`],
            ["current workspace", result.current_workspace_id],
          ])}\n\n${table(
            ["current", "id", "name", "role", "status", "usability", "plan", "profiles", "seats"],
            workspaceRows(result),
          )}`,
      );
    });

  workspace
    .command("switch")
    .description("Switch this daemon session to another usable workspace")
    .argument("<id>", "workspace UUID", workspaceId)
    .action(async (id: string) => {
      const result = unwrap(
        await ctx.client().POST("/v1/workspaces/current", { body: { workspace_id: id } }),
      );
      ctx.emit(result, () => activeWorkspaceLine(result.workspace));
    });
}
