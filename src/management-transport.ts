import { request } from "node:http";
import { canonicalOrigin } from "@ant0/mcp";
import { CliError } from "./errors.js";

/** Direct loopback HTTP: deliberately independent of global fetch/Undici/environment proxies. */
export const directManagementFetch: typeof fetch = async (input) => {
  if (!(input instanceof Request)) throw new CliError("invalid API key request");
  const url = new URL(input.url);
  if (
    canonicalOrigin(url.origin) !== url.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/v1\/automation\/api-keys(?:\/(?:context|provision|[0-9a-f-]{36}))?$/.test(url.pathname) ||
    !["GET", "POST", "PATCH", "DELETE"].includes(input.method)
  )
    throw new CliError("invalid local API key management destination");
  const body = Buffer.from(await input.arrayBuffer());
  if (body.length > 64 * 1024) throw new CliError("API key request exceeds limit");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  if (signal.aborted) throw new CliError("API key request cancelled");
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const req = request(url, {
      method: input.method,
      agent: false,
      maxHeaderSize: 16 * 1024,
      headers: {
        authorization: input.headers.get("authorization") ?? "",
        accept: "application/json",
        "accept-encoding": "identity",
        ...(body.length
          ? { "content-type": "application/json", "content-length": body.length }
          : {}),
      },
    });
    const closed = new Promise<void>((done) => req.once("close", done));
    const finish = (error?: string, response?: Response) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) req.destroy();
      void closed.then(() => (error ? reject(new CliError(error)) : resolve(response!)));
    };
    const abort = () => finish("API key request cancelled or timed out");
    signal.addEventListener("abort", abort, { once: true });
    req.on("error", () => finish("API key operation unavailable"));
    req.on("response", (res) => {
      const status = res.statusCode ?? 500;
      if (status >= 300 && status < 400) return finish("API key redirect refused");
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
        return finish("invalid API key response");
      if (Number(res.headers["content-length"]) > 1024 * 1024)
        return finish("API key response exceeds limit");
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("error", () => finish("invalid API key response"));
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) return finish("API key response exceeds limit");
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          finish(
            undefined,
            new Response(status === 204 ? null : text, {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        } catch {
          finish("invalid API key response");
        }
      });
      res.on("close", () => {
        if (!res.complete) finish("invalid API key response");
      });
    });
    if (signal.aborted) abort();
    else req.end(body.length ? body : undefined);
  });
};
