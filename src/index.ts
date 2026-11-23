/**
 * `@ant0/cli`: the `ant0` command. `run(argv, io)` executes one invocation in-process and returns
 * the exit code; `bin.ts` is the executable wrapper around it.
 */
import { Context, type RunIo } from "./context.js";
import { describeError, EXIT_OK } from "./errors.js";
import { buildProgram } from "./program.js";
import type { RuntimeCommands } from "./runtime-types.js";

export type { RunIo, Writer, GlobalOptions } from "./context.js";
export type { NativeTerminal } from "./native-terminal.js";
export {
  CliError,
  DaemonNotRunningError,
  UsageError,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_USAGE,
  EXIT_NOT_RUNNING,
  describeError,
} from "./errors.js";
export { table, keyValues, flatten } from "./format.js";
export { parseSetArgs, parseSetPair, parseSetValue } from "./set.js";
export { buildProgram, CLI_VERSION } from "./program.js";

/**
 * Run `ant0 <argv...>` (user arguments only, no node/script prefix). Never throws and never calls
 * `process.exit`; errors are written to `io.stderr` as `ant0: <message>` and mapped to the
 * exit codes (0 ok, 1 error, 2 usage, 3 daemon not running).
 */
export async function run(
  argv: readonly string[],
  io: RunIo,
  runtime?: RuntimeCommands,
): Promise<number> {
  const ctx = new Context(io, runtime);
  const program = buildProgram(ctx);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return EXIT_OK;
  } catch (err) {
    const { lines, exitCode } = describeError(err);
    if (lines.length > 0) {
      const [first, ...rest] = lines;
      io.stderr.write(`ant0: ${first}\n`);
      for (const line of rest) io.stderr.write(`${line}\n`);
    }
    return exitCode;
  }
}
