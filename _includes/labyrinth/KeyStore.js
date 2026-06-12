"use strict";

/**
 * Labyrinth Key Store
 * ===================
 * Manages the bot's long-term cryptographic identity:
 *   - Identity key pair       (X25519)
 *   - Signing identity key    (Ed25519) — used to sign the SPK
 *   - Signed prekey pair      (X25519, rotated every SPK_ROTATION_DAYS)
 *   - One-time prekey pool    (X25519 pool of OPK_POOL_SIZE)
 *
 * All private keys are stored encrypted with a PIN using
 * PBKDF2 → AES-256-GCM so the key file is safe at rest.
 *
 * If no PIN is set (empty string) keys are stored plaintext.
 *
 * FIX (v2): OPK IDs now use crypto.randomBytes(4).toString('hex') instead of
 * Date.now() + i to prevent ID collisions across restarts in the same millisecond.
 */

const crypto   = require("crypto");
const fs       = require("fs-extra");
const path     = require("path");
const X3DH     = require("./X3DH");

const SPK_ROTATION_DAYS = 7;
const OPK_POOL_SIZE     = 10;
const PBKDF2_ITERS      = 210_000;
const SALT_LEN          = 32;

function _log(msg, level) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ LABYRINTH ]: ", color: ["red", "cyan"] },
        { message: msg, color: level === "warn" ? "yellow" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[LABYRINTH]", msg);
}

function b64(buf)  { return Buffer.from(buf).toString("base64"); }
function db64(str) { return Buffer.from(str, "base64"); }

/**
 * Generate a unique OPK ID — 8 hex chars (4 random bytes).
 * Vastly more collision-resistant than Date.now() + i.
 */
function _newOpkId() {
  return crypto.randomBytes(4).toString("hex");
}

// ── PIN-based encryption helpers ─────────────────────────────────────────

function _deriveKeyFromPin(pin, saltBuf) {
  return crypto.pbkdf2Sync(
    Buffer.from(String(pin || ""), "utf8"),
    saltBuf,
    PBKDF2_ITERS,
    32,
    "sha256"
  );
}

function _encryptWithPin(pin, plainBuf) {
  if (!pin) return { plain: b64(plainBuf) };
  const salt  = crypto.randomBytes(SALT_LEN);
  const key   = _deriveKeyFromPin(pin, salt);
  const iv    = crypto.randomBytes(12);
  const c     = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct    = Buffer.concat([c.update(plainBuf), c.final()]);
  const tag   = c.getAuthTag();
  return {
    enc:  true,
    salt: b64(salt),
    iv:   b64(iv),
    ct:   b64(ct),
    tag:  b64(tag)
  };
}

function _decryptWithPin(pin, obj) {
  if (obj.plain) return db64(obj.plain);
  if (!pin) throw new Error("KeyStore: PIN required to decrypt keys");
  const salt = db64(obj.salt);
  const key  = _deriveKeyFromPin(pin, salt);
  const d    = crypto.createDecipheriv("aes-256-gcm", key, db64(obj.iv));
  d.setAuthTag(db64(obj.tag));
  return Buffer.concat([d.update(db64(obj.ct)), d.final()]);
}

// ── Key pair serialisation ────────────────────────────────────────────────

function _serializeKP(kp, pin) {
  return {
    pub:  b64(kp.pub),
    priv: _encryptWithPin(pin, Buffer.from(kp.priv))
  };
}

function _deserializeKP(obj, pin) {
  return {
    pub:  db64(obj.pub),
    priv: _decryptWithPin(pin, obj.priv)
  };
}

// ── KeyStore class ────────────────────────────────────────────────────────

class KeyStore {
  constructor(filePath, pin) {
    this._file = filePath || path.join(process.cwd(), "data", "labyrinth-keys.json");
    this._pin  = pin || "";
    this._data = null;
    this.IK        = null;
    this.signingIK = null;
    this.SPK       = null;
    this.OPKs      = [];
  }

  // Load from disk; generate fresh keys if not found
  async init() {
    await fs.ensureDir(path.dirname(this._file));
    try {
      if (await fs.pathExists(this._file)) {
        const raw   = await fs.readJSON(this._file);
        this._data  = raw;
        this.IK        = _deserializeKP(raw.IK,        this._pin);
        this.signingIK = _deserializeKP(raw.signingIK, this._pin);
        this.SPK       = {
          pub:  db64(raw.SPK.pub),
          priv: _decryptWithPin(this._pin, raw.SPK.priv),
          sig:  raw.SPK.sig,
          createdAt: raw.SPK.createdAt
        };
        this.OPKs = (raw.OPKs || []).map(o => ({
          id:  o.id,   // keep original type (hex string or legacy number)
          kp:  _deserializeKP(o.kp, this._pin)
        }));
        _log(`Keys loaded — ${this.OPKs.length} OPK(s) available.`);

        await this._maybeRotateSPK();
        await this._replenishOPKs();
      } else {
        await this._generateFreshKeys();
      }
    } catch (e) {
      _log("Key load failed: " + (e.message || e) + " — generating fresh keys.", "warn");
      await this._generateFreshKeys();
    }
  }

  async _generateFreshKeys() {
    _log("Generating new identity keys…");
    this.IK        = X3DH.generateKeyPair();
    this.signingIK = X3DH.generateSigningKeyPair();
    this.SPK       = this._newSPK();
    this.OPKs      = this._newOPKs(OPK_POOL_SIZE);
    await this._flush();
    _log("Identity keys generated and saved.");
  }

  _newSPK() {
    const kp  = X3DH.generateKeyPair();
    const sig = X3DH.signPreKey(this.signingIK.priv, kp.pub);
    return { pub: kp.pub, priv: kp.priv, sig, createdAt: Date.now() };
  }

  _newOPKs(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      // FIX: use cryptographically random 8-hex-char IDs instead of Date.now()+i
      out.push({ id: _newOpkId(), kp: X3DH.generateKeyPair() });
    }
    return out;
  }

  async _maybeRotateSPK() {
    const ageDays = (Date.now() - (this.SPK.createdAt || 0)) / 86400000;
    if (ageDays >= SPK_ROTATION_DAYS) {
      _log("SPK is stale — rotating signed prekey.");
      this.SPK = this._newSPK();
      await this._flush();
    }
  }

  async _replenishOPKs() {
    if (this.OPKs.length < OPK_POOL_SIZE / 2) {
      const needed = OPK_POOL_SIZE - this.OPKs.length;
      _log(`OPK pool low (${this.OPKs.length}) — generating ${needed} more.`);
      this.OPKs.push(...this._newOPKs(needed));
      await this._flush();
    }
  }

  /**
   * Consume (remove) a one-time prekey after use.
   * NOTE: Labyrinth._handleHandshakeInit already does the in-memory filter
   * synchronously for replay protection. This method is for async flush + replenish.
   */
  async consumeOPK(id) {
    // String-compare to handle both legacy numeric and new hex string IDs
    this.OPKs = this.OPKs.filter(o => String(o.id) !== String(id));
    await this._replenishOPKs();
    await this._flush();
  }

  async _flush() {
    const out = {
      version: 2,
      IK:        _serializeKP(this.IK, this._pin),
      signingIK: _serializeKP(this.signingIK, this._pin),
      SPK: {
        pub:       b64(this.SPK.pub),
        priv:      _encryptWithPin(this._pin, Buffer.from(this.SPK.priv)),
        sig:       this.SPK.sig,
        createdAt: this.SPK.createdAt
      },
      OPKs: this.OPKs.map(o => ({
        id: o.id,
        kp: _serializeKP(o.kp, this._pin)
      }))
    };
    try {
      // Atomic write: tmp → rename so a mid-write crash never corrupts keys.
      const tmpFile = this._file + ".tmp";
      await fs.writeJSON(tmpFile, out, { spaces: 2 });
      await fs.move(tmpFile, this._file, { overwrite: true });
    } catch (e) {
      _log("Key file write error: " + (e.message || e), "warn");
    }
  }

  // Update PIN (re-encrypt all keys with the new PIN)
  async changePin(newPin) {
    this._pin = newPin || "";
    await this._flush();
    _log("PIN changed — keys re-encrypted.");
  }
}

module.exports = KeyStore;
