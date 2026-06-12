'use strict';
/**
 * AntiDetectionEnhanced.js
 *
 * Provides the public interface expected by antdetect.js and any other
 * module that requires anti-detection status and user-agent rotation.
 * Internally delegates to the existing antiSuspension module where
 * possible, and maintains its own lightweight UA pool otherwise.
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
];

const PRESENCES = ['ACTIVE', 'IDLE', 'OFFLINE'];

let _currentUAIdx  = Math.floor(Math.random() * USER_AGENTS.length);
let _currentPresence = PRESENCES[0];

function rotateUA() {
  _currentUAIdx = (_currentUAIdx + 1) % USER_AGENTS.length;
  return USER_AGENTS[_currentUAIdx];
}

function getCurrentUA() {
  return USER_AGENTS[_currentUAIdx];
}

function getStatus() {
  // Try to pull from antiSuspension if it exposes state
  let extra = {};
  try {
    const as = require('./antiSuspension');
    if (as && typeof as.getStatus === 'function') {
      extra = as.getStatus();
    }
  } catch (_) {}

  return {
    currentUA:       getCurrentUA(),
    currentPresence: _currentPresence,
    uaPoolSize:      USER_AGENTS.length,
    ...extra
  };
}

function setPresence(p) {
  if (PRESENCES.includes(p)) _currentPresence = p;
}

module.exports = {
  rotateUA,
  getCurrentUA,
  getStatus,
  setPresence,
  USER_AGENTS,
  PRESENCES
};
