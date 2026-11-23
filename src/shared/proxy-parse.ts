import { ParseError } from "./parse-error.js";
import type { ProxyCreate, ProxyType } from "./proxy-types.js";

const SCHEME_ALIASES: Record<string, ProxyType> = {
  http: "http",
  https: "https",
  socks5: "socks5",
  socks5h: "socks5",
  socks4: "socks4",
  socks4a: "socks4",
};

const DEFAULT_PORTS: Record<ProxyType, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks4: 1080,
};

/** Same character rules as `proxy-v1.schema.json#/properties/host` (bare IPv6, no brackets). */
const HOST_RE = /^[^\s/\\@?#[\]]+$/;
const PORT_RE = /^\d{1,5}$/;
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/;
/** `host[:port]` (bracketed IPv6 allowed) immediately followed by a path/query/fragment char. */
const PATH_AFTER_HOST_PORT = /^(?:\[[^\]]*\]|[^:[/?#]+)(?::\d*)?[/?#]/;

export interface ParsedHostPort {
  host: string;
  port: number;
}

/** Display form used for default names: IPv6 hosts are bracketed. */
export function formatHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function parsePort(text: string): number {
  if (!PORT_RE.test(text)) throw new ParseError("invalid port: expected 1..65535");
  const port = Number(text);
  if (port < 1 || port > 65535) throw new ParseError("port is out of range 1..65535");
  return port;
}

function checkHost(host: string): string {
  if (host === "") throw new ParseError("missing host");
  if (!HOST_RE.test(host)) throw new ParseError("invalid host");
  return host;
}

/**
 * An unbracketed `a:b:c...` is an IPv6 literal (not `host:port[:user:pass]`) when it contains
 * `::`, or when it has two or more colons and the segment after the first one is not a port.
 * Only hex digits, dots and colons are considered so `host:8080:user:pass` never matches.
 */
function looksLikeBareIpv6(text: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return false;
  const colons = text.split(":").length - 1;
  if (colons < 2) return false;
  if (text.includes("::")) return true;
  const second = text.split(":")[1] ?? "";
  return !PORT_RE.test(second);
}

/**
 * Parse `host:port`, `[v6]:port`, or a bare host (port optional when `defaultPort` is given).
 * Returns the remaining text after the port (starting with `:`) so callers can consume
 * `:user:pass` suffixes.
 */
function splitHostPort(
  text: string,
  defaultPort?: number,
): { host: string; port: number; rest: string } {
  let host: string;
  let after: string;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) throw new ParseError("unterminated IPv6 bracket");
    host = text.slice(1, close);
    after = text.slice(close + 1);
    if (!host.includes(":")) throw new ParseError("invalid IPv6 host");
  } else {
    if (looksLikeBareIpv6(text)) {
      throw new ParseError("IPv6 hosts must be written in brackets, e.g. [2001:db8::1]:1080");
    }
    const colon = text.indexOf(":");
    host = colon < 0 ? text : text.slice(0, colon);
    after = colon < 0 ? "" : text.slice(colon);
  }
  checkHost(host);
  if (after === "") {
    if (defaultPort === undefined) throw new ParseError("missing port");
    return { host, port: defaultPort, rest: "" };
  }
  if (!after.startsWith(":")) throw new ParseError("unexpected text after host");
  const next = after.indexOf(":", 1);
  const portText = next < 0 ? after.slice(1) : after.slice(1, next);
  const rest = next < 0 ? "" : after.slice(next);
  if (portText === "") {
    if (defaultPort === undefined) throw new ParseError("missing port");
    return { host, port: defaultPort, rest };
  }
  return { host, port: parsePort(portText), rest };
}

function decodeComponent(text: string, what: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new ParseError(`invalid percent-encoding in ${what}`);
  }
}

function splitUserInfo(
  userInfo: string,
  decode: boolean,
): { username?: string; password?: string } {
  const colon = userInfo.indexOf(":");
  let username = colon < 0 ? userInfo : userInfo.slice(0, colon);
  let password: string | undefined = colon < 0 ? undefined : userInfo.slice(colon + 1);
  if (decode) {
    username = decodeComponent(username, "username");
    if (password !== undefined) password = decodeComponent(password, "password");
  }
  const out: { username?: string; password?: string } = {};
  if (username !== "") out.username = username;
  if (password !== undefined && password !== "") out.password = password;
  return out;
}

function build(
  type: ProxyType,
  host: string,
  port: number,
  creds: { username?: string; password?: string },
): ProxyCreate {
  if (type === "socks4" && creds.password !== undefined) {
    throw new ParseError(
      "SOCKS4 proxies have a user ID but no password; remove the password or use socks5",
    );
  }
  const out: ProxyCreate = { name: formatHostPort(host, port).slice(0, 120), type, host, port };
  if (creds.username !== undefined) out.username = creds.username;
  if (creds.password !== undefined) out.password = creds.password;
  return out;
}

/**
 * Parse `scheme://[user[:pass]@]host[:port][/]` for `http`, `https`, `socks5` (and `socks5h`,
 * mapped to `socks5`) and `socks4` (and `socks4a`, mapped to `socks4`; no password). Credentials before `@` are percent-decoded; a raw `@` inside the password
 * is tolerated (the last `@` separates user info from the host). Missing port falls back to
 * 80 / 443 / 1080. The provider export form `scheme://host:port:user:pass` is also accepted;
 * its credentials are taken verbatim (no percent-decoding).
 *
 * @throws {ParseError}
 */
export function parseProxyUrl(url: string): ProxyCreate {
  const m = URL_RE.exec(url.trim());
  if (!m) throw new ParseError("not a proxy URL: expected scheme://host:port");
  const scheme = (m[1] ?? "").toLowerCase();
  const type = SCHEME_ALIASES[scheme];
  if (!type) throw new ParseError("unsupported proxy type: expected http, https, socks5 or socks4");
  let rest = m[2] ?? "";
  // Strip an optional trailing "/" (providers often paste "http://host:port/").
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  const at = rest.lastIndexOf("@");
  const userInfo = at < 0 ? "" : rest.slice(0, at);
  const hostPort = at < 0 ? rest : rest.slice(at + 1);
  // With "@" the host:port part must be clean; without it only the host/port segment is checked
  // so a "/" inside a verbatim ":user:pass" suffix is not mistaken for a path.
  if (at >= 0 ? /[/?#]/.test(hostPort) : PATH_AFTER_HOST_PORT.test(hostPort)) {
    throw new ParseError("proxy URL must not contain a path, query or fragment");
  }
  const { host, port, rest: tail } = splitHostPort(hostPort, DEFAULT_PORTS[type]);
  if (at >= 0) {
    if (tail !== "") throw new ParseError("unexpected text after port");
    return build(type, host, port, splitUserInfo(userInfo, true));
  }
  if (tail === "") return build(type, host, port, {});
  // scheme://host:port:user:pass (a common provider export format); credentials verbatim.
  const creds = splitUserInfo(tail.slice(1), false);
  if (creds.username === undefined && creds.password === undefined) {
    throw new ParseError("unexpected text after port");
  }
  return build(type, host, port, creds);
}

/**
 * Parse one provider-style line. Accepted forms (type defaults to `http`):
 *
 * - `host:port`
 * - `host:port:user:pass` (a password may itself contain `:`)
 * - `user:pass@host:port`
 * - `scheme://...` (delegates to `parseProxyUrl`)
 *
 * IPv6 hosts must be bracketed, e.g. `[2001:db8::1]:1080:user:pass`.
 *
 * @throws {ParseError}
 */
export function parseProxyLine(line: string): ProxyCreate {
  const text = line.trim();
  if (text === "") throw new ParseError("empty proxy line");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return parseProxyUrl(text);
  if (/\s/.test(text)) throw new ParseError("proxy line must not contain whitespace");

  const at = text.lastIndexOf("@");
  if (at >= 0) {
    const creds = splitUserInfo(text.slice(0, at), false);
    const { host, port, rest } = splitHostPort(text.slice(at + 1));
    if (rest !== "") throw new ParseError("unexpected text after port");
    return build("http", host, port, creds);
  }

  const { host, port, rest } = splitHostPort(text);
  if (rest === "") return build("http", host, port, {});
  // rest is ":user[:pass[:more...]]"; everything after the user's colon is the password.
  const creds = splitUserInfo(rest.slice(1), false);
  if (creds.username === undefined && creds.password === undefined) {
    throw new ParseError("expected host:port or host:port:user:pass");
  }
  return build("http", host, port, creds);
}

export interface ProxyLineError {
  /** 1-based line number in the input text. */
  line: number;
  message: string;
}

export interface ParsedProxyLines {
  proxies: ProxyCreate[];
  errors: ProxyLineError[];
}

/** Parse a multi-line provider export; blank lines and `#` comments are skipped. */
export function parseProxyLines(text: string): ParsedProxyLines {
  const proxies: ProxyCreate[] = [];
  const errors: ProxyLineError[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    try {
      proxies.push(parseProxyLine(line));
    } catch (error) {
      errors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { proxies, errors };
}
