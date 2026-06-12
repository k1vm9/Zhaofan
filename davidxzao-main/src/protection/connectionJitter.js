/**
 * DAVID V1 — Connection Jitter (Layer 13)
 * Copyright © 2025 DJAMEL
 * Adds randomized micro-delays to typing indicators, read receipts, and reactions
 * so that network traffic doesn't show uniform inter-packet timing (a bot signal).
 * Intentionally excludes sendMessage — that is handled by outgoingThrottle + humanTyping.
 */
"use strict";

let _active = false;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// sendMessage is excluded — already wrapped by outgoingThrottle + humanTyping
const JITTER_METHODS = ["sendTypingIndicator", "markAsRead", "setMessageReaction"];

function start(api) {
  if (_active || !api) return;
  _active = true;

  for (const method of JITTER_METHODS) {
    if (typeof api[method] === "function") {
      const orig = api[method].bind(api);
      api[method] = function(...args) {
        const jitter = rand(30, 180);
        setTimeout(() => { try { orig(...args); } catch (_) {} }, jitter);
      };
    }
  }
}

function stop() { _active = false; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active };
