import type { Command } from "commander";
import type { OutputWorkerCommand } from "@ant0/mcp";
import type { Context } from "./context.js";

/** A program and its leading arguments, spawned to start the daemon. */
export interface DaemonCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Hooks for an embedding host that supplies its own daemon launcher and lifecycle commands. The
 * ordinary CLI passes none: it starts the daemon found by `resolveDaemonCommand` and registers
 * the built-in `daemon` command group.
 */
export interface RuntimeCommands {
  readonly daemon: DaemonCommand;
  readonly outputWorker: OutputWorkerCommand;
  /** Registers the host's lifecycle commands in place of the built-in `daemon` group. */
  readonly registerLifecycle?: (program: Command, ctx: Context) => void;
}
