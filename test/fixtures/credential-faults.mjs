import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

// Isolated subprocess-only syscall faults. Traces contain kinds/events, never file contents.
const original = {
  open: fs.openSync,
  close: fs.closeSync,
  sync: fs.fsyncSync,
  link: fs.linkSync,
  unlink: fs.unlinkSync,
};
const files = new Map();
let publishedKind;
const publicationKind = (path) =>
  String(path).match(/\.ant0-key-publish-v1\.(credential|result)\./)?.[1];
function boundary(stage, kind) {
  if (kind && stage === process.env.ANT0_TEST_STAGE && kind === process.env.ANT0_TEST_KIND)
    process.kill(process.pid, "SIGKILL");
}
fs.linkSync = function (source, target) {
  const kind = publicationKind(source);
  boundary("before-link", kind);
  if (kind === "result" && process.env.ANT0_TEST_SWAP_SOURCE) {
    fs.renameSync(process.env.ANT0_TEST_SWAP_SOURCE, process.env.ANT0_TEST_CREDENTIAL);
    delete process.env.ANT0_TEST_SWAP_SOURCE;
  }
  const result = original.link.call(this, source, target);
  publishedKind = kind;
  boundary("after-link", kind);
  return result;
};
fs.unlinkSync = function (path) {
  const kind = publicationKind(path);
  boundary("before-unlink", kind);
  const result = original.unlink.call(this, path);
  boundary("after-unlink", kind);
  return result;
};
fs.openSync = function (path, ...args) {
  const fd = original.open.call(this, path, ...args);
  files.set(fd, typeof path === "string" ? resolve(path) : "");
  return fd;
};
fs.closeSync = function (fd) {
  files.delete(fd);
  return original.close.call(this, fd);
};
fs.fsyncSync = function (fd) {
  const kind = fs.fstatSync(fd).isDirectory()
    ? "directory"
    : files.get(fd) === process.env.ANT0_TEST_CREDENTIAL
      ? "credential"
      : files.get(fd) === `${process.env.ANT0_TEST_CREDENTIAL}.result.json`
        ? "result"
        : "other";
  const trace = (event) =>
    fs.appendFileSync(process.env.ANT0_TEST_TRACE, JSON.stringify({ event, kind }) + "\n");
  trace("attempt");
  if (kind === "directory") boundary("before-directory", publishedKind);
  const fault = process.env.ANT0_TEST_FAULT;
  if (
    (fault === "eio-directory" && kind === "directory") ||
    (fault === "eio-credential" && kind === "credential") ||
    (fault === "eio-result" && kind === "result")
  )
    throw Object.assign(new Error("injected durability failure"), { code: "EIO" });
  if (fault === "kill-directory" && kind === "directory") process.kill(process.pid, "SIGKILL");
  const result = original.sync.call(this, fd);
  trace("complete");
  if (kind === "directory") boundary("after-directory", publishedKind);
  return result;
};
syncBuiltinESMExports();
