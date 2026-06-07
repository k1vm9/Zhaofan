"use strict";

/**
 * motorPersist.js — shared persistence for motor (محرك) and motor2
 * (محرك2). Both commands maintain a per-thread { status, message,
 * time, randomTime, randomRange } record; here we centralize the
 * load/save so every writer (chat command, panel REST, graceful
 * shutdown) uses the SAME serialization shape.
 *
 * Before this existed:
 *   - engine.js (محرك) never persisted from the chat command at all
 *     — settings were lost on every restart.
 *   - ZAO.js's panel _saveMotorState / _saveMotor2State stripped
 *     `randomTime` and `randomRange`, so motor's random-interval mode
 *     partially survived (status restored, but as fixed-time).
 *   - motor2.js had its own saveState that knew about randomTime
 *     while ZAO.js did not, so whichever wrote last won.
 *
 * Volatile fields (`interval`, `shouldSend`) are deliberately stripped
 * — they are runtime-only handles/closures.
 */

const path = require("path");
const { createStore } = require("./kvStore");

const MOTOR_FILE  = path.join(process.cwd(), "data", "motor-state.json");
const MOTOR2_FILE = path.join(process.cwd(), "data", "motor2-state.json");

function _serialize(d) {
  d = d || {};
  return {
    status:      !!d.status,
    message:     d.message != null ? d.message : null,
    time:        d.time    != null ? d.time    : null,
    randomTime:  !!d.randomTime,
    randomRange: d.randomRange || null
  };
}

function _hydrate(d) {
  d = d || {};
  return {
    status:      !!d.status,
    message:     d.message     || null,
    time:        d.time        || null,
    randomTime:  !!d.randomTime,
    randomRange: d.randomRange || null,
    interval:    null
  };
}

function makePersistor(file) {
  const store = createStore(file);

  function loadAll() {
    store.load();
    const out = {};
    for (const [k, v] of store.entries()) out[k] = _hydrate(v);
    return out;
  }

  function persistOne(threadID, data) {
    store.set(threadID, _serialize(data));
    store.flushSync();
  }

  function removeOne(threadID) {
    const had = store.delete(threadID);
    store.flushSync();
    return had;
  }

  function persistAll(memMap) {
    // Replace store contents wholesale with the in-memory snapshot
    store.clear();
    for (const [tid, data] of Object.entries(memMap || {})) {
      store.set(tid, _serialize(data));
    }
    store.flushSync();
  }

  function flush() { store.flushSync(); }

  return { file, store, loadAll, persistOne, removeOne, persistAll, flush };
}

const motor1 = makePersistor(MOTOR_FILE);
const motor2 = makePersistor(MOTOR2_FILE);

module.exports = {
  motor1,
  motor2,
  MOTOR_FILE,
  MOTOR2_FILE,
  flushAll() { motor1.flush(); motor2.flush(); }
};
