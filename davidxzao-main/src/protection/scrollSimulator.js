/**
 * DAVID V1 — Scroll Simulator (Layer 11)
 * Copyright © 2025 DJAMEL
 * Simulates a user scrolling through their inbox by occasionally fetching
 * thread lists — this keeps the session active and looks human to Facebook.
 */
"use strict";

let _active = false;
let _api    = null;
let _timer  = null;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

async function simulateScroll() {
  if (!_active || !_api) return;
  try {
    if (typeof _api.getThreadList === "function") {
      await new Promise((res) =>
        _api.getThreadList(rand(5, 15), null, [], (err, threads) => {
          if (!err && Array.isArray(threads)) {
            // Update thread data cache
            if (global.GoatBot?.allThreadData) {
              for (const t of threads) {
                if (t?.threadID) global.GoatBot.allThreadData[t.threadID] = t;
              }
            }
          }
          res();
        })
      );
    }
  } catch (_) {}
}

function schedule() {
  if (!_active) return;
  const ms = rand(8, 22) * 60000;
  _timer = setTimeout(async () => {
    await simulateScroll();
    schedule();
  }, ms);
}

function start(api) {
  if (_active || !api) return;
  _active = true;
  _api    = api;
  schedule();
}

function stop() {
  _active = false;
  _api    = null;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active };
