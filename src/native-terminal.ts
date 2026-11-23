/** Direct controlling-terminal I/O for secrets that must never use redirected process streams. */
import { closeSync, openSync, writeSync } from "node:fs";
import { isatty, ReadStream } from "node:tty";
import { UsageError } from "./errors.js";

export interface NativeTerminal {
  readSecret(question: string): Promise<Buffer>;
  writeLine(text: string): void;
  writeSecret(label: string, value: Uint8Array): void;
  close(): void;
}

/** The subset of a TTY read stream the secret prompt needs (a `tty.ReadStream` or `process.stdin`). */
export interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  destroy(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/** Overrides for tests; production code uses the defaults. */
export interface OpenNativeTerminalOptions {
  /** Process stdin; on Windows it is the secret input, but only when it is a real console. */
  stdin?: TerminalInput;
  open?: (path: string, flags: string) => number;
  close?: (fd: number) => void;
  isTty?: (fd: number) => boolean;
}

const READ_FAILURE = "could not read from the controlling terminal";

/** Step plus errno code only; never anything derived from input bytes. */
function readFailure(step: string, error: unknown): UsageError {
  const failure = error as { code?: unknown; syscall?: unknown; message?: unknown } | null;
  const code =
    typeof failure?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(failure.code)
      ? failure.code
      : "unknown";
  const failedStep =
    failure?.syscall === "setRawMode" ||
    (typeof failure?.message === "string" && failure.message.includes("setRawMode"))
      ? "setRawMode"
      : step;
  return new UsageError(`${READ_FAILURE} (${failedStep}: ${code})`);
}

class DeviceTerminal implements NativeTerminal {
  private closed = false;
  /** Keeps a late stream error (after a prompt finished) from becoming an uncaught exception. */
  private readonly swallowError = () => {};

  constructor(
    private readonly input: TerminalInput,
    private readonly outputFd: number,
    /** False for process.stdin, which is shared and must be left open. */
    private readonly ownsInput: boolean,
    private readonly closeFd: (fd: number) => void = closeSync,
  ) {
    input.on("error", this.swallowError);
  }

  private write(value: string | Uint8Array): void {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(this.outputFd, bytes, offset, bytes.byteLength - offset);
    }
  }

  async readSecret(question: string): Promise<Buffer> {
    if (this.closed) throw new UsageError("controlling terminal is closed");
    const input = this.input;
    const wasRaw = input.isRaw;
    const value = Buffer.alloc(1024);
    let length = 0;
    this.write(question);

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        input.off("data", onData);
        input.off("error", onError);
        input.off("end", onEnd);
        input.off("close", onClose);
        let finalError = error;
        try {
          input.setRawMode(wasRaw === true);
        } catch {
          finalError ??= new UsageError("could not restore the controlling terminal");
        }
        input.pause();
        try {
          this.write("\n");
        } catch {
          finalError ??= new UsageError("could not write to the controlling terminal");
        }
        if (finalError) {
          value.fill(0);
          reject(finalError);
          return;
        }
        const result = Buffer.from(value.subarray(0, length));
        value.fill(0);
        resolve(result);
      };
      const onError = (error: unknown) => finish(readFailure("read", error));
      const onEnd = () => finish(new UsageError("controlling terminal closed before input"));
      const onClose = () => finish(new UsageError("controlling terminal closed before input"));
      const onData = (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        try {
          for (const byte of bytes) {
            if (byte === 0x0d || byte === 0x0a) return finish();
            if (byte === 0x03 || byte === 0x04) return finish(new UsageError("aborted"));
            if (byte === 0x08 || byte === 0x7f) {
              if (length > 0) value[--length] = 0;
              continue;
            }
            if (byte < 0x20 || byte > 0x7e) {
              return finish(new UsageError("secret input must contain printable ASCII only"));
            }
            if (length === value.length) {
              return finish(new UsageError("secret input is too long"));
            }
            value[length++] = byte;
          }
        } finally {
          bytes.fill(0);
        }
      };
      // Listeners first: Node reports a failed setRawMode as an 'error' event, which would
      // otherwise be thrown or lost.
      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
      input.once("close", onClose);
      try {
        input.setRawMode(true);
        input.resume();
      } catch (error) {
        finish(readFailure("setRawMode", error));
      }
    });
  }

  writeLine(text: string): void {
    if (this.closed) throw new UsageError("controlling terminal is closed");
    this.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  writeSecret(label: string, value: Uint8Array): void {
    if (this.closed) throw new UsageError("controlling terminal is closed");
    this.write(label);
    this.write(value);
    this.write("\n");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.input.isRaw) this.input.setRawMode(false);
    } finally {
      try {
        if (this.ownsInput) this.input.destroy();
        else this.input.pause();
        this.input.off("error", this.swallowError);
      } finally {
        this.closeFd(this.outputFd);
      }
    }
  }
}

export interface TerminalDevicePaths {
  input: string;
  /** `fs.open` flags for the input device. */
  inputFlags: string;
  output: string;
  /** `fs.open` flags for the output device. */
  outputFlags: string;
}

/**
 * Console device paths per platform. Windows needs the `\\.\` device namespace: under Node a bare
 * `CONIN$` fails with ENOENT and `CONOUT$` opened write-only (create/truncate) with EPERM. Both
 * are opened read+write without create/truncate: `CONIN$` opened read-only lacks the access
 * `setRawMode` needs (EPERM). {@link openNativeTerminal} does not open `CONIN$` on Windows at all
 * (it uses a TTY `process.stdin`), but the path stays correct for any caller that does.
 */
export function terminalDevicePaths(platform: NodeJS.Platform): TerminalDevicePaths {
  if (platform === "win32") {
    return {
      input: "\\\\.\\CONIN$",
      inputFlags: "r+",
      output: "\\\\.\\CONOUT$",
      outputFlags: "r+",
    };
  }
  return { input: "/dev/tty", inputFlags: "r", output: "/dev/tty", outputFlags: "w" };
}

/**
 * Open `/dev/tty`, or on Windows the console. A hidden console (for example a non-pty SSH session)
 * still opens as `CONIN$` but nobody can type into it, so on Windows the secret input is
 * `process.stdin` only when it is itself a TTY (the real console, not a redirect); otherwise this
 * throws and the caller shows its "needs a terminal" message.
 */
export function openNativeTerminal(
  platform: NodeJS.Platform = process.platform,
  options: OpenNativeTerminalOptions = {},
): NativeTerminal {
  const open = options.open ?? openSync;
  const closeFd = options.close ?? closeSync;
  const isTty = options.isTty ?? isatty;
  const paths = terminalDevicePaths(platform);
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  try {
    let input: TerminalInput;
    let ownsInput: boolean;
    if (platform === "win32") {
      const stdin = options.stdin ?? (process.stdin as unknown as TerminalInput);
      if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
        throw new Error("stdin is not a console");
      }
      input = stdin;
      ownsInput = false;
    } else {
      inputFd = open(paths.input, paths.inputFlags);
      const stream = new ReadStream(inputFd);
      inputFd = undefined;
      input = stream;
      ownsInput = true;
    }
    outputFd = open(paths.output, paths.outputFlags);
    if (!input.isTTY || !isTty(outputFd)) {
      if (ownsInput) input.destroy();
      throw new Error("terminal device is not a TTY");
    }
    const terminal = new DeviceTerminal(input, outputFd, ownsInput, closeFd);
    outputFd = undefined;
    return terminal;
  } catch (error) {
    if (inputFd !== undefined) closeFd(inputFd);
    if (outputFd !== undefined) closeFd(outputFd);
    throw error;
  }
}
