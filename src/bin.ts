#!/usr/bin/env node
async function main(): Promise<void> {
  const { run } = await import("./index.js");
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
}

void main().catch(() => process.exit(1));
