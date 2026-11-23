import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
/**
 * `ant0 login [email] [--totp <code>] [--password-stdin] | logout | account | licence refresh`
 *
 * The daemon is the account holder for CLI users: `login` forwards the credentials to its
 * `POST /v1/licence/sign-in`, which signs in at the cloud, registers this device and fetches the
 * first licence. The password is read from the terminal without echo (or from stdin with
 * `--password-stdin` for scripts); a 401 `auth.totp_required` on a terminal asks for the code and
 * retries once. `account` and `licence refresh` print `GET /v1/licence` / `POST /v1/licence/refresh`
 * as key/value lines (`--json`: the payload verbatim). Cloud codes become plain sentences
 * (`describeAccountFailure`); everything exits 1 like any other API error, 3 without a daemon.
 */
import type { Command } from "commander";
import { isAnt0ApiError, resolveHome, unwrap, type components } from "../api/index.js";
import type { Context } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { keyValues, type Cell } from "../format.js";

export type LicenceState = components["schemas"]["LicenceState"];

/** Plain sentences for the cloud / licence codes a CLI user can run into. */
export const ACCOUNT_MESSAGES: Readonly<Record<string, string>> = {
  "auth.invalid_credentials": "wrong email or password",
  "auth.totp_required":
    "this account uses two-factor authentication; pass --totp <code> (or a recovery code)",
  "auth.totp_invalid": "the two-factor code is wrong or expired",
  "auth.email_unverified":
    "confirm your email address first (a new code was sent); the desktop app or ant0.link can take it",
  "auth.rate_limited": "too many attempts; wait 15 minutes and try again",
  "auth.account_suspended": "this account is suspended — contact support",
  "device.limit":
    "no free device slot on this account; remove a computer in the desktop app (Settings › Account) and retry",
  "device.free_used": "this computer already carries a Free workspace; sign in to that account",
  "device.kx_conflict":
    "this computer's sync keys differ from the ones registered with your account. Run `ant0 login` once more (this computer's device id may just have been updated). If it fails again, open the Ant0 app on this computer and sign in there, or use your sync recovery code if the keys were lost",
  "device.unknown": "this computer is not registered with the account; sign in again",
  "device.fingerprint_unavailable":
    "cannot identify this computer (fewer than two hardware identifiers readable); licensing is unavailable here",
  "licence.required": "sign in first (`ant0 login`)",
  "licence.offline": "the Ant0 cloud is unreachable right now; try again later",
  "licence.profile_limit": "the plan's profile limit is reached",
  "workspace.suspended": "account suspended — contact support",
  "workspace.lapsed": "the subscription has lapsed; renew at ant0.link",
};

/** One sentence for a failed account call; unknown codes keep the daemon's `code: message`. */
export function describeAccountFailure(err: unknown): string | undefined {
  if (!isAnt0ApiError(err)) return undefined;
  const known = ACCOUNT_MESSAGES[err.code];
  if (known !== undefined) return known;
  if (err.status === 400) return undefined; // validation details are more useful verbatim
  return `${err.code}: ${err.message}`;
}

/** Wrap a cloud failure into a `CliError` with the plain sentence; rethrow anything else. */
function accountError(err: unknown): never {
  const sentence = describeAccountFailure(err);
  if (sentence !== undefined) throw new CliError(sentence);
  throw err;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): string {
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || !EMAIL.test(email)) {
    throw new UsageError(`not an email address: ${JSON.stringify(value)}`);
  }
  return email;
}

/** A 6-digit TOTP (spaces tolerated) or an `xxxxx-xxxxx` recovery code, as the daemon accepts. */
export function normalizeSecondFactor(value: string): string {
  const v = value.trim();
  const digits = v.replace(/\s+/g, "");
  if (/^\d{6}$/.test(digits)) return digits;
  if (/^[A-Za-z0-9-]{8,16}$/.test(v)) return v;
  throw new UsageError(
    "--totp expects the 6-digit code from your authenticator or a recovery code",
  );
}

/** The lines `ant0 account` prints. */
export function accountLines(s: LicenceState): string {
  // `used` counts claims other devices hold too; name this device's share
  // when the two differ.
  const local = s.used_local !== s.used ? ` (${s.used_local} on this device)` : "";
  const used: Cell =
    s.limits === null
      ? `${s.used}${local}`
      : `${s.used} of ${s.limits.profiles} (${s.plan ?? "-"})${local}`;
  const pairs: [string, Cell][] = [
    ["state", s.state],
    ["plan", s.plan],
    ["profiles", used],
    ["seats", s.limits?.seats ?? null],
    ["plan status", s.billing],
    // `exp` is the licence lease (about the last refresh plus a day), not the end of the plan.
    ["licence refreshes by", s.expires_at],
    ["grace until", s.grace_until],
    ["device", s.device_id],
    ["workspace", s.workspace ? `${s.workspace.name ?? "-"} (${s.workspace.id})` : null],
    ["online", s.online],
    ["last refresh", s.last_refresh_at],
    ["last error", s.last_error],
  ];
  if (s.mode === "off") pairs.push(["mode", "off (nothing is enforced)"]);
  if (s.keep.profile_ids.length > 0) {
    pairs.push([
      "kept profiles",
      `${s.keep.profile_ids.length}${s.keep.explicit ? "" : " (default pick)"}`,
    ]);
  }
  const body = keyValues(pairs);
  return s.message ? `${body}\n${s.message}` : body;
}

export function registerAccount(program: Command, ctx: Context): void {
  program
    .command("login")
    .description(
      "Sign in to your Ant0 account on this computer (the daemon holds the session). If the Ant0 app is installed here, sign in from the app instead",
    )
    .argument("[email-or-action]", "legacy account email, or status/cancel")
    .option("--browser", "approve sign-in in the system browser (default)")
    .option("--device-code", "approve sign-in with a code on another computer")
    .option("--totp <code>", "6-digit authenticator code or a recovery code (2FA accounts)")
    .option("--password-stdin", "read the password from stdin instead of the terminal")
    .action(
      async (
        emailArg: string | undefined,
        opts: { totp?: string; passwordStdin?: boolean; browser?: boolean; deviceCode?: boolean },
      ) => {
        const native =
          emailArg === "status" ||
          emailArg === "cancel" ||
          (emailArg === undefined && opts.totp === undefined && !opts.passwordStdin);
        if (
          (opts.browser && opts.deviceCode) ||
          ((opts.browser || opts.deviceCode) && (!native || emailArg !== undefined))
        )
          throw new UsageError(
            "choose browser approval, device-code approval, or explicit legacy login",
          );
        if (native) return nativeLogin(ctx, emailArg, opts.deviceCode === true);
        const client = ctx.client();
        const email = validateEmail(emailArg ?? (await ctx.prompt("Email: ")));
        const password = opts.passwordStdin
          ? await ctx.readStdinLine()
          : await ctx.promptSecret("Password: ");
        if (password.length === 0) throw new UsageError("the password is empty");
        let totp = opts.totp !== undefined ? normalizeSecondFactor(opts.totp) : undefined;

        const attempt = () =>
          client.POST("/v1/licence/sign-in", {
            body: { email, password, ...(totp !== undefined ? { totp } : {}) },
          });
        let result = await attempt();
        if (
          result.error !== undefined &&
          result.error.error === "auth.totp_required" &&
          totp === undefined &&
          ctx.interactive()
        ) {
          totp = normalizeSecondFactor(await ctx.prompt("Two-factor code: "));
          result = await attempt();
        }
        let state: LicenceState;
        try {
          state = unwrap(result);
        } catch (err) {
          accountError(err);
        }
        ctx.emit(state, () => `signed in as ${email}\n${accountLines(state)}`);
      },
    );

  program
    .command("logout")
    .description("Sign this computer out (the licence and cloud session are forgotten)")
    .action(async () => {
      try {
        unwrap(await ctx.client().POST("/v1/licence/sign-out"));
      } catch (err) {
        accountError(err);
      }
      ctx.emit({ signed_out: true }, () => "signed out");
    });

  program
    .command("account")
    .description("Show the account and licence state of this computer (GET /v1/licence)")
    .action(async () => {
      let state: LicenceState;
      try {
        state = unwrap(await ctx.client().GET("/v1/licence"));
      } catch (err) {
        accountError(err);
      }
      ctx.emit(state, () => accountLines(state));
    });

  const licence = program.command("licence").description("Licence of this computer");
  licence
    .command("refresh")
    .description("Ask the Ant0 cloud for a fresh licence now (otherwise hourly)")
    .action(async () => {
      let state: LicenceState;
      try {
        state = unwrap(await ctx.client().POST("/v1/licence/refresh"));
      } catch (err) {
        accountError(err);
      }
      ctx.emit(state, () => accountLines(state));
    });
}

/** Closed secret-free control DTO. The coordinator regenerates the public API client after the
 * provider unit settles; no raw cloud response is ever passed through this boundary. */
export interface NativeLoginStatus {
  protocol: "ant0-native-auth/v1";
  status:
    | "idle"
    | "awaiting_browser"
    | "install_pending"
    | "signed_in"
    | "denied"
    | "cancelled"
    | "expired"
    | "failed";
  transaction_id: string | null;
  expires_at: string | null;
  verification_uri: "https://ant0.link/account/authorize" | null;
  user_code: string | null;
  account: { id: string; email: string } | null;
  workspace: { id: string; name: string } | null;
  error: string | null;
  retry_after_s: number | null;
}
type NativeResult = { data?: NativeLoginStatus; error?: unknown; response: Response };
type NativeControlClient = {
  GET(path: "/v1/licence/native/status"): Promise<NativeResult>;
  POST(
    path: "/v1/licence/native/begin",
    init: {
      body: {
        protocol: "ant0-native-auth/v1";
        request_id: string;
        client: "cli";
        delivery: "loopback" | "device_code";
        expected_account_id: null;
      };
    },
  ): Promise<NativeResult>;
  POST(
    path: "/v1/licence/native/cancel",
    init: { body: { transaction_id: string } },
  ): Promise<NativeResult>;
};
export function nativeStatusLines(status: NativeLoginStatus): string {
  if (status.status === "signed_in")
    return `signed in${status.account ? ` as ${status.account.email}` : ""}`;
  if (status.status === "awaiting_browser")
    return status.user_code
      ? `awaiting browser approval\n${status.verification_uri}\nCode: ${status.user_code}`
      : "awaiting browser approval; use `ant0 login status` to resume";
  if (status.status === "install_pending") return "approval received; session installation pending";
  return `sign-in ${status.status}${status.error ? ` (${status.error})` : ""}`;
}
function nativeStatus(result: NativeResult): NativeLoginStatus {
  const status = unwrap(result);
  const keys = [
    "protocol",
    "status",
    "transaction_id",
    "expires_at",
    "verification_uri",
    "user_code",
    "account",
    "workspace",
    "error",
    "retry_after_s",
  ];
  if (
    !status ||
    Object.keys(status).sort().join() !== keys.sort().join() ||
    status.protocol !== "ant0-native-auth/v1" ||
    ![
      "idle",
      "awaiting_browser",
      "install_pending",
      "signed_in",
      "denied",
      "cancelled",
      "expired",
      "failed",
    ].includes(status.status) ||
    (status.verification_uri !== null &&
      status.verification_uri !== "https://ant0.link/account/authorize") ||
    (status.user_code !== null &&
      !/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(status.user_code)) ||
    (status.status !== "awaiting_browser" &&
      (status.verification_uri !== null || status.user_code !== null)) ||
    (status.account !== null &&
      (Object.keys(status.account).sort().join() !== "email,id" ||
        typeof status.account.email !== "string")) ||
    (status.workspace !== null &&
      (Object.keys(status.workspace).sort().join() !== "id,name" ||
        typeof status.workspace.name !== "string")) ||
    (status.error !== null &&
      !/^(auth\.native\.[a-z_]+|device\.(key_conflict|limit)|workspace\.(suspended|lapsed))$/.test(
        status.error,
      )) ||
    (status.retry_after_s !== null &&
      (!Number.isInteger(status.retry_after_s) ||
        status.retry_after_s < 1 ||
        status.retry_after_s > 86400))
  )
    throw new CliError("invalid native authorization status");
  return status;
}
export const APP_INSTALLED_WARNING =
  "The Ant0 app is installed on this computer. Opening the app will ask you to sign in there and signs out this command-line session. If sync then asks for a key, use your recovery code.";
function desktopAppInstalled(ctx: Context): boolean {
  const device = join(
    resolveHome({
      ...(ctx.globals.home === undefined ? {} : { home: ctx.globals.home }),
      env: ctx.io.env,
    }),
    "device",
  );
  return existsSync(join(device, "keys.bin")) || existsSync(join(device, "auth-install.bin"));
}
async function nativeLogin(
  ctx: Context,
  action: string | undefined,
  deviceCode: boolean,
): Promise<void> {
  if (ctx.keyMode())
    throw new UsageError("native login requires installation management authority");
  const client = ctx.client() as unknown as NativeControlClient;
  if (action === undefined && desktopAppInstalled(ctx)) ctx.err(APP_INSTALLED_WARNING);
  const get = async () => nativeStatus(await client.GET("/v1/licence/native/status"));
  if (action === "status") {
    const status = await get();
    ctx.emit(status, () => nativeStatusLines(status));
    return;
  }
  if (action === "cancel") {
    let status = await get();
    if (status.transaction_id === null)
      throw new CliError("there is no pending native authorization");
    status = nativeStatus(
      await client.POST("/v1/licence/native/cancel", {
        body: { transaction_id: status.transaction_id },
      }),
    );
    ctx.emit(status, () => nativeStatusLines(status));
    if (status.status !== "cancelled")
      throw new CliError("authorization cancellation remains pending");
    return;
  }
  let status = nativeStatus(
    await client.POST("/v1/licence/native/begin", {
      body: {
        protocol: "ant0-native-auth/v1",
        request_id: randomUUID(),
        client: "cli",
        delivery: deviceCode ? "device_code" : "loopback",
        expected_account_id: null,
      },
    }),
  );
  const cancel = async () => {
    if (status.transaction_id)
      await client
        .POST("/v1/licence/native/cancel", { body: { transaction_id: status.transaction_id } })
        .catch(() => {});
  };
  if (ctx.json) {
    ctx.emit(status, () => "");
    if (status.status !== "signed_in") throw new CliError("sign-in remains incomplete");
    return;
  }
  ctx.err(nativeStatusLines(status));
  if (!deviceCode && status.verification_uri && status.user_code) {
    try {
      await ctx.openBrowser(`${status.verification_uri}#code=${status.user_code}`);
    } catch (error) {
      await cancel();
      throw error;
    }
  }
  let announcedCode = status.user_code;
  try {
    while (status.status === "awaiting_browser" || status.status === "install_pending") {
      if (ctx.io.signal?.aborted) throw new CliError("sign-in cancelled");
      await ctx.wait(Math.max(5, status.retry_after_s ?? 5) * 1000);
      status = await get();
      if (
        status.status === "awaiting_browser" &&
        status.user_code &&
        status.user_code !== announcedCode
      ) {
        announcedCode = status.user_code;
        ctx.err(nativeStatusLines(status));
        if (!deviceCode && status.verification_uri) {
          try {
            await ctx.openBrowser(`${status.verification_uri}#code=${status.user_code}`);
          } catch (error) {
            await cancel();
            throw error;
          }
        }
      }
    }
  } catch (error) {
    if (ctx.io.signal?.aborted) await cancel();
    throw error;
  }
  ctx.emit(status, () => nativeStatusLines(status));
  if (status.status !== "signed_in") throw new CliError(`sign-in ${status.status}`);
}
