/**
 * `ant0 events [--since <iso>] [--replay <n>]`: tail the daemon's event stream over WebSocket and
 * print one JSON line per event until Ctrl-C (or the injected AbortSignal fires).
 */
import type { Command } from "commander";
import { eventsUrl, unwrap } from "../api/index.js";
import type { Context } from "../context.js";
import { CliError, DaemonNotRunningError, UsageError, isConnectionRefused } from "../errors.js";

export function registerEvents(program: Command, ctx: Context): void {
  program
    .command("events")
    .description("Tail the event stream (one JSON object per line; Ctrl-C to stop)")
    .option("--since <iso-date>", "replay buffered events at or after this time")
    .option("--replay <n>", "how many buffered events to replay first (default 50)")
    .action(async (opts: { since?: string; replay?: string }) => {
      const conn = ctx.authenticatedConnection();
      if (conn.token === undefined) throw new DaemonNotRunningError();
      // A clean "not running" exit beats a WebSocket error event with no cause attached.
      try {
        unwrap(await ctx.openClient().GET("/v1/health"));
      } catch (err) {
        if (isConnectionRefused(err)) throw new DaemonNotRunningError();
        throw err;
      }

      const url = new URL(eventsUrl(conn.baseUrl, conn.token));
      if (opts.since !== undefined) {
        if (Number.isNaN(Date.parse(opts.since)))
          throw new UsageError("--since expects an ISO date");
        url.searchParams.set("since", opts.since);
      }
      if (opts.replay !== undefined) {
        if (!/^\d+$/.test(opts.replay)) throw new UsageError("--replay expects an integer");
        url.searchParams.set("limit", opts.replay);
      }

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url.toString());
        let settled = false;
        const finish = (err?: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) reject(err);
          else resolve();
        };
        const stop = (): void => {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, "client stop");
          }
          finish();
        };
        const onSigint = (): void => stop();
        const cleanup = (): void => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigint);
          ctx.io.signal?.removeEventListener("abort", onSigint);
        };
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigint);
        if (ctx.io.signal) {
          if (ctx.io.signal.aborted) return stop();
          ctx.io.signal.addEventListener("abort", onSigint, { once: true });
        }

        socket.addEventListener("message", (event) => {
          const data = event.data;
          ctx.out(typeof data === "string" ? data : String(data));
        });
        socket.addEventListener("error", () => {
          finish(new CliError(`event stream failed (${url.origin})`));
        });
        socket.addEventListener("close", (event) => {
          if (event.code === 1000 || event.code === 1005) finish();
          else
            finish(
              new CliError(
                `event stream closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`,
              ),
            );
        });
      });
    });
}
