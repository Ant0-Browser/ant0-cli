/**
 * Free-port helpers for tests that hand a port to a child process (`ant0 --port N daemon start`).
 * A probe-then-close port can be taken by another process before the child binds it (a TOCTOU
 * race), so `withFreePort` retries the whole attempt on a fresh port when the attempt reports it.
 */
import { createServer } from "node:net";

/** Bind to port 0, read the port, close. The port is only free until the next bind. */
export async function probeFreePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

export interface FreePortOptions<T> {
  /** True when the result means the port was lost to another process (try again on a new port). */
  lostPort: (result: T, port: number) => boolean;
  tries?: number;
  pick?: () => Promise<number>;
  /** Called with the port of every attempt that lost the race, before the next one starts. */
  cleanup?: (port: number) => Promise<void>;
}

export async function withFreePort<T>(
  attempt: (port: number) => Promise<T>,
  opts: FreePortOptions<T>,
): Promise<{ port: number; result: T; attempts: number }> {
  const tries = opts.tries ?? 5;
  const pick = opts.pick ?? probeFreePort;
  let last: { port: number; result: T } | undefined;
  for (let i = 1; i <= tries; i++) {
    const port = await pick();
    const result = await attempt(port);
    last = { port, result };
    if (!opts.lostPort(result, port)) return { ...last, attempts: i };
    await opts.cleanup?.(port);
  }
  return { ...last!, attempts: tries };
}
