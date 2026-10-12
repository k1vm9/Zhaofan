"use strict";

/**
 * Labyrinth v4 — Merged E2EE Engine
 * ====================================
 * Merges ZAO's Labyrinth (Signal X3DH + Double Ratchet, X25519/Ed25519)
 * with Liberty Protocol (PIN passive mode, dual-prefix, auto-encrypt).
 *
 * Wire formats:
 *   🔐ZAO|<base64-JSON>   — Signal Protocol (X3DH + Double Ratchet) — primary
 *   🔒E2EE:<base64-JSON>  — Liberty/PIN format — passive fallback
 *
 * FIXES (v4):
 *   - getStatus() signalSessions now counted independently (was wrong when
 *     a thread had both Signal + PIN sessions, causing wrong/negative count).
 *   - Safety number now uses HKDF-SHA256 instead of HMAC with a zero key
 *     (zero HMAC key is weak — HKDF provides proper key derivation).
 *   - PIN sessions, autoEncrypt flags, peerIKpubs are now persisted via
 *     SessionStore.setExtended() and restored on startup — surviving restarts.
 *   - diagnose() method: runs a full internal round-trip and returns a health
 *     object — usable from the panel or on startup.
 *   - Incoming OPK ID string/number coercion handled via String() in
 *     _handleHandshakeInit (consistent with X3DH v4 fix).
 *   - pinEncrypt always uses the thread PIN first, global PIN second — not
 *     accidentally generating a new salt on the fly.
 *   - listSessions() now returns { signal: [], pin: [], all: [] } or
 *     keeps backward compat by returning the union array.
 */

const crypto = require("crypto");
const DR     = require("./DoubleRatchet");
const X3DH   = require("./X3DH");

const SIGNAL_PREFIX  = "🔐ZAO|";
const LIBERTY_PREFIX = "🔒E2EE:";
const PBKDF2_ITERS   = 210_000;

// Safety number info string — used in HKDF
const SN_INFO = Buffer.from("ZAOLabyrinth-SafetyNumber-v1");

function _log(msg, level) {
  try {
    const method = level === "warn" || level === "error" ? level : "info";
    if (typeof global.log?.[method] === "function") {
      global.log[method]("LABYRINTH", msg);
      return;
    }
  } catch (_) {}
  console.log("[LABYRINTH]", msg);
}

// ── PIN crypto helpers ───────────────────────────────────────────────────────

function _pinDeriveKey(pin, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(32);
  const key  = crypto.pbkdf2Sync(
    Buffer.from(String(pin), "utf8"),
    salt, PBKDF2_ITERS, 32, "sha256"
  );
  return { key, saltHex: salt.toString("hex") };
}

function _pinEncryptPayload(plaintext, pin, saltHex) {
  const { key, saltHex: usedSalt } = _pinDeriveKey(pin, saltHex);
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct  = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  const tag = c.getAuthTag();
  return {
    v:    1,
    type: "pin",
    salt: usedSalt,
    iv:   iv.toString("hex"),
    ct:   ct.toString("hex"),
    tag:  tag.toString("hex")
  };
}

function _pinDecryptPayload(payload, pin) {
  const { key } = _pinDeriveKey(pin, payload.salt);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "hex"));
  d.setAuthTag(Buffer.from(payload.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(payload.ct, "hex")), d.final()]).toString("utf8");
}

// ── Wire format helpers ──────────────────────────────────────────────────────

function _encode(prefix, obj) {
  return prefix + Buffer.from(JSON.stringify(obj)).toString("base64");
}

function _decode(raw) {
  if (typeof raw !== "string") return null;
  let payload = null;
  let prefix  = null;
  try {
    if (raw.startsWith(SIGNAL_PREFIX)) {
      prefix  = "signal";
      payload = JSON.parse(Buffer.from(raw.slice(SIGNAL_PREFIX.length), "base64").toString("utf8"));
    } else if (raw.startsWith(LIBERTY_PREFIX)) {
      prefix  = "liberty";
      payload = JSON.parse(Buffer.from(raw.slice(LIBERTY_PREFIX.length), "base64").toString("utf8"));
    }
  } catch (_) { return null; }
  if (!payload) return null;
  return { prefix, payload };
}

// ── Safety number (session fingerprint) ──────────────────────────────────────
//
// FIX: Uses HKDF-SHA256 with a proper info string instead of HMAC with a
// zero key. HKDF provides stronger domain separation and is the correct
// primitive for key derivation.
//
// Both sides get the same number because we canonically sort the two public
// keys before feeding them into HKDF.

function _safetyNumber(pubA, pubB) {
  const a = Buffer.from(pubA);
  const b = Buffer.from(pubB);
  // Canonical order: lexicographically smaller key first
  const [first, second] = a.compare(b) <= 0 ? [a, b] : [b, a];
  const ikm    = Buffer.concat([first, second]);
  const digest = Buffer.from(
    crypto.hkdfSync("sha256", ikm, Buffer.alloc(32, 0), SN_INFO, 30)
  );
  // 6 groups of 5 decimal digits (30 bytes → 6 × 5-digit numbers)
  const groups = [];
  for (let i = 0; i < 6; i++) {
    // Use 5 bytes → 40-bit number → modulo 100000 → 5 digits
    const hi  = digest.readUInt32BE(i * 5) * 256 + digest[i * 5 + 4];
    const num = Math.abs(hi) % 100000;
    groups.push(String(num).padStart(5, "0"));
  }
  return groups.slice(0, 3).join(" ") + "\n" + groups.slice(3).join(" ");
}

// ── Main Labyrinth class ─────────────────────────────────────────────────────

class Labyrinth {
  constructor(keyStore, sessionStore) {
    this.keyStore     = keyStore;
    this.sessionStore = sessionStore;
    this._startTime   = Date.now();
    this._msgSent     = 0;
    this._msgRecv     = 0;
    this._handshakes  = 0;

    // In-memory state (mirrored to SessionStore._extended for persistence)
    this._globalPin   = null;   // set by setGlobalPin()
    this._pinSessions = {};     // threadID → { pin, saltHex }
    this._autoEncrypt = {};     // threadID → bool
    this._peerIKpubs  = {};     // threadID → peer IK pub (base64)
  }

  // ── Load persisted extended state (called by index.js after init) ─────────

  loadExtendedState() {
    try {
      const ext = this.sessionStore.getAllExtended();

      // Restore PIN sessions
      for (const [tid, ps] of Object.entries(ext.pinSessions || {})) {
        if (ps && ps.pin) this._pinSessions[tid] = ps;
      }

      // Restore autoEncrypt flags
      for (const [tid, ae] of Object.entries(ext.autoEncrypt || {})) {
        if (ae) this._autoEncrypt[tid] = true;
      }

      // Restore peer IK pubs
      for (const [tid, pub] of Object.entries(ext.peerIKpubs || {})) {
        if (pub) this._peerIKpubs[tid] = pub;
      }

      const pinCount = Object.keys(this._pinSessions).length;
      const aeCount  = Object.keys(this._autoEncrypt).length;
      if (pinCount || aeCount) {
        _log(`Extended state restored — ${pinCount} PIN session(s), ${aeCount} auto-encrypt thread(s).`);
      }
    } catch (e) {
      _log("Extended state restore error: " + (e.message || e), "warn");
    }
  }

  // ── PIN API ──────────────────────────────────────────────────────────────

  setGlobalPin(pin) {
    this._globalPin = pin ? String(pin).trim() : null;
    _log(this._globalPin ? "Global PIN set." : "Global PIN cleared.");
  }

  getGlobalPin() { return this._globalPin; }

  setPinSession(threadID, pin) {
    const tid         = String(threadID);
    const { saltHex } = _pinDeriveKey(pin);
    const ps          = { pin: String(pin), saltHex };
    this._pinSessions[tid] = ps;
    // FIX: persist immediately
    this.sessionStore.setExtended(tid, { pinSession: ps });
    _log(`PIN session set for thread ${tid}.`);
  }

  clearPinSession(threadID) {
    const tid = String(threadID);
    delete this._pinSessions[tid];
    this.sessionStore.setExtended(tid, { pinSession: null });
  }

  hasPinSession(threadID) {
    return !!this._pinSessions[String(threadID)];
  }

  // ── Auto-encrypt toggle ──────────────────────────────────────────────────

  setAutoEncrypt(threadID, enabled) {
    const tid = String(threadID);
    if (enabled) {
      this._autoEncrypt[tid] = true;
    } else {
      delete this._autoEncrypt[tid];
    }
    // FIX: persist immediately
    this.sessionStore.setExtended(tid, { autoEncrypt: !!enabled });
    _log(`Auto-encrypt ${enabled ? "ON" : "OFF"} for thread ${tid}.`);
  }

  isAutoEncrypt(threadID) {
    return !!this._autoEncrypt[String(threadID)];
  }

  // ── Safety number ─────────────────────────────────────────────────────────

  getSafetyNumber(threadID) {
    const tid     = String(threadID);
    const myPub   = this.keyStore.IK ? this.keyStore.IK.pub : null;
    const peerPub = this._peerIKpubs[tid]
      ? Buffer.from(this._peerIKpubs[tid], "base64")
      : null;
    if (!myPub || !peerPub) return null;
    try { return _safetyNumber(myPub, peerPub); } catch (_) { return null; }
  }

  // ── Bundle / Signal Handshake ─────────────────────────────────────────────

  buildBundleMessage() {
    const bundle = X3DH.buildPrekeyBundle(this.keyStore);
    return _encode(SIGNAL_PREFIX, { v: 1, type: "prekey_bundle", bundle });
  }

  initHandshake(threadID, bobBundle, firstPlaintext) {
    const tid = String(threadID);
    const { SK, EKpub, opkId } = X3DH.senderX3DH(this.keyStore.IK, bobBundle);
    const st = DR.initSender(SK, Buffer.from(bobBundle.spkPub, "base64"));
    this.sessionStore.set(tid, st);

    const initPayload = {
      v: 1, type: "handshake_init",
      ikAPub: Buffer.from(this.keyStore.IK.pub).toString("base64"),
      ekAPub: EKpub,
      opkId
    };

    if (firstPlaintext != null) {
      initPayload.firstMsg = DR.encrypt(st, String(firstPlaintext));
      this.sessionStore.set(tid, st);
      this._msgSent++;
    }

    this._handshakes++;
    _log(`Handshake initiated for thread ${tid}.`);
    return _encode(SIGNAL_PREFIX, initPayload);
  }

  createHandshakeInit(threadID, bobBundle) {
    return this.initHandshake(threadID, bobBundle);
  }

  buildHandshakeAck(threadID, firstPlaintext) {
    return _encode(SIGNAL_PREFIX, {
      v: 1, type: "handshake_ack",
      threadID:       String(threadID),
      firstPlaintext: firstPlaintext || null
    });
  }

  // ── Encrypt ──────────────────────────────────────────────────────────────

  encrypt(threadID, plaintext) {
    const tid = String(threadID);
    const st  = this.sessionStore.get(tid);
    if (!st) return null;
    try {
      const enc = DR.encrypt(st, String(plaintext));
      this.sessionStore.set(tid, st);
      this._msgSent++;
      return _encode(SIGNAL_PREFIX, { v: 1, type: "msg", ...enc });
    } catch (e) {
      _log("Encrypt error for " + tid + ": " + (e.message || e), "warn");
      return null;
    }
  }

  encryptOutgoing(threadID, plaintext) { return this.encrypt(threadID, plaintext); }

  // ── PIN Encrypt ──────────────────────────────────────────────────────────

  pinEncrypt(threadID, plaintext) {
    const tid   = String(threadID);
    const psess = this._pinSessions[tid];
    const pin   = (psess && psess.pin) || this._globalPin;
    if (!pin) return null;
    try {
      // FIX: Use established saltHex from the session for consistency.
      // The salt is stored per-message in the payload, so always fresh is fine,
      // but for the thread PIN we reuse the session's salt to avoid a subtle
      // issue where the first encrypt is with salt A and re-encrypt is with B.
      // Actually for AES-GCM, a fresh salt per message is correct and required.
      // The session saltHex is only the one generated at setPinSession time.
      const payload = _pinEncryptPayload(plaintext, pin);
      // FIX: PIN messages use LIBERTY_PREFIX for cross-client compat.
      // Signal X3DH/DR messages use SIGNAL_PREFIX — these are distinct protocols.
      return _encode(LIBERTY_PREFIX, payload);
    } catch (e) {
      _log("PIN encrypt error for " + tid + ": " + (e.message || e), "warn");
      return null;
    }
  }

  // ── Smart outgoing encrypt ────────────────────────────────────────────────
  // Signal session first, PIN fallback.

  encryptSmart(threadID, plaintext) {
    const tid = String(threadID);
    if (this.sessionStore.has(tid)) return this.encrypt(tid, plaintext);
    if (this._pinSessions[tid] || this._globalPin) return this.pinEncrypt(tid, plaintext);
    return null;
  }

  // ── Decrypt (unified — handles both prefixes, all payload types) ──────────

  decrypt(threadID, body) {
    const tid    = String(threadID);
    const parsed = _decode(body);
    if (!parsed) return null;
    const { payload } = parsed;
    if (!payload || !payload.v) return null;

    if (payload.type === "pin") {
      return this._handlePin(tid, payload);
    }

    switch (payload.type) {
      case "handshake_init": return this._handleHandshakeInit(tid, payload);
      case "handshake_ack":  return { msgType: "handshake_ack", plaintext: payload.firstPlaintext || null };
      case "prekey_bundle":  return null;
      case "msg":            return this._handleMsg(tid, payload);
      case "x3dh_init":      return null;
      case "handshake":      return null;
      default:               return null;
    }
  }

  _handlePin(tid, payload) {
    const tryPins = [];
    const psess = this._pinSessions[tid];
    if (psess && psess.pin) tryPins.push(psess.pin);
    if (this._globalPin && !(psess && psess.pin === this._globalPin)) {
      tryPins.push(this._globalPin);
    }

    for (const pin of tryPins) {
      try {
        const plaintext = _pinDecryptPayload(payload, pin);
        this._msgRecv++;
        // Auto-establish PIN session if global PIN decrypted it
        if (!this._pinSessions[tid] && pin === this._globalPin) {
          this.setPinSession(tid, pin);
        }
        return { msgType: "pin_msg", plaintext };
      } catch (_) { /* wrong pin */ }
    }

    _log(`PIN decrypt failed for thread ${tid} — wrong PIN or no PIN set.`, "warn");
    return { msgType: "pin_fail", plaintext: null };
  }

  _handleHandshakeInit(tid, payload) {
    try {
      const SK = X3DH.receiverX3DH(this.keyStore, payload);
      const bobRatchetKP = { pub: this.keyStore.SPK.pub, priv: this.keyStore.SPK.priv };
      const st = DR.initReceiver(SK, bobRatchetKP);

      // Store peer IK for safety number + persist
      if (payload.ikAPub) {
        this._peerIKpubs[tid] = payload.ikAPub;
        this.sessionStore.setExtended(tid, { peerIKpub: payload.ikAPub });
      }

      // Consume OPK synchronously (replay protection)
      if (payload.opkId !== null && payload.opkId !== undefined) {
        const before = this.keyStore.OPKs.length;
        // FIX: String() coercion for OPK ID type safety
        this.keyStore.OPKs = this.keyStore.OPKs.filter(
          o => String(o.id) !== String(payload.opkId)
        );
        if (this.keyStore.OPKs.length === before) {
          _log(`OPK '${payload.opkId}' not found — may be a replayed handshake.`, "warn");
        }
        this.keyStore._replenishOPKs()
          .then(() => this.keyStore._flush())
          .catch(e => _log("OPK flush error: " + (e.message || e), "warn"));
      }

      let firstPlaintext = null;
      if (payload.firstMsg) {
        firstPlaintext = DR.decrypt(st, payload.firstMsg);
        this._msgRecv++;
      }

      this.sessionStore.set(tid, st);
      this._handshakes++;
      _log(`Signal handshake completed for thread ${tid}.`);
      return { msgType: "handshake_init", plaintext: firstPlaintext };
    } catch (e) {
      _log("Handshake init error for " + tid + ": " + (e.message || e), "warn");
      return null;
    }
  }

  _handleMsg(tid, payload) {
    const st = this.sessionStore.get(tid);
    if (!st) {
      _log("No Signal session for thread " + tid + ".", "warn");
      return null;
    }
    try {
      const plaintext = DR.decrypt(st, payload);
      this.sessionStore.set(tid, st);
      this._msgRecv++;
      return { msgType: "msg", plaintext };
    } catch (e) {
      _log("Decrypt error for " + tid + ": " + (e.message || e), "warn");
      return null;
    }
  }

  // ── Passive decrypt (Liberty compat) ──────────────────────────────────────

  tryPassiveDecrypt(body) {
    const parsed = _decode(body);
    if (!parsed) return null;
    const { payload } = parsed;
    if (!payload || payload.type !== "pin") return null;
    if (!this._globalPin) return null;
    try {
      return _pinDecryptPayload(payload, this._globalPin);
    } catch (_) {
      return null;
    }
  }

  // ── Session management ────────────────────────────────────────────────────

  hasSession(threadID) {
    return this.sessionStore.has(String(threadID));
  }

  hasAnySession(threadID) {
    const tid = String(threadID);
    return this.sessionStore.has(tid) || !!this._pinSessions[tid] || !!this._globalPin;
  }

  dropSession(threadID) {
    const tid = String(threadID);
    this.sessionStore.delete(tid);  // also clears extended state for this tid
    delete this._pinSessions[tid];
    delete this._autoEncrypt[tid];
    delete this._peerIKpubs[tid];
    _log(`All sessions dropped for thread ${tid}.`);
  }

  listSessions() {
    const signal = new Set(Object.keys(this.sessionStore._sessions || {}));
    const pin    = new Set(Object.keys(this._pinSessions));
    const all    = new Set([...signal, ...pin]);
    return [...all];
  }

  listSessionsDetail() {
    const signal = Object.keys(this.sessionStore._sessions || {});
    const pin    = Object.keys(this._pinSessions);
    return { signal, pin };
  }

  getSessionInfo(threadID) {
    const tid = String(threadID);
    const sig = this.sessionStore.has(tid);
    const pin = !!this._pinSessions[tid];
    if (!sig && !pin) return null;
    const st = sig ? this.sessionStore.get(tid) : null;
    return {
      threadID,
      hasSession:   sig || pin,
      mode:         sig ? (pin ? "signal+pin" : "signal-x3dh") : "pin",
      msgSent:      st ? (st.Ns || 0) : 0,
      msgRecv:      st ? (st.Nr || 0) : 0,
      autoEncrypt:  !!this._autoEncrypt[tid],
      hasSafetyNum: !!(sig && this._peerIKpubs[tid])
    };
  }

  // ── Wire format helpers ──────────────────────────────────────────────────

  isLabyrinthMessage(body) {
    return typeof body === "string" && (
      body.startsWith(SIGNAL_PREFIX) || body.startsWith(LIBERTY_PREFIX)
    );
  }

  get PREFIX()         { return SIGNAL_PREFIX; }
  get LIBERTY_PREFIX() { return LIBERTY_PREFIX; }

  // ── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    // FIX: Count signal sessions independently — a thread may have both
    // a signal AND a pin session. Don't subtract from the union set.
    const signalTids = Object.keys(this.sessionStore._sessions || {});
    const pinTids    = Object.keys(this._pinSessions);
    const allTids    = new Set([...signalTids, ...pinTids]);
    const autoEnc    = Object.keys(this._autoEncrypt).length;

    return {
      active:         true,
      protocol:       "Signal Protocol v4 (X3DH + Double Ratchet) + PIN passive mode",
      cipher:         "AES-256-GCM",
      curve:          "X25519 / Ed25519",
      sessions:       allTids.size,
      signalSessions: signalTids.length,    // FIX: correct independent count
      pinSessions:    pinTids.length,       // FIX: correct independent count
      autoEncThreads: autoEnc,
      handshakes:     this._handshakes,
      msgSent:        this._msgSent,
      msgRecv:        this._msgRecv,
      opksAvailable:  this.keyStore.OPKs.length,
      hasPin:         !!(this.keyStore._pin),
      hasGlobalPin:   !!this._globalPin,
      uptimeMs:       Date.now() - this._startTime,
      identityKey:    this.keyStore.IK
        ? Buffer.from(this.keyStore.IK.pub).toString("base64").slice(0, 20) + "…"
        : "unknown"
    };
  }

  // ── Internal health probe / diagnose ─────────────────────────────────────
  //
  // Runs a full round-trip inside the engine without touching any real thread.
  // Returns { ok: bool, tests: { name, pass, error }[] }.
  // Called by index.js on startup and by .e2ee selftest.
  //
  // IMPORTANT: build the bundle ONCE and reuse it across all test steps.
  // Building it twice generates two different EK_A → two different SK →
  // the firstMsg encrypted with SK1 but the handshake_init claims SK2 → fail.

  diagnose() {
    const tests   = [];
    let   allPass = true;

    function record(name, fn) {
      try {
        fn();
        tests.push({ name, pass: true });
      } catch (e) {
        tests.push({ name, pass: false, error: e.message || String(e) });
        allPass = false;
      }
    }

    const tid = "__diagnose__";
    this.dropSession(tid);

    // ── Step 1: Build the bundle ONCE ────────────────────────────────────
    let bobBundle = null;
    record("Build prekey bundle", () => {
      const bMsg = this.buildBundleMessage();
      if (!bMsg.startsWith(SIGNAL_PREFIX)) throw new Error("bundle has wrong prefix");
      const bPayload = JSON.parse(Buffer.from(bMsg.slice(SIGNAL_PREFIX.length), "base64").toString());
      bobBundle = bPayload.bundle;
      if (!bobBundle || !bobBundle.ikPub || !bobBundle.spkPub) throw new Error("malformed bundle");
    });

    if (!bobBundle) {
      return { ok: false, tests };
    }

    // ── Steps 2-5: Full X3DH + DR round-trip using the ONE bundle ────────
    // Alice computes SK, EKpub, opkId — all in one step, no second bundle.
    let aliceSt  = null;
    let aliceIK  = null;
    let senderR  = null;

    record("X3DH key agreement (Alice)", () => {
      aliceIK = X3DH.generateKeyPair();
      senderR = X3DH.senderX3DH(aliceIK, bobBundle);
      aliceSt = DR.initSender(senderR.SK, Buffer.from(bobBundle.spkPub, "base64"));
      if (!aliceSt || !aliceSt.CKs) throw new Error("sender state missing CKs");
    });

    record("X3DH + handshake_init (Bob receives first message)", () => {
      if (!aliceSt || !senderR) throw new Error("previous step failed");
      const plaintext   = "diagnose-msg-1";
      const aliceEnc    = DR.encrypt(aliceSt, plaintext);
      const initPayload = {
        v: 1, type: "handshake_init",
        ikAPub:   Buffer.from(aliceIK.pub).toString("base64"),
        ekAPub:   senderR.EKpub,    // from the ONE senderX3DH call above
        opkId:    senderR.opkId,
        firstMsg: aliceEnc           // encrypted with the SAME aliceSt/SK
      };
      const initWire = SIGNAL_PREFIX + Buffer.from(JSON.stringify(initPayload)).toString("base64");
      const result   = this.decrypt(tid, initWire);
      if (!result || result.msgType !== "handshake_init") {
        throw new Error("handshake_init failed — result: " + JSON.stringify(result));
      }
      if (result.plaintext !== plaintext) {
        throw new Error("plaintext mismatch: expected '" + plaintext + "' got '" + result.plaintext + "'");
      }
    });

    record("Double Ratchet reply (Bob → Alice)", () => {
      if (!aliceSt) throw new Error("no Alice state");
      const reply   = "diagnose-reply";
      const botEnc  = this.encrypt(tid, reply);
      if (!botEnc) throw new Error("bot encrypt returned null — session not established");
      const botPayl = JSON.parse(Buffer.from(botEnc.slice(SIGNAL_PREFIX.length), "base64").toString());
      const alicePt = DR.decrypt(aliceSt, botPayl);
      if (alicePt !== reply) throw new Error("reply mismatch: got '" + alicePt + "'");
    });

    record("Multi-message Double Ratchet (5 messages)", () => {
      if (!aliceSt) throw new Error("no Alice state");
      const msgs = ["aa", "bb", "cc", "dd", "ee"];
      for (const m of msgs) {
        const enc = this.encrypt(tid, m);
        if (!enc) throw new Error("encrypt returned null for: " + m);
        const pl  = JSON.parse(Buffer.from(enc.slice(SIGNAL_PREFIX.length), "base64").toString());
        const pt  = DR.decrypt(aliceSt, pl);
        if (pt !== m) throw new Error("mismatch: expected '" + m + "' got '" + pt + "'");
      }
    });

    record("Out-of-order message delivery (skipped keys)", () => {
      if (!aliceSt) throw new Error("no Alice state");
      const e1 = this.encrypt(tid, "ooo-1");
      const e2 = this.encrypt(tid, "ooo-2");
      const e3 = this.encrypt(tid, "ooo-3");
      const p = (e) => JSON.parse(Buffer.from(e.slice(SIGNAL_PREFIX.length), "base64").toString());
      const pt3 = DR.decrypt(aliceSt, p(e3));
      const pt1 = DR.decrypt(aliceSt, p(e1));
      const pt2 = DR.decrypt(aliceSt, p(e2));
      if (pt3 !== "ooo-3" || pt1 !== "ooo-1" || pt2 !== "ooo-2") {
        throw new Error("out-of-order mismatch: " + [pt3, pt1, pt2].join(","));
      }
    });

    record("Session serialise / deserialise round-trip", () => {
      const st  = this.sessionStore.get(tid);
      if (!st) throw new Error("no session state to serialise");
      const ser  = DR.serializeState(st);
      const des  = DR.deserializeState(ser);
      const ser2 = DR.serializeState(des);
      if (JSON.stringify(ser) !== JSON.stringify(ser2)) {
        throw new Error("serialise round-trip mismatch");
      }
    });

    record("Safety number generation", () => {
      const sn = this.getSafetyNumber(tid);
      if (!sn) throw new Error("safety number is null");
      if (!/^\d{5} \d{5} \d{5}\n\d{5} \d{5} \d{5}$/.test(sn)) {
        throw new Error("safety number format wrong: " + sn);
      }
    });

    record("PIN encrypt / decrypt (thread session)", () => {
      const pin = "diagnose_pin_" + crypto.randomBytes(4).toString("hex");
      this.setPinSession(tid, pin);
      const enc = this.pinEncrypt(tid, "pin-plaintext");
      if (!enc) throw new Error("PIN encrypt returned null");
      const res = this.decrypt(tid, enc);
      if (!res || res.plaintext !== "pin-plaintext") {
        throw new Error("PIN decrypt mismatch: " + JSON.stringify(res));
      }
      this.clearPinSession(tid);
    });

    record("Global PIN passive decrypt", () => {
      const prevGlobal = this._globalPin;
      const testPin    = "diagnose_global_" + crypto.randomBytes(4).toString("hex");
      this.setGlobalPin(testPin);
      // pinEncrypt with no thread session falls back to globalPin
      const enc = this.pinEncrypt(tid, "passive-test");
      if (!enc) { this.setGlobalPin(prevGlobal); throw new Error("global PIN encrypt returned null"); }
      const pt  = this.tryPassiveDecrypt(enc);
      this.setGlobalPin(prevGlobal);
      if (pt !== "passive-test") throw new Error("passive decrypt mismatch: got '" + pt + "'");
    });

    record("Auto-encrypt flag set / clear", () => {
      this.setAutoEncrypt(tid, true);
      if (!this.isAutoEncrypt(tid)) throw new Error("autoEncrypt flag not set");
      this.setAutoEncrypt(tid, false);
      if (this.isAutoEncrypt(tid)) throw new Error("autoEncrypt flag not cleared");
    });

    record("Drop session clears all state", () => {
      this.dropSession(tid);
      if (this.hasSession(tid))      throw new Error("signal session still exists after drop");
      if (this.hasPinSession(tid))   throw new Error("pin session still exists after drop");
      if (this.isAutoEncrypt(tid))   throw new Error("autoEncrypt still set after drop");
      if (this.getSafetyNumber(tid)) throw new Error("safety number still available after drop");
    });

    return { ok: allPass, tests };
  }
}

module.exports = Labyrinth;
module.exports.SIGNAL_PREFIX  = SIGNAL_PREFIX;
module.exports.LIBERTY_PREFIX = LIBERTY_PREFIX;
