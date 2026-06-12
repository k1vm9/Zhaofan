/**
 * DAVID V1 — Outgoing Message Throttle (Layer 5)
 * Copyright © 2025 DJAMEL
 * Queues outgoing messages and enforces a random gap between sends
 * to prevent burst-sending that triggers Facebook spam detection.
 */
"use strict";

let _active = false;
let _lastSend = 0;
let _queue = Promise.resolve();
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function start(api) {
  if (_active || !api) return;
  _active = true;

  const orig = api.sendMessage.bind(api);
  api.sendMessage = function(msg, threadID, callback) {
    _queue = _queue.then(() => new Promise(resolve => {
      const now  = Date.now();
      const gap  = rand(700, 2000);
      const wait = Math.max(0, _lastSend + gap - now);
      setTimeout(() => {
        _lastSend = Date.now();
        try {
          orig(msg, threadID, (err, info) => {
            if (typeof callback === "function") callback(err, info);
            resolve();
          });
        } catch (e) {
          if (typeof callback === "function") callback(e);
          resolve();
        }
      }, wait);
    }));
    return _queue;
  };
}

function stop() { _active = false; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active };
