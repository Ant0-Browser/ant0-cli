/**
 * Per-invocation state shared by every command: the streams, the environment, the global flags
 * (`--home`, `--port`, `--json`) and a lazily created API client.
 */
import {
  checkDiscoveredToken,
  createAnt0Client,
  discoverDaemon,
  unwrap,
  type Ant0Client,
  type DiscoveredDaemon,
} from "./api/index.js";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { DaemonNotRunningError, UsageError } from "./errors.js";
import { toJson } from "./format.js";
import { openNativeTerminal, type NativeTerminal } from "./native-terminal.js";
import { daemonClient, discoverConnection } from "@ant0/mcp";
import {
  apiKeyId,
  fileGrant,
  grantFromStatus,
  rejectCredentialEcho,
  type CredentialFile,
  type KeyGrant,
} from "@ant0/mcp/credentials";
import type { RuntimeCommands } from "./runtime-types.js";

export interface Writer {
  write(chunk: string): unknown;
}

/**
 * What prompting commands need from stdin: a TTY check, a line reader when interactive, and raw
 * mode for the password prompt (`login`), which a real `tty.ReadStream` provides.
 */
export interface Reader extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface RunIo {
  stdout: Writer;
  stderr: Writer;
  env: Record<string, string | undefined>;
  /** Injected fetch (tests). Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Aborting stops long-running commands (`events`); default is SIGINT. */
  signal?: AbortSignal;
  /**
   * Confirmation prompts (`rm --permanent`, `trash empty`), `login`'s prompts and
   * `--password-stdin`. Default: `process.stdin`.
   */
  stdin?: Reader;
  /** Injected direct controlling terminal (tests/embedding). `null` means unavailable. */
  nativeTerminal?: NativeTerminal | null;
  /** OS browser opening and wait seams; tests never launch a real browser. */
  openBrowser?: (url: string) => Promise<void>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface GlobalOptions {
  credentialFile?: string;
  apiKeyStdin?: boolean;
  home?: string;
  port?: number;
  json?: boolean;
}

export class Context {
  private globalsFn: () => GlobalOptions = () => ({});
  private cached: Ant0Client | undefined;
  private cachedKey = "";
  private delegated: Ant0Client | undefined;
  private secret: string | undefined;
  private grant: KeyGrant | undefined;
  credential: CredentialFile | undefined;
  apiKey: string | undefined;

  constructor(
    readonly io: RunIo,
    readonly runtime?: RuntimeCommands,
  ) {}

  /** Installed by the program builder once the root command exists. */
  bindGlobals(fn: () => GlobalOptions): void {
    this.globalsFn = fn;
  }

  get globals(): GlobalOptions {
    return this.globalsFn();
  }

  get json(): boolean {
    return this.globals.json === true;
  }

  /** Where the daemon should be, according to flags, pid file and environment. */
  connection(): DiscoveredDaemon {
    const g = this.globals;
    return discoverDaemon({
      env: this.io.env,
      ...(g.home !== undefined ? { home: g.home } : {}),
      ...(g.port !== undefined ? { port: g.port } : {}),
    });
  }

  /**
   * `connection()` for a command that sends the token: a token file that is not private is
   * refused here (or warned about with ANT0_ALLOW_SHARED_TOKEN_FILE=1), not during discovery, so
   * daemon start/stop/status and health checks keep working.
   */
  authenticatedConnection(): DiscoveredDaemon {
    const conn = this.connection();
    checkDiscoveredToken(conn, {
      env: this.io.env,
      warn: (message) => this.io.stderr.write(message),
    });
    return conn;
  }

  keyMode(): boolean {
    const g = this.globals;
    return (
      g.credentialFile !== undefined ||
      g.apiKeyStdin === true ||
      this.io.env.ANT0_API_KEY !== undefined
    );
  }

  /** Authenticated client; throws `DaemonNotRunningError` when there is no token to send. */
  client(): Ant0Client {
    if (!this.keyMode()) return this.managementClient();
    if (!this.delegated) {
      const g = this.globals;
      if (g.credentialFile === undefined) {
        const key = g.apiKeyStdin ? this.apiKey : this.io.env.ANT0_API_KEY;
        if (key === undefined || apiKeyId(key) === undefined)
          throw new UsageError(
            g.apiKeyStdin
              ? "stdin does not hold a valid Ant0 API key"
              : "ANT0_API_KEY is not a valid Ant0 API key",
          );
      }
      const connection = discoverConnection({
        ...(g.credentialFile !== undefined ? { credentialFile: g.credentialFile } : {}),
        ...(g.apiKeyStdin && this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
        env: this.io.env,
        ...(g.home !== undefined ? { home: g.home } : {}),
        ...(g.port !== undefined ? { port: g.port } : {}),
      });
      this.credential = connection.credential?.value;
      this.secret = connection.token;
      // The adapter types its client from its own, smaller API description; at runtime both are
      // the same openapi-fetch client.
      this.delegated = daemonClient(
        connection,
        this.io.signal ?? new AbortController().signal,
        "api",
      ) as unknown as Ant0Client;
    }
    return this.delegated;
  }

  /** Scopes come from the private file, or from the key's own status in env/stdin mode. */
  async keyGrant(): Promise<KeyGrant | undefined> {
    if (!this.keyMode()) return undefined;
    if (this.grant) return this.grant;
    const client = this.client();
    if (this.credential) {
      this.grant = fileGrant(this.credential);
      return this.grant;
    }
    const status = unwrap(await client.GET("/v1/automation/status"));
    this.grant = grantFromStatus(status, this.secret!, "api").grant;
    return this.grant;
  }

  /** Provisioning's credential-file is an output/recovery record, never its authentication. */
  managementClient(): Ant0Client {
    const conn = this.authenticatedConnection();
    if (conn.token === undefined) throw new DaemonNotRunningError();
    return this.clientFor(conn.baseUrl, conn.token);
  }

  /** Unauthenticated client (health checks). */
  openClient(): Ant0Client {
    if (this.globals.credentialFile !== undefined)
      throw new UsageError("credential file is not supported for this command");
    return this.clientFor(this.connection().baseUrl, undefined);
  }

  private clientFor(baseUrl: string, token: string | undefined): Ant0Client {
    const key = `${baseUrl}\n${token ?? ""}`;
    if (this.cached && this.cachedKey === key) return this.cached;
    this.cached = createAnt0Client({
      baseUrl,
      ...(token !== undefined ? { token } : { anonymous: true }),
      ...(this.io.fetch ? { fetch: this.io.fetch } : {}),
    });
    this.cachedKey = key;
    return this.cached;
  }

  async openBrowser(url: string): Promise<void> {
    if (
      !/^https:\/\/ant0\.link\/account\/authorize#code=[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(
        url,
      )
    )
      throw new UsageError("invalid browser authorization URL");
    if (this.io.openBrowser) return this.io.openBrowser(url);
    const executable =
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe")
        : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    try {
      await promisify(execFile)(executable, args, { timeout: 10000, windowsHide: true });
    } catch {
      throw new UsageError("could not open the browser; start a new login with --device-code");
    }
  }

  async wait(milliseconds: number): Promise<void> {
    if (this.io.wait) return this.io.wait(milliseconds, this.io.signal);
    const { setTimeout } = await import("node:timers/promises");
    await setTimeout(milliseconds, undefined, { signal: this.io.signal });
  }

  fetch(): typeof fetch {
    return this.io.fetch ?? globalThis.fetch;
  }

  out(text: string): void {
    this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  err(text: string): void {
    this.io.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /**
   * Gate an irreversible action. `--yes` skips the question; on a terminal the user is asked on
   * stderr; without a terminal the command refuses (exit 2) so scripts never hang or destroy data
   * by accident.
   */
  /** `refusal` replaces the generic "pass --yes" message when there is no terminal to ask on. */
  async confirm(question: string, yes: boolean | undefined, refusal?: string): Promise<void> {
    if (yes) return;
    const stdin = this.stdin;
    if (!stdin.isTTY) {
      throw new UsageError(
        refusal ?? `${question} — pass --yes to confirm (stdin is not a terminal)`,
      );
    }
    const rl = createInterface({ input: stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") throw new UsageError("aborted");
    } finally {
      rl.close();
    }
  }

  private get stdin(): Reader {
    return this.io.stdin ?? process.stdin;
  }

  /** Whether prompts are possible (stdin is a terminal). */
  interactive(): boolean {
    return this.stdin.isTTY === true;
  }

  /** Ask one line on the terminal (echoed); refuses without one (exit 2). */
  async prompt(question: string): Promise<string> {
    if (!this.interactive()) {
      throw new UsageError(`${question.trim()} — stdin is not a terminal; pass it as an argument`);
    }
    const rl = createInterface({ input: this.stdin, output: process.stderr });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  /**
   * Ask a secret on the terminal without echo (raw mode, Backspace edits, Ctrl-C aborts with exit
   * 2). Without a terminal the command must take `--password-stdin` instead.
   */
  async promptSecret(question: string): Promise<string> {
    return this.readSecret(
      question,
      `${question.trim()} — stdin is not a terminal; pipe the password with --password-stdin`,
    );
  }

  /** Run a native-secret operation on the controlling terminal, never stdin/stdout/stderr. */
  async withNativeTerminal<T>(
    operation: string,
    action: (terminal: NativeTerminal) => Promise<T>,
  ): Promise<T> {
    let terminal = this.io.nativeTerminal ?? undefined;
    const owned = this.io.nativeTerminal === undefined;
    if (this.io.nativeTerminal === null) {
      throw new UsageError(`${operation} requires the desktop app or a controlling terminal`);
    }
    if (!terminal) {
      try {
        terminal = openNativeTerminal();
      } catch {
        throw new UsageError(
          `${operation} requires the desktop app or a controlling terminal. Run this in a terminal window, or use the app.`,
        );
      }
    }
    try {
      return await action(terminal);
    } finally {
      if (owned) terminal.close();
    }
  }

  private async readSecret(question: string, unavailable: string): Promise<string> {
    const stdin = this.stdin;
    if (!this.interactive() || typeof stdin.setRawMode !== "function") {
      throw new UsageError(unavailable);
    }
    const setRaw = stdin.setRawMode.bind(stdin);
    this.io.stderr.write(question);
    const wasRaw = stdin.isRaw === true;
    setRaw(true);
    stdin.resume();
    return new Promise<string>((resolve, reject) => {
      let value = "";
      const finish = (done: () => void) => {
        stdin.off("data", onData);
        setRaw(wasRaw);
        stdin.pause();
        this.io.stderr.write("\n");
        done();
      };
      const onData = (chunk: Buffer | string) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return finish(() => resolve(value));
          if (ch === "\u0003" || ch === "\u0004") {
            return finish(() => reject(new UsageError("aborted")));
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      stdin.on("data", onData);
    });
  }

  /** The first line of stdin (`--password-stdin`): everything up to the first newline or EOF. */
  async readStdinLine(): Promise<string> {
    let text = "";
    for await (const chunk of this.stdin) {
      text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      const nl = text.indexOf("\n");
      if (nl !== -1) return text.slice(0, nl).replace(/\r$/, "");
    }
    return text.replace(/\r?\n?$/, "");
  }

  /** `--json`: the payload verbatim (nothing for a 204); otherwise the human rendering. */
  emit(payload: unknown, human: () => string | undefined): void {
    if (this.secret !== undefined) rejectCredentialEcho(payload, this.secret);
    if (this.json) {
      if (payload !== undefined) this.out(toJson(payload));
      return;
    }
    const text = human();
    if (text !== undefined && text.length > 0) this.out(text);
  }
}
