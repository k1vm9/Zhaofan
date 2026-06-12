/**
 * DAVID V1 — Natural Presence Simulator (Layer 6)
 * Copyright © 2025 DJAMEL
 * Periodically marks messages as seen in active threads to simulate a
 * real user reading their chats — essential for avoiding account flags.
 */
"use strict";

let _active = false;
let _api    = null;
let _timer  = null;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function getActiveThreads() {
  try {
    const data = global.GoatBot?.allThreadData || {};
    return Object.keys(data).slice(0, 8); // limit to 8 threads per cycle
  } catch (_) { return []; }
}

async function presenceCycle() {
  if (!_active || !_api) return;
  const threads = getActiveThreads();
  for (const tid of threads) {
    if (!_active) break;
    try {
      if (typeof _api.markAsRead === "function") {
        await new Promise(r => _api.markAsRead(tid, r));
        await new Promise(r => setTimeout(r, rand(1200, 3500)));
      }
    } catch (_) {}
  }
}

function schedule() {
  if (!_active) return;
  const ms = rand(4, 12) * 60000;
  _timer = setTimeout(async () => {
    await presenceCycle();
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
