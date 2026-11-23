/**
 * Exit codes: 0 ok, 1 error, 2 usage, 3 daemon not running,
 * 4 the Ant0 app manages the background service.
 * Every failure funnels through `describeError`, which maps a thrown value onto a message for
 * stderr and one of those codes.
 */
import { CommanderError } from "commander";
import { isAnt0ApiError } from "./api/index.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_RUNNING = 3;
export const EXIT_APP_MANAGED = 4;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_ERROR,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
  }
}

let startCommand = "ant0 daemon start";

/** A host with its own lifecycle commands names its start command in the "not running" hint. */
export function setStartCommand(command: string): void {
  startCommand = command;
}

export function notRunningMessage(): string {
  return `daemon not running (start it with \`${startCommand}\`)`;
}

export class DaemonNotRunningError extends CliError {
  constructor(message = notRunningMessage()) {
    super(message, EXIT_NOT_RUNNING);
  }
}

/** `fetch` rejected because nothing listens on the daemon port (Node wraps it in `cause`). */
export function isConnectionRefused(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const e = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (e.code === "ECONNREFUSED") return true;
    if (Array.isArray(e.errors) && e.errors.some((inner) => visit(inner))) return true;
    return visit(e.cause);
  };
  return visit(err);
}

export interface DescribedError {
  /** Lines for stderr, without the `ant0: ` prefix on the first one. Empty = print nothing. */
  lines: string[];
  exitCode: number;
}

/** Render Ajv issues (`details` of a 400) as one indented line each. */
function detailLines(details: unknown): string[] {
  if (!Array.isArray(details)) {
    return details === undefined ? [] : [`  ${JSON.stringify(details)}`];
  }
  return details.map((issue) => {
    if (issue === null || typeof issue !== "object") return `  ${String(issue)}`;
    const d = issue as { instancePath?: unknown; path?: unknown; message?: unknown };
    const where =
      typeof d.instancePath === "string" && d.instancePath.length > 0
        ? d.instancePath.replace(/^\//, "").replaceAll("/", ".")
        : typeof d.path === "string" && d.path.length > 0
          ? d.path
          : "(body)";
    const message = typeof d.message === "string" ? d.message : JSON.stringify(issue);
    return `  ${where}: ${message}`;
  });
}

export function describeError(err: unknown): DescribedError {
  if (err instanceof CommanderError) {
    // Commander already wrote its message (help, version, or the usage error).
    const informational =
      err.code === "commander.helpDisplayed" ||
      err.code === "commander.version" ||
      err.exitCode === 0;
    return { lines: [], exitCode: informational ? EXIT_OK : EXIT_USAGE };
  }
  if (err instanceof CliError) return { lines: [err.message], exitCode: err.exitCode };
  if (isAnt0ApiError(err)) {
    const lines = [`${err.code}: ${err.message}`];
    if (err.status === 400) lines.push(...detailLines(err.details));
    return { lines, exitCode: EXIT_ERROR };
  }
  if (isConnectionRefused(err)) return { lines: [notRunningMessage()], exitCode: EXIT_NOT_RUNNING };
  if (err instanceof Error) return { lines: [err.message], exitCode: EXIT_ERROR };
  return { lines: [String(err)], exitCode: EXIT_ERROR };
}
