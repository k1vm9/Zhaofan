/**
 * DAVID V1 — Human Read Receipt (Layer 10)
 * Copyright © 2025 DJAMEL
 * Marks incoming messages as read after a short human-like delay instead
 * of instantly — bots that mark-read in <50ms are trivially detected.
 */
"use strict";

let _active = false;
let _api    = null;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const _pending = new Set();

function markRead(threadID) {
  if (!_active || !_api || _pending.has(threadID)) return;
  _pending.add(threadID);
  const delay = rand(800, 3500);
  setTimeout(() => {
    _pending.delete(threadID);
    try {
      if (_active && _api && typeof _api.markAsRead === "function") {
        _api.markAsRead(threadID, () => {});
      }
    } catch (_) {}
  }, delay);
}

function start(api) {
  if (_active || !api) return;
  _active = true;
  _api    = api;
  global._humanMarkRead = markRead;
}

function stop() {
  _active = false;
  _api    = null;
  _pending.clear();
  global._humanMarkRead = null;
}

function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, markRead, isActive: () => _active };
