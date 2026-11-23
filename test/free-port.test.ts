import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeFreePort, withFreePort } from "./free-port.js";

const held: Server[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function occupy(port: number): Promise<void> {
  const s = createServer();
  held.push(s);
  await new Promise<void>((resolve) => s.listen(port, "127.0.0.1", resolve));
}

/** A stand-in for `ant0 --port N daemon start`: fails when something else owns the port. */
async function fakeDaemonStart(port: number): Promise<{ code: number }> {
  const s = createServer();
  held.push(s);
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", resolve);
    });
    return { code: 0 };
  } catch {
    return { code: 1 };
  }
}

describe("withFreePort (#96)", () => {
  it("retries on a fresh port when another process takes the probed port before the bind", async () => {
    const picks: number[] = [];
    const pick = async () => {
      const p = await probeFreePort();
      picks.push(p);
      // Another process grabs the first probed port between the probe and the bind.
      if (picks.length === 1) await occupy(p);
      return p;
    };
    const r = await withFreePort(fakeDaemonStart, { pick, lostPort: (x) => x.code !== 0 });
    expect(r.result.code).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.port).toBe(picks[1]);
    expect(picks[1]).not.toBe(picks[0]);
  });

  it("without retry the lost port fails (what the old single-probe harness did)", async () => {
    const p = await probeFreePort();
    await occupy(p);
    expect((await fakeDaemonStart(p)).code).toBe(1);
  });

  it("gives up after the configured tries and returns the last result", async () => {
    const p = await probeFreePort();
    await occupy(p);
    const r = await withFreePort(fakeDaemonStart, {
      pick: async () => p,
      tries: 3,
      lostPort: (x) => x.code !== 0,
    });
    expect(r.attempts).toBe(3);
    expect(r.result.code).toBe(1);
  });
});
