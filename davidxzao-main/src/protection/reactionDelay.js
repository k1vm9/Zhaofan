/**
 * DAVID V1 — Reaction Delay (Layer 12)
 * Copyright © 2025 DJAMEL
 * Delays emoji reactions by a random human-like interval.
 * Instant reactions (0ms) are a strong bot signal to Facebook.
 */
"use strict";

let _active = false;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function start(api) {
  if (_active || !api) return;
  _active = true;

  if (typeof api.setMessageReaction === "function") {
    const orig = api.setMessageReaction.bind(api);
    api.setMessageReaction = function(emoji, messageID, callback, forceCustomReaction) {
      const delay = rand(500, 2500);
      setTimeout(() => {
        try { orig(emoji, messageID, callback, forceCustomReaction); } catch (_) {}
      }, delay);
    };
  }
}

function stop() { _active = false; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active };
