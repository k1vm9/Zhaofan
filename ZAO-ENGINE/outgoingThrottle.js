"use strict";
/**
 * ZAO-ENGINE — Outgoing Message Throttle
 * Source: David's outgoingThrottle.js — queues outgoing messages and enforces
 * a random 700-2000ms gap between sends to prevent burst-sending that triggers
 * Facebook spam detection.
 */

let _active  = false;
let _lastSend = 0;
let _queue   = Promise.resolve();
const rand   = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

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

module.exports = { start, stop, isActive: () => _active };
