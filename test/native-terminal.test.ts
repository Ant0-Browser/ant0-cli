import { EventEmitter } from "node:events";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "../src/context.js";
import {
  openNativeTerminal,
  terminalDevicePaths,
  type TerminalInput,
} from "../src/native-terminal.js";

describe("terminalDevicePaths", () => {
  it("uses the Windows console device namespace, read+write", () => {
    expect(terminalDevicePaths("win32")).toEqual({
      input: "\\\\.\\CONIN$",
      inputFlags: "r+",
      output: "\\\\.\\CONOUT$",
      outputFlags: "r+",
    });
  });

  it.each(["linux", "darwin", "freebsd"] as const)("uses /dev/tty on %s", (platform) => {
    expect(terminalDevicePaths(platform)).toEqual({
      input: "/dev/tty",
      inputFlags: "r",
      output: "/dev/tty",
      outputFlags: "w",
    });
  });
});

class FakeStdin extends EventEmitter implements TerminalInput {
  isTTY: boolean | undefined = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  paused = false;
  destroyed = false;
  failRaw: "throw" | "event" | undefined;
  setRawMode(mode: boolean): this {
    this.rawCalls.push(mode);
    if (mode && this.failRaw === "throw") {
      throw Object.assign(new Error("setRawMode EPERM"), { code: "EPERM" });
    }
    if (mode && this.failRaw === "event") {
      queueMicrotask(() =>
        this.emit(
          "error",
          Object.assign(new Error("EPERM setRawMode"), { code: "EPERM", syscall: "setRawMode" }),
        ),
      );
    }
    this.isRaw = mode;
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

describe("openNativeTerminal on win32", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const file of files.splice(0)) rmSync(file, { force: true });
  });

  function open(stdin: FakeStdin) {
    const opened: string[] = [];
    const output = join(tmpdir(), `ant0-native-terminal-${process.pid}-${files.length}`);
    files.push(output);
    const terminal = openNativeTerminal("win32", {
      stdin,
      open: (path, flags) => {
        opened.push(path);
        return openSync(output, flags === "r+" ? "w+" : flags);
      },
      close: closeSync,
      isTty: () => true,
    });
    return { terminal, opened, output };
  }

  it("never opens CONIN$ and throws when stdin is not a TTY", () => {
    const stdin = new FakeStdin();
    stdin.isTTY = undefined;
    const opened: string[] = [];
    expect(() =>
      openNativeTerminal("win32", {
        stdin,
        open: (path) => {
          opened.push(path);
          return 99;
        },
      }),
    ).toThrow();
    expect(opened).toEqual([]);
  });

  it("shows the existing fallback through withNativeTerminal", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    try {
      const ctx = new Context({
        stdout: { write: () => true },
        stderr: { write: () => true },
        env: {},
      } as never);
      await expect(ctx.withNativeTerminal("sync key recovery", async () => 1)).rejects.toThrow(
        "sync key recovery requires the desktop app or a controlling terminal. Run this in a terminal window, or use the app.",
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("reads from a TTY stdin, restores raw mode and leaves stdin open on close", async () => {
    const stdin = new FakeStdin();
    const { terminal, opened, output } = open(stdin);
    expect(opened).toEqual(["\\\\.\\CONOUT$"]);
    const pending = terminal.readSecret("Code: ");
    stdin.emit("data", Buffer.from("ab\x7fc\r"));
    const value = await pending;
    expect(value.toString()).toBe("ac");
    expect(stdin.rawCalls).toEqual([true, false]);
    expect(stdin.paused).toBe(true);
    terminal.close();
    expect(stdin.destroyed).toBe(false);
    expect(stdin.listenerCount("error")).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("Code: \n");
  });

  it("aborts on Ctrl-C", async () => {
    const stdin = new FakeStdin();
    const { terminal } = open(stdin);
    const pending = terminal.readSecret("");
    stdin.emit("data", Buffer.from("a\x03"));
    await expect(pending).rejects.toThrow("aborted");
    terminal.close();
  });

  it("reports a setRawMode error event with step and code, restoring raw mode", async () => {
    const stdin = new FakeStdin();
    stdin.failRaw = "event";
    const { terminal } = open(stdin);
    await expect(terminal.readSecret("")).rejects.toThrow(
      "could not read from the controlling terminal (setRawMode: EPERM)",
    );
    expect(stdin.rawCalls.at(-1)).toBe(false);
    terminal.close();
  });

  it("reports a synchronous setRawMode throw with step and code", async () => {
    const stdin = new FakeStdin();
    stdin.failRaw = "throw";
    const { terminal } = open(stdin);
    await expect(terminal.readSecret("")).rejects.toThrow(
      "could not read from the controlling terminal (setRawMode: EPERM)",
    );
    expect(stdin.rawCalls.at(-1)).toBe(false);
    terminal.close();
  });

  it("reports a stream error during read with step and code, never input", async () => {
    const stdin = new FakeStdin();
    const { terminal } = open(stdin);
    const pending = terminal.readSecret("");
    stdin.emit("data", Buffer.from("hunter2"));
    stdin.emit("error", Object.assign(new Error("boom hunter2"), { code: "EIO" }));
    const error = await pending.catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "could not read from the controlling terminal (read: EIO)",
    );
    terminal.close();
  });

  it("survives a late error after the prompt finished", async () => {
    const stdin = new FakeStdin();
    const { terminal } = open(stdin);
    const pending = terminal.readSecret("");
    stdin.emit("data", Buffer.from("x\n"));
    await pending;
    expect(() => stdin.emit("error", new Error("late"))).not.toThrow();
    terminal.close();
  });
});
