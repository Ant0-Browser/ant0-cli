#!/usr/bin/env node
/**
 * Fails when internal wording leaked into the files that ship or document this repository.
 *
 *   node scripts/check-forbidden.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN = ["src", "test", "scripts", "README.md", "CONTRIBUTING.md", "package.json"];
const SKIP = new Set(["scripts/check-forbidden.mjs", "src/api/openapi.json", "src/api/generated"]);
const FORBIDDEN = [
  /§/,
  /PHASE\d/i,
  /\bR1\b/,
  /\bM4\b/,
  /bridge/i,
  /--ant0-internal/,
  /packages\//,
  /apps\/desktop/,
  /\/root\//,
  /\bDRAFT\b/,
  /Co-Authored-By/i,
];

function* files(path) {
  const rel = relative(root, path).split("\\").join("/");
  if (SKIP.has(rel)) return;
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) yield* files(join(path, name));
  } else if (/\.(ts|mjs|js|json|md)$/.test(path)) {
    yield path;
  }
}

const hits = [];
for (const entry of SCAN) {
  for (const file of files(join(root, entry))) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const pattern of FORBIDDEN)
          if (pattern.test(line))
            hits.push(
              `${relative(root, file)}:${index + 1}: ${pattern} :: ${line.trim().slice(0, 100)}`,
            );
      });
  }
}
if (hits.length > 0) {
  console.error(`forbidden strings found:\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log("no forbidden strings");
