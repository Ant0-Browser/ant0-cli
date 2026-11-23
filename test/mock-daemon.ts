/**
 * Test harness: a small HTTP server on 127.0.0.1 that plays the Ant0 daemon for the CLI. Tests
 * register the routes they need; every request is recorded, and a request without a route answers
 * 404 `not_found` and is listed in `unhandled` (which `close()` asserts is empty). The home folder
 * carries the `ant0d.pid` and `ant0d.token` files the CLI discovers, with a private token file.
 *
 * Fixtures are typed with `satisfies components["schemas"][...]`, so a change to the API
 * description fails the typecheck here first.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import type { Reader } from "../src/context.js";
import type { NativeTerminal } from "../src/native-terminal.js";

export interface MockRequest {
  method: string;
  /** Path without the query string, e.g. `/v1/proxies/abc`. */
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  /** Parsed JSON body, or `undefined` when there was none. */
  body: unknown;
  /** Values of `:name` segments in the matched pattern. */
  params: Record<string, string>;
}

export interface MockReply {
  status?: number;
  body?: unknown;
}

export type MockHandler = (req: MockRequest) => MockReply | Promise<MockReply> | undefined;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** `JSON.parse(stdout)`; throws when the output is not JSON. */
  json<T = unknown>(): T;
}

export interface RunExtra {
  signal?: AbortSignal;
  stdin?: Reader;
  nativeTerminal?: NativeTerminal | null;
  env?: Record<string, string | undefined>;
}

export const TOKEN = "mock-token-0123456789abcdef";

/** The daemon's `{ error, message }` envelope. */
export function apiError(status: number, error: string, message: string, details?: unknown) {
  return { status, body: { error, message, ...(details === undefined ? {} : { details }) } };
}

class Sink {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** Run the CLI in-process against an arbitrary home/env and capture both streams. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = {},
  extra: RunExtra = {},
): Promise<CliResult> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    stdout,
    stderr,
    env: { ...env, ...extra.env },
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.stdin ? { stdin: extra.stdin } : {}),
    ...(extra.nativeTerminal !== undefined ? { nativeTerminal: extra.nativeTerminal } : {}),
  });
  return {
    code,
    stdout: stdout.text,
    stderr: stderr.text,
    json<T>(): T {
      return JSON.parse(stdout.text) as T;
    },
  };
}

interface Route {
  method: string;
  segments: string[];
  handler: MockHandler;
}

export class MockDaemon {
  readonly requests: MockRequest[] = [];
  readonly unhandled: string[] = [];
  private readonly routes: Route[] = [];

  private constructor(
    private readonly server: Server,
    readonly home: string,
    readonly baseUrl: string,
    readonly port: number,
  ) {}

  /** Start a daemon double; `GET /v1/health` answers by default. */
  static async start(): Promise<MockDaemon> {
    const home = mkdtempSync(join(tmpdir(), "ant0-cli-mock-"));
    let mock: MockDaemon | undefined;
    const server = createServer((req, res) => {
      void mock!.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    mock = new MockDaemon(server, home, `http://127.0.0.1:${port}`, port);
    writeFileSync(
      join(home, "ant0d.pid"),
      JSON.stringify({
        pid: process.pid,
        port,
        host: "127.0.0.1",
        version: "0.1.0-test",
        started_at: new Date().toISOString(),
      }),
    );
    writeFileSync(join(home, "ant0d.token"), `${TOKEN}\n`, { mode: 0o600 });
    mock.on("GET", "/v1/health", () => ({
      body: { ok: true, version: "0.1.0-test", pid: process.pid, uptime_s: 5, home },
    }));
    return mock;
  }

  /**
   * Register a route. `pattern` may contain `:name` segments. The handler returns a reply
   * (`{ status?, body? }`); returning `undefined` answers 204. Later registrations win.
   */
  on(method: string, pattern: string, handler: MockHandler | MockReply): this {
    this.routes.unshift({
      method: method.toUpperCase(),
      segments: pattern.split("/"),
      handler: typeof handler === "function" ? handler : () => handler,
    });
    return this;
  }

  /** Requests seen so far for `method path` (exact path, no query). */
  seen(method: string, path: string): MockRequest[] {
    return this.requests.filter((r) => r.method === method.toUpperCase() && r.path === path);
  }

  cli(...argv: string[]): Promise<CliResult> {
    return runCli(["--home", this.home, ...argv], {}, { nativeTerminal: null });
  }

  cliWith(extra: RunExtra, ...argv: string[]): Promise<CliResult> {
    return runCli(["--home", this.home, ...argv], {}, { nativeTerminal: null, ...extra });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
    rmSync(this.home, { recursive: true, force: true });
    if (this.unhandled.length > 0)
      throw new Error(`requests without a mock route: ${this.unhandled.join(", ")}`);
  }

  private match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split("/");
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.segments.every((segment, i) => {
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]!);
          return true;
        }
        return segment === parts[i];
      });
      if (ok) return { route, params };
    }
    return undefined;
  }

  private async handle(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const method = (req.method ?? "GET").toUpperCase();
    const found = this.match(method, url.pathname);
    const record: MockRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
      params: found?.params ?? {},
    };
    this.requests.push(record);
    const send = (status: number, payload?: unknown) => {
      if (payload === undefined) {
        res.writeHead(status).end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    };
    if (url.pathname !== "/v1/health" && req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: "unauthorized", message: "missing or invalid bearer token" });
      return;
    }
    if (!found) {
      this.unhandled.push(`${method} ${url.pathname}`);
      send(404, { error: "not_found", message: `no mock route for ${method} ${url.pathname}` });
      return;
    }
    const reply = await found.route.handler(record);
    if (reply === undefined) send(204);
    else send(reply.status ?? 200, reply.body);
  }
}
