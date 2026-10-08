/**
 * Djamel-Fca Architecte — resilient runtime launcher
 * Core By Djamel
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const MAX_RESTARTS = 25;
const BASE_DELAY = 3000;
const MAX_DELAY = 5 * 60 * 1000;
const MAX_INSTA_DELAY = 20 * 60 * 1000;
let restarts = 0, delay = BASE_DELAY, child = null, stable = null;
let instaChild = null, instaRestarts = 0, instaRestartTimer = null, stopping = false;

function start() {
  if (stopping) return;
  if (restarts >= MAX_RESTARTS) return process.exit(1);
  restarts++;
  child = spawn(process.execPath, ["--max-old-space-size=400", path.join(__dirname, "core-runtime-source.js")], { stdio:"inherit", env:{...process.env} });
  clearTimeout(stable);
  stable = setTimeout(() => { restarts = 0; delay = BASE_DELAY; }, 10 * 60 * 1000);
  child.once("exit", (code, signal) => {
    clearTimeout(stable);
    if (stopping) return;
    if (code === 0) { restarts = 0; delay = BASE_DELAY; return setTimeout(start, 1000); }
    setTimeout(() => { delay = Math.min(delay * 1.8, MAX_DELAY); start(); }, delay);
  });
  child.once("error", () => setTimeout(start, delay));
}

function startInstagram() {
  if (stopping || instaChild) return;
  instaChild = spawn(
    process.execPath,
    ["--max-old-space-size=256", path.join(__dirname, "INSTA.js")],
    { cwd: __dirname, stdio: "inherit", env: { ...process.env, FORCE_COLOR: "1" } },
  );
  instaChild.once("error", error => {
    console.error("[INSTA-WATCHDOG] Spawn failed:", error.message);
  });
  instaChild.once("exit", code => {
    instaChild = null;
    if (stopping) return;
    let wait = 2000;
    if (code !== 0) {
      instaRestarts++;
      wait = Math.min(30_000 * Math.pow(1.8, instaRestarts - 1), MAX_INSTA_DELAY);
      console.warn(`[INSTA-WATCHDOG] Instagram process exited (${code}); retrying in ${Math.round(wait / 1000)}s.`);
    } else {
      instaRestarts = 0;
    }
    clearTimeout(instaRestartTimer);
    instaRestartTimer = setTimeout(startInstagram, wait);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  stopping = true;
  clearTimeout(stable);
  clearTimeout(instaRestartTimer);
  try { child?.kill(sig); } catch (_) {}
  try { instaChild?.kill(sig); } catch (_) {}
  process.exit(0);
});

start();
// Instagram uses its own session, API port, and code path; keep the independent
// service running while Facebook moves to Djamel-Fca.
startInstagram();
