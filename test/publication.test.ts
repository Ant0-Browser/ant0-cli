import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mockDaemon } from "./mcp-helpers.js";
import { expectedContext, metadata, privateTestDirectory, readyFile } from "./mcp-key-helpers.js";
import { readCredentialFile, saveCredentialFile } from "@ant0/mcp/credentials";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/credential-faults.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, bin, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  return new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
}
async function fixture(barrier = false) {
  const bodies: any[] = [];
  const keys = new Map<string, ReturnType<typeof metadata>>();
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const daemon = await mockDaemon(async (req, res) => {
    if (req.method === "GET") return void res.end(JSON.stringify(expectedContext));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    let key = keys.get(body.create.id);
    if (!key) {
      key = metadata(body.create);
      keys.set(body.create.id, key);
    }
    const ordinal = bodies.length;
    if (barrier) {
      if (ordinal === 2) release();
      await both;
    }
    res.end(
      JSON.stringify({
        key: {
          ...key,
          name: `Observation ${ordinal}`,
          ...(ordinal > 1 ? { status: "revoked", revoked_at: new Date().toISOString() } : {}),
        },
      }),
    );
  });
  cleanups.push(daemon.close);
  privateTestDirectory(daemon.home);
  const path = join(daemon.home, "key.json");
  return {
    daemon,
    path,
    bodies,
    args: [
      "--home",
      daemon.home,
      "--json",
      "api-keys",
      "create",
      "Publication",
      "--preset",
      "read",
      "--credential-file",
      path,
    ],
    env: { ANT0_TEST_CREDENTIAL: path, ANT0_TEST_TRACE: join(daemon.home, "trace") },
  };
}
describe("immutable publication through real CLI processes", () => {
  it.skipIf(process.platform === "win32")(
    "receipt flush failure prevents durable success and later replay preserves both published files",
    async () => {
      const f = await fixture();
      const failed = await cli(f.args, { ...f.env, ANT0_TEST_FAULT: "eio-result" });
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      const original = readFileSync(f.path);
      const receipt = readFileSync(`${f.path}.result.json`);
      expect(f.bodies).toHaveLength(1);
      const replay = await cli(f.args, f.env);
      expect(replay.code, replay.stderr).toBe(0);
      expect(f.bodies).toHaveLength(2);
      expect(readFileSync(f.path)).toEqual(original);
      expect(readFileSync(`${f.path}.result.json`)).toEqual(receipt);
      expect(JSON.parse(replay.stdout).key).toMatchObject({
        name: "Observation 2",
        status: "revoked",
      });
    },
  );
  it
    .skipIf(process.platform === "win32")
    .each(
      ["credential", "result"].flatMap((kind) =>
        [
          "before-link",
          "after-link",
          "before-unlink",
          "after-unlink",
          "before-directory",
          "after-directory",
        ].map((stage) => ({ kind, stage })),
      ),
    )(
    "recovers SIGKILL $stage for $kind without PID locks or credential rewrites",
    async ({ kind, stage }) => {
      const f = await fixture();
      const killed = await cli(f.args, { ...f.env, ANT0_TEST_KIND: kind, ANT0_TEST_STAGE: stage });
      expect(killed.signal, killed.stderr).toBe("SIGKILL");
      expect(existsSync(`${f.path}.lock`)).toBe(false);
      const bytes = existsSync(f.path) ? readFileSync(f.path) : undefined;
      const receipt = existsSync(`${f.path}.result.json`)
        ? readFileSync(`${f.path}.result.json`)
        : undefined;
      const orphans = readdirSync(f.daemon.home).filter(
        (name) => name.endsWith(".tmp") && statSync(join(f.daemon.home, name)).nlink === 1,
      );
      const result = await cli(f.args, f.env);
      expect(result.code, result.stderr).toBe(0);
      if (bytes) expect(readFileSync(f.path)).toEqual(bytes);
      if (receipt) expect(readFileSync(`${f.path}.result.json`)).toEqual(receipt);
      for (const orphan of orphans) expect(existsSync(join(f.daemon.home, orphan))).toBe(true);
      const current = readCredentialFile(f.path);
      expect(current.rawValue.phase).toBe("pending");
      expect(current.value.phase).toBe("ready");
      expect(statSync(f.path).nlink).toBe(1);
      expect(statSync(`${f.path}.result.json`).nlink).toBe(1);
      if (kind === "result") {
        expect(f.bodies).toHaveLength(2);
        expect(f.bodies[1]).toEqual(f.bodies[0]);
      }
      expect(result.stdout + result.stderr).not.toContain(current.value.create.credential);
    },
    30_000,
  );
  it("concurrent provisioners share exact replay and first receipt while returning their own live metadata", async () => {
    const f = await fixture(true);
    // A legacy unknown/empty lock is not reclaimed and does not participate in correctness.
    writeFileSync(`${f.path}.lock`, "", { mode: 0o600 });
    const results = await Promise.all([cli(f.args, f.env), cli(f.args, f.env)]);
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[1]).toEqual(f.bodies[0]);
    expect(results.map((r) => JSON.parse(r.stdout).key.name).sort()).toEqual([
      "Observation 1",
      "Observation 2",
    ]);
    const snapshot = readCredentialFile(f.path);
    const receipt = readFileSync(`${f.path}.result.json`);
    expect(JSON.parse(receipt.toString()).key).toEqual(snapshot.value.key);
    const third = await cli(f.args, f.env);
    expect(third.code, third.stderr).toBe(0);
    expect(JSON.parse(third.stdout).key).toMatchObject({
      name: "Observation 3",
      status: "revoked",
    });
    expect(readFileSync(`${f.path}.result.json`)).toEqual(receipt);
    expect(readFileSync(f.path)).toEqual(snapshot.bytes);
    expect(readFileSync(`${f.path}.lock`, "utf8")).toBe("");
  }, 30_000);
  it.skipIf(process.platform === "win32")(
    "a changed credential at receipt publication is preserved and the wrong source hash fails",
    async () => {
      const f = await fixture();
      const other = readyFile();
      other.create.name = "Other owner record";
      const replacement = join(f.daemon.home, "replacement.json");
      saveCredentialFile(replacement, { ...other, phase: "pending", key: null });
      const originalReplacement = readFileSync(replacement);
      const result = await cli(f.args, { ...f.env, ANT0_TEST_SWAP_SOURCE: replacement });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readFileSync(f.path)).toEqual(originalReplacement);
      expect(() => readCredentialFile(f.path)).toThrow();
      const receipt = JSON.parse(readFileSync(`${f.path}.result.json`, "utf8"));
      expect(receipt.credential_file_sha256).not.toBe(
        createHash("sha256").update(originalReplacement).digest("hex"),
      );
    },
  );
});
