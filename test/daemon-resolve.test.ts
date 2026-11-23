import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveDaemonCommand } from "../src/commands/daemon.js";
import { CliError } from "../src/errors.js";
import { versionSkewWarning } from "../src/version.js";

const root = mkdtempSync(join(tmpdir(), "ant0-resolve-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeFile(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("resolveDaemonCommand", () => {
  it("prefers ANT0D_BIN over PATH and runs a .js file under this Node", () => {
    const bin = fakeFile("env", "ant0d.js");
    const onPath = fakeFile("path", "ant0d");
    const env = { ANT0D_BIN: bin, PATH: join(onPath, "..") };
    expect(resolveDaemonCommand(undefined, env, "linux")).toEqual({
      command: process.execPath,
      args: [bin],
    });
    const exe = fakeFile("env", "ant0d");
    expect(resolveDaemonCommand(undefined, { ...env, ANT0D_BIN: exe }, "linux")).toEqual({
      command: exe,
      args: [],
    });
  });

  it("refuses a relative or missing ANT0D_BIN instead of falling back", () => {
    const onPath = fakeFile("path2", "ant0d");
    const PATH = join(onPath, "..");
    expect(() => resolveDaemonCommand(undefined, { ANT0D_BIN: "ant0d", PATH }, "linux")).toThrow(
      "absolute",
    );
    expect(() =>
      resolveDaemonCommand(undefined, { ANT0D_BIN: join(root, "nope"), PATH }, "linux"),
    ).toThrow("does not exist");
  });

  it("finds ant0d on PATH, then the desktop install, then fails clearly", () => {
    const onPath = fakeFile("path3", "ant0d");
    expect(
      resolveDaemonCommand(
        undefined,
        { PATH: ["/nonexistent", join(onPath, "..")].join(delimiter) },
        "linux",
      ),
    ).toEqual({ command: onPath, args: [] });
    const installed = fakeFile("local", "Programs", "Ant0", "ant0d.exe");
    expect(
      resolveDaemonCommand(undefined, { PATH: "", LOCALAPPDATA: join(root, "local") }, "win32"),
    ).toEqual({ command: installed, args: [] });
    expect(() => resolveDaemonCommand(undefined, { PATH: "" }, "win32")).toThrow(CliError);
    expect(() => resolveDaemonCommand(undefined, { PATH: "" }, "win32")).toThrow("ANT0D_BIN");
  });
});

describe("versionSkewWarning", () => {
  it("warns only when major.minor differ", () => {
    expect(versionSkewWarning("0.3.22", "0.3.21")).toBeUndefined();
    expect(versionSkewWarning("0.3.22-beta.2", "0.3.9")).toBeUndefined();
    expect(versionSkewWarning("0.4.0", "0.3.22")).toContain("daemon is version 0.4.0");
    expect(versionSkewWarning("1.0.0", "0.3.22")).toContain("this CLI is 0.3.22");
    expect(versionSkewWarning("test", "0.3.22")).toBeUndefined();
  });
});
