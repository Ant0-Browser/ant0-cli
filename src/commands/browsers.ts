/**
 * `ant0 browsers ls | available [--channel] | install [--release|--channel] [--no-wait]
 *               | default <version> | rm <version>`, and
 * `install --release <exact> --repair-proof` (adds the signed file proof of an installed release) and
 * `install --release <exact> --replace` (downloads and verifies an installed release again and swaps
 * it in only on success; needs a daemon that supports `replace`).
 *
 * `default` is the release that profiles without a pinned `browser.version` launch (`PUT /browsers/default`); `ls` marks it with `*` in the DEFAULT column.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { Ant0ApiError, unwrap, type InstallJob, type InstalledBrowser } from "../api/index.js";
import type { Context } from "../context.js";
import { formatBytes, keyValues, table } from "../format.js";

const JOB_POLL_MS = 1000;

const BROWSER_HEADERS = ["version", "default", "chromium", "target", "size", "installed", "path"];
/** `ls` adds a status column: whether the installed files still match the signed proof. */
const LISTED_HEADERS = [...BROWSER_HEADERS.slice(0, 6), "status", "path"];

function browserRows(items: InstalledBrowser[]) {
  return items.map((b) => [
    b.version,
    b.default ? "*" : null,
    b.chromium,
    b.target,
    formatBytes(b.size_bytes),
    b.installed_at,
    b.path,
  ]);
}

/** One cell: `ok`, `FAILED <file>` for a release whose files changed, `unchecked` otherwise. */
function integrityCell(b: InstalledBrowser): string {
  const integrity = b.integrity;
  if (integrity === undefined) return "";
  if (integrity.status === "failed") {
    return integrity.path === undefined ? "FAILED" : `FAILED ${integrity.path}`;
  }
  return integrity.status;
}

function listedRows(items: InstalledBrowser[]) {
  return items.map((b) => [
    b.version,
    b.default ? "*" : null,
    b.chromium,
    b.target,
    formatBytes(b.size_bytes),
    b.installed_at,
    integrityCell(b),
    b.path,
  ]);
}

/** What to do about a release whose files no longer match its signed proof. */
function repairLines(items: InstalledBrowser[]): string[] {
  return items
    .filter((b) => b.integrity?.status === "failed")
    .map(
      (b) =>
        `${b.version} failed its integrity check (${b.integrity?.message ?? "files changed"}). ` +
        `Reinstall it: ant0 browsers rm ${b.version} && ant0 browsers install --release ${b.version}, ` +
        `then set it as the default again: ant0 browsers default ${b.version}`,
    );
}

export function registerBrowsers(program: Command, ctx: Context): void {
  const browsers = program.command("browsers").description("Installed Ant0 Browser releases");

  browsers
    .command("ls")
    .description(
      "List installed releases (the STATUS column is a corruption check for display, not an anti-tamper control)",
    )
    .action(async () => {
      const data = unwrap(
        await ctx.client().GET("/v1/browsers", { params: { query: { integrity: true } } }),
      );
      ctx.emit(data, () =>
        [table(LISTED_HEADERS, listedRows(data.items)), ...repairLines(data.items)].join("\n"),
      );
    });

  browsers
    .command("default <version>")
    .description("Make an installed release the one unpinned profiles launch")
    .action(async (version: string) => {
      const data = unwrap(await ctx.client().PUT("/v1/browsers/default", { body: { version } }));
      ctx.emit(data, () => table(BROWSER_HEADERS, browserRows(data.items)));
    });

  browsers
    .command("available")
    .description("Show the current release of a channel")
    .option("--channel <name>", "release channel", "stable")
    .action(async (opts: { channel: string }) => {
      const data = unwrap(
        await ctx.client().GET("/v1/browsers/available", {
          params: { query: { channel: opts.channel } },
        }),
      );
      ctx.emit(data, () =>
        keyValues([
          ["channel", data.channel],
          ["version", data.version],
          ["chromium", data.chromium],
          ["installed", data.installed],
        ]),
      );
    });

  browsers
    .command("install")
    .description("Download and verify a release (the channel's current one by default)")
    .option("--release <version>", "pin a release version (e.g. 149.0.7827.114-ant0.2)")
    .option("--channel <name>", "release channel", "stable")
    .option(
      "--repair-proof",
      "add the signed file proof of an already installed --release (public metadata only; no reinstall)",
    )
    .option(
      "--replace",
      "download and verify an already installed --release again and swap it in only on success (keeps the default, pins and profiles; needs a daemon that supports it)",
    )
    .option("--no-wait", "return the job id immediately instead of waiting for completion")
    .action(
      async (opts: {
        release?: string;
        channel: string;
        wait: boolean;
        repairProof?: boolean;
        replace?: boolean;
      }) => {
        if (opts.repairProof && !opts.release) {
          throw new Error("--repair-proof needs an exact --release <version>");
        }
        if (opts.replace && !opts.release) {
          throw new Error("--replace needs an exact --release <version>");
        }
        if (opts.replace && opts.repairProof) {
          throw new Error("--replace and --repair-proof cannot be used together");
        }
        const client = ctx.client();
        const result = await client.POST("/v1/browsers/install", {
          body: {
            channel: opts.channel,
            ...(opts.release ? { version: opts.release } : {}),
            ...(opts.repairProof ? { repair_proof: true } : {}),
            ...(opts.replace ? { replace: true } : {}),
          },
        });
        // A daemon from before in-place reinstall refuses the unknown `replace` field: every daemon's
        // install body schema is strict (additionalProperties: false), so it answers 400
        // validation_failed and never runs a plain install instead. Say so, and say what to do,
        // instead of a bare validation error.
        if (opts.replace && result.error !== undefined && result.response.status === 400) {
          throw new Error(
            `This daemon does not support --replace (reinstall in place). Update Ant0, or run: ` +
              `ant0 browsers rm ${opts.release} && ant0 browsers install --release ${opts.release}, ` +
              `then ant0 browsers default ${opts.release} if it was your default.`,
          );
        }
        const accepted = unwrap(result);
        if (!opts.wait) {
          ctx.emit(accepted, () => `install job ${accepted.job_id} started`);
          return;
        }
        if (!ctx.json) ctx.err(`installing ${opts.release ?? `${opts.channel} channel`}...`);
        let job: InstallJob;
        for (;;) {
          job = unwrap(
            await client.GET("/v1/browsers/jobs/{id}", {
              params: { path: { id: accepted.job_id } },
            }),
          );
          if (job.status !== "running") break;
          await sleep(JOB_POLL_MS);
        }
        if (job.status === "error" || !job.browser) {
          const e = job.error;
          throw new Ant0ApiError(
            500,
            e?.error ?? "browser.install_failed",
            e?.message ?? "install failed",
            e?.details,
          );
        }
        const b = job.browser;
        ctx.emit(job, () =>
          keyValues([
            ["version", b.version],
            ["chromium", b.chromium],
            ["target", b.target],
            ["size", formatBytes(b.size_bytes)],
            ["path", b.path],
            ...(job.engine_proof
              ? ([["file proof", `${job.engine_proof.status}: ${job.engine_proof.message}`]] as [
                  string,
                  string,
                ][])
              : []),
          ]),
        );
      },
    );

  browsers
    .command("rm <version>")
    .description("Remove an installed release (refused while a profile uses it)")
    .action(async (version: string) => {
      unwrap(
        await ctx.client().DELETE("/v1/browsers/{version}", { params: { path: { version } } }),
      );
      ctx.emit(undefined, () => `removed ${version}`);
    });
}
