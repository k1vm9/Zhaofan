"use strict";

/**
 * atomicWrite.js — crash-safe file writes.
 *
 * Why this exists:
 *   The bot constantly rewrites large JSON files (usersData.json,
 *   threadsData.json, ZAO-STATE.json, etc.). A naive
 *   fs.writeFileSync truncates the target FIRST and then streams data —
 *   if the process is killed (SIGKILL from the watchdog, OOM, power
 *   loss) between truncate and end-of-write the file ends up empty or
 *   half-written, which corrupts the entire dataset.
 *
 * Strategy:
 *   1. Write to a sibling temp file in the SAME directory (rename is
 *      only atomic when source and dest are on the same filesystem).
 *   2. fsync() to flush the kernel page cache to disk.
 *   3. rename() over the target — POSIX guarantees this is atomic.
 *
 * If anything fails the temp file is cleaned up and the original target
 * is left untouched, so the previous good state is always preserved.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

function _tmpPath(filePath) {
  const dir  = path.dirname(filePath);
  const base = path.basename(filePath);
  const tag  = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  return path.join(dir, `.${base}.${tag}.tmp`);
}

function atomicWriteFileSync(filePath, data, encoding = "utf-8") {
  const tmp = _tmpPath(filePath);
  let fd;
  try {
    fs.writeFileSync(tmp, data, encoding);
    try {
      fd = fs.openSync(tmp, "r");
      fs.fsyncSync(fd);
    } catch (_) {
      // fsync may fail on some filesystems — rename below is still atomic
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function atomicWriteJsonSync(filePath, obj, opts = {}) {
  const spaces = opts.spaces == null ? 2 : opts.spaces;
  const eol    = opts.EOL    == null ? "\n" : opts.EOL;
  const json   = JSON.stringify(obj, null, spaces) + (spaces ? eol : "");
  atomicWriteFileSync(filePath, json, "utf-8");
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync };
