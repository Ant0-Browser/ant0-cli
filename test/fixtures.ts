/** Typed API fixtures: `satisfies` ties each one to the API description, so drift fails typecheck. */
import type { components } from "../src/api/index.js";

type Schemas = components["schemas"];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AT = "2026-09-13T10:00:00.000Z";

/** Split table output into rows of cells (two-or-more spaces separate columns). */
export function rows(text: string): string[][] {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => line.split(/ {2,}/));
}

export function proxyFixture(id: string, over: Partial<Schemas["Proxy"]> = {}): Schemas["Proxy"] {
  return {
    schema: "ant0-proxy/v1",
    id,
    name: "residential",
    type: "http",
    host: "10.0.0.1",
    port: 1080,
    username: null,
    password_ref: null,
    change_ip_url: null,
    session_pattern: null,
    provider: null,
    udp: false,
    tags: [],
    notes: "",
    created_at: AT,
    updated_at: AT,
    last_check: null,
    ...over,
  } satisfies Schemas["Proxy"];
}

export function trashedFixture(
  id: string,
  name: string,
  over: Partial<Schemas["TrashedProfileSummary"]> = {},
): Schemas["TrashedProfileSummary"] {
  return {
    id,
    name,
    group: "g",
    local_folder_id: null,
    tags: [name],
    notes: "",
    status: null,
    pinned: false,
    platform: null,
    proxy_id: null,
    browser_version: null,
    identity_mode: "synthetic",
    created_at: AT,
    updated_at: AT,
    last_launched_at: null,
    deleted_at: AT,
    purge_at: "2026-10-13T10:00:00.000Z",
    ...over,
  } as Schemas["TrashedProfileSummary"];
}

export function summaryFixture(
  id: string,
  name: string,
  over: Partial<Schemas["ProfileSummary"]> = {},
): Schemas["ProfileSummary"] {
  return {
    id,
    name,
    group: null,
    local_folder_id: null,
    tags: [],
    notes: "",
    status: null,
    pinned: false,
    platform: "windows",
    proxy_id: null,
    browser_version: null,
    identity_mode: "synthetic",
    created_at: AT,
    updated_at: AT,
    last_launched_at: null,
    deleted_at: null,
    ...over,
  } satisfies Schemas["ProfileSummary"];
}
