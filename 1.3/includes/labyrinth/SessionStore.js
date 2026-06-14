"use strict";

/**
 * Labyrinth Session Store v2
 * ==========================
 * Persists Double Ratchet session state per threadID to disk.
 *
 * FIXES (v2):
 *   - Extended state (PIN sessions, autoEncrypt flags, peer IK pubs) is now
 *     persisted alongside Signal sessions so bot restarts don't lose them.
 *   - setExtended() / getExtended() API added for Labyrinth engine to call.
 *   - Atomic-style write: build full object in memory before writing.
 *   - _flush() errors are swallowed with a log, not silently ignored.
 */

const fs   = require("fs-extra");
const path = require("path");
const DR   = require("./DoubleRatchet");

function _log(msg, level) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ LABYRINTH-SESSION ]: ", color: ["red", "cyan"] },
        { message: msg, color: level === "warn" ? "yellow" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[LABYRINTH-SESSION]", msg);
}

class SessionStore {
  constructor(filePath) {
    this._file     = filePath || path.join(process.cwd(), "data", "labyrinth-sessions.json");
    this._sessions = {};      // threadID → DR state (in-memory, deserialized)
    this._pending  = {};      // threadID → { ikAPub, ekAPub, opkId }
    this._extended = {        // FIX: persisted extended state
      pinSessions: {},        //   threadID → { pin, saltHex }
      autoEncrypt: {},        //   threadID → bool
      peerIKpubs:  {}         //   threadID → peer IK pub (base64)
    };
    this._saveTimer = null;
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async init() {
    await fs.ensureDir(path.dirname(this._file));
    try {
      if (await fs.pathExists(this._file)) {
        const raw = await fs.readJSON(this._file);

        // Signal sessions
        for (const [tid, s] of Object.entries(raw.sessions || {})) {
          this._sessions[tid] = DR.deserializeState(s);
        }

        this._pending = raw.pending || {};

        // FIX: Load extended state (PIN sessions, autoEncrypt, peerIKpubs)
        if (raw.extended) {
          this._extended.pinSessions = raw.extended.pinSessions || {};
          this._extended.autoEncrypt = raw.extended.autoEncrypt || {};
          this._extended.peerIKpubs  = raw.extended.peerIKpubs  || {};
        }

        _log(
          `Sessions loaded — ${Object.keys(this._sessions).length} signal, ` +
          `${Object.keys(this._extended.pinSessions).length} PIN session(s).`
        );
      }
    } catch (e) {
      _log("Session load error — starting fresh: " + (e.message || e), "warn");
    }
  }

  // ── Signal session API ────────────────────────────────────────────────────

  has(threadID) {
    return !!this._sessions[String(threadID)];
  }

  get(threadID) {
    return this._sessions[String(threadID)] || null;
  }

  set(threadID, state) {
    this._sessions[String(threadID)] = state;
    this._scheduleSave();
  }

  delete(threadID) {
    const tid = String(threadID);
    delete this._sessions[tid];
    delete this._pending[tid];
    delete this._extended.pinSessions[tid];
    delete this._extended.autoEncrypt[tid];
    delete this._extended.peerIKpubs[tid];
    this._scheduleSave();
  }

  // ── Pending handshake API ─────────────────────────────────────────────────

  setPending(threadID, initData) {
    this._pending[String(threadID)] = initData;
    this._scheduleSave();
  }

  getPending(threadID) {
    return this._pending[String(threadID)] || null;
  }

  clearPending(threadID) {
    delete this._pending[String(threadID)];
    this._scheduleSave();
  }

  // ── Extended state API ────────────────────────────────────────────────────

  /**
   * setExtended — merge a partial extended-state object for a thread.
   * Keys: pinSession, autoEncrypt, peerIKpub.
   * Pass null/undefined for a key to clear it.
   */
  setExtended(threadID, data) {
    const tid = String(threadID);

    if ("pinSession" in data) {
      if (data.pinSession == null) {
        delete this._extended.pinSessions[tid];
      } else {
        this._extended.pinSessions[tid] = data.pinSession;
      }
    }

    if ("autoEncrypt" in data) {
      if (!data.autoEncrypt) {
        delete this._extended.autoEncrypt[tid];
      } else {
        this._extended.autoEncrypt[tid] = true;
      }
    }

    if ("peerIKpub" in data) {
      if (data.peerIKpub == null) {
        delete this._extended.peerIKpubs[tid];
      } else {
        this._extended.peerIKpubs[tid] = data.peerIKpub;
      }
    }

    this._scheduleSave();
  }

  getExtended(threadID) {
    const tid = String(threadID);
    return {
      pinSession: this._extended.pinSessions[tid] || null,
      autoEncrypt: !!this._extended.autoEncrypt[tid],
      peerIKpub:  this._extended.peerIKpubs[tid] || null
    };
  }

  getAllExtended() {
    return {
      pinSessions: { ...this._extended.pinSessions },
      autoEncrypt: { ...this._extended.autoEncrypt },
      peerIKpubs:  { ...this._extended.peerIKpubs }
    };
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flush().catch(e =>
        _log("Save error: " + (e.message || e), "warn")
      );
    }, 2000);
  }

  async _flush() {
    const out = {
      version:  2,
      sessions: {},
      pending:  this._pending,
      extended: this._extended   // FIX: persist extended state
    };
    for (const [tid, st] of Object.entries(this._sessions)) {
      out.sessions[tid] = DR.serializeState(st);
    }
    // Atomic write: tmp → rename so a mid-write crash never corrupts sessions.
    const tmpFile = this._file + ".tmp";
    await fs.writeJSON(tmpFile, out, { spaces: 2 });
    await fs.move(tmpFile, this._file, { overwrite: true });
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  pruneAll() {
    for (const st of Object.values(this._sessions)) {
      DR.pruneSkipped(st);
    }
    this._scheduleSave();
  }

  /** Force an immediate flush (called on graceful shutdown). */
  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._flush().catch(e =>
      _log("Flush error: " + (e.message || e), "warn")
    );
  }
}

module.exports = SessionStore;
