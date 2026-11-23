/**
 * The `ant0` command tree. Commander is configured to never call
 * `process.exit` and to write through the injected streams, so `run()` is testable in-process.
 */
import { Command, InvalidArgumentError, type ParseOptions } from "commander";
import { Readable, Writable } from "node:stream";
import { registerAccount } from "./commands/account.js";
import { registerBrowsers } from "./commands/browsers.js";
import { registerDaemon } from "./commands/daemon.js";
import { registerEvents } from "./commands/events.js";
import { registerExtensions } from "./commands/extensions.js";
import { registerProfiles } from "./commands/profiles.js";
import { registerProxies } from "./commands/proxies.js";
import { registerSync } from "./commands/sync.js";
import { registerTeam } from "./commands/team.js";
import { registerTrash } from "./commands/trash.js";
import { registerWorkspace } from "./commands/workspace.js";
import { registerApiKeys } from "./commands/api-keys.js";
import { Context, type GlobalOptions } from "./context.js";
import { CLI_VERSION } from "./version.js";

export { CLI_VERSION };
import { CliError, DaemonNotRunningError, UsageError } from "./errors.js";

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError("expected a port number (1-65535)");
  }
  return n;
}

const API_KEY_ARGV =
  "API keys are not accepted as arguments; set ANT0_API_KEY or pipe the key with --api-key-stdin";

function rejectSecretArgv(argv: readonly string[], options?: ParseOptions): void {
  const args = argv.slice(options?.from === "user" ? 0 : 2);
  if (
    args.some((arg) => arg === "--api-key" || arg.startsWith("--api-key=") || /ant0_sk_/i.test(arg))
  )
    throw new UsageError(API_KEY_ARGV);
}

const FILE_KEY_COMMANDS = [
  "profiles ls",
  "profiles run",
  "profiles start",
  "profiles stop",
  "profiles status",
  "proxies ls",
  "key-status",
  "mcp serve",
  "api-keys create",
];
const API_KEY_COMMANDS = FILE_KEY_COMMANDS.filter((name) => name !== "api-keys create");

class Ant0Command extends Command {
  mcpInvocation = false;

  private rememberInvocation(argv: readonly string[] = process.argv, options?: ParseOptions): void {
    this.mcpInvocation = false;
    for (let i = options?.from === "user" ? 0 : 2; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--home" || arg === "--port" || arg === "--credential-file") {
        i++;
        continue;
      }
      if (arg.startsWith("-")) continue;
      this.mcpInvocation = arg === "mcp";
      break;
    }
  }

  override parse(argv?: readonly string[], options?: ParseOptions): this {
    rejectSecretArgv(argv ?? process.argv, options);
    this.rememberInvocation(argv, options);
    return super.parse(argv, options);
  }

  override parseAsync(argv?: readonly string[], options?: ParseOptions): Promise<this> {
    rejectSecretArgv(argv ?? process.argv, options);
    this.rememberInvocation(argv, options);
    return super.parseAsync(argv, options);
  }
}

export function buildProgram(ctx: Context): Command {
  let mcpParseDiagnostic = false;
  const program = new Ant0Command("ant0")
    .description("Ant0: profile manager for Ant0 Browser (client of the local ant0d daemon)")
    .version(CLI_VERSION, "-V, --version", "print the CLI version")
    .option("--home <dir>", "data directory (default: $ANT0_HOME, else the platform data folder)")
    .option("--port <n>", "daemon port (default: from ant0d.pid, $ANT0D_PORT or 27100)", parsePort)
    .option("--json", "print the API payload verbatim instead of a table")
    .option(
      "--credential-file <path>",
      "private API-key file for supported reads, profile operations or creation recovery",
    )
    .option("--api-key-stdin", "read an API key from the first line of stdin (or set ANT0_API_KEY)")
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => ctx.io.stdout.write(str),
      writeErr: (str) => {
        // Commander normally echoes invalid option values. In MCP mode keep even pre-start
        // parse failures bounded and independent of user-supplied paths/credentials.
        if (!program.mcpInvocation) ctx.io.stderr.write(str);
        else if (!mcpParseDiagnostic) {
          mcpParseDiagnostic = true;
          ctx.io.stderr.write("ant0: mcp: invalid command arguments\n");
        }
      },
    });

  // Subcommands created with `.command()` inherit exitOverride/configureOutput; the global flags
  // may appear anywhere on the line and are read from the root when a command runs.
  ctx.bindGlobals(() => program.opts<GlobalOptions>());
  program.hook("preAction", async (_root, action) => {
    const globals = ctx.globals;
    const fileKey = globals.credentialFile !== undefined;
    const envKey = ctx.io.env.ANT0_API_KEY !== undefined;
    const stdinKey = globals.apiKeyStdin === true;
    if (!fileKey && !envKey && !stdinKey) return;
    if ([fileKey, envKey, stdinKey].filter(Boolean).length > 1)
      throw new UsageError("use only one of --credential-file, ANT0_API_KEY and --api-key-stdin");
    const names: string[] = [];
    for (let node: Command | null = action; node && node !== program; node = node.parent)
      names.unshift(node.name());
    const command = names.join(" ");
    if (!(fileKey ? FILE_KEY_COMMANDS : API_KEY_COMMANDS).includes(command))
      throw new UsageError(
        fileKey
          ? "credential file is not supported for this command"
          : "an API key is not supported for this command; unset ANT0_API_KEY to use the local token",
      );
    if (stdinKey) {
      if (command === "mcp serve")
        throw new UsageError(
          "mcp serve reads its API key from ANT0_API_KEY; stdin carries the MCP protocol",
        );
      ctx.apiKey = await ctx.readStdinLine();
    }
  });

  // A host may replace the `daemon` group with its own lifecycle commands.
  if (ctx.runtime?.registerLifecycle) ctx.runtime.registerLifecycle(program, ctx);
  else registerDaemon(program, ctx);
  registerBrowsers(program, ctx);
  registerProfiles(program, ctx);
  registerTrash(program, ctx);
  registerProxies(program, ctx);
  registerExtensions(program, ctx);
  registerEvents(program, ctx);
  registerAccount(program, ctx);
  registerWorkspace(program, ctx);
  registerSync(program, ctx);
  registerTeam(program, ctx);
  registerApiKeys(program, ctx);

  program
    .command("mcp")
    .description(
      "Local MCP server: identity and inventory reads, profile run/stop, cookie and export tools, " +
        "and beta page actions (snapshot, navigate, click, type, fill, select, keys, wait, " +
        "screenshot, text, tabs); local connection only",
    )
    .command("serve")
    .description("Serve MCP over stdio using an already-running local daemon")
    .option("--stdio", "use the stdio MCP transport (required)")
    .action(async (options: { stdio?: boolean }) => {
      if (!options.stdio) throw new UsageError("mcp serve requires --stdio");
      if (ctx.json) throw new UsageError("mcp serve does not accept --json");
      const stdin = ctx.io.stdin ?? process.stdin;
      if (!(stdin instanceof Readable) || !(ctx.io.stdout instanceof Writable)) {
        throw new CliError("mcp: stdio streams required");
      }
      let mcp: typeof import("@ant0/mcp") | undefined;
      try {
        mcp = await import("@ant0/mcp");
        await mcp.serveStdio(
          {
            ...(ctx.globals.home !== undefined ? { home: ctx.globals.home } : {}),
            ...(ctx.globals.port !== undefined ? { port: ctx.globals.port } : {}),
            ...(ctx.globals.credentialFile !== undefined
              ? { credentialFile: ctx.globals.credentialFile }
              : {}),
            env: ctx.io.env,
            stdin,
            stdout: ctx.io.stdout,
            ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
          },
          ctx.runtime?.outputWorker,
        );
      } catch (error) {
        if (mcp && error instanceof mcp.McpFailure) {
          if (error.code === "unavailable")
            throw new DaemonNotRunningError("mcp: local daemon unavailable");
          throw new CliError(`mcp: ${error.message}`);
        }
        throw new CliError("mcp: adapter failed");
      }
    });

  return program;
}
