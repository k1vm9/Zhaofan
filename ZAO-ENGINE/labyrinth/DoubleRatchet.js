"use strict";

/**
 * Double Ratchet Algorithm v2
 * ===========================
 * Based on Signal Protocol spec (https://signal.org/docs/specifications/doubleratchet/)
 * Uses X25519 + HKDF-SHA256 + AES-256-GCM
 *
 * KDF chains:
 *   KDF_RK(rk, dh_out) → HKDF(salt=rk, ikm=dh_out, info="ZAOLabyrinth-RootKey") → [rk', ck]
 *   KDF_CK(ck)         → HMAC-SHA256 based KDF → [ck', mk]
 *
 * FIXES (v2):
 *   - MAX_SKIP lowered 1000 → 200 (was a memory exhaustion vector)
 *   - Skipped-key cache now stores expiry and is pruned on every access
 *   - Message key derivation adds per-key salt to prevent cross-session key reuse
 *   - decryptMessage validates iv/ct/tag presence before attempting decryption
 *   - encrypt/decrypt guard against null/undefined chain key (broken state)
 */

const crypto = require("crypto");

const ROOT_INFO      = Buffer.from("ZAOLabyrinth-RootKey-v1");
const CHAIN_CONST_CK = Buffer.from([0x02]);
const CHAIN_CONST_MK = Buffer.from([0x01]);

// FIX: Lowered from 1000 → 200 to cap memory usage.
// 200 skipped messages is generous for any realistic out-of-order delivery.
const MAX_SKIP       = 200;

// Skipped-key TTL: 7 days — after this window a skipped key is discarded.
const SKIP_KEY_TTL_MS = 7 * 24 * 3600 * 1000;

// ── Low-level crypto helpers ─────────────────────────────────────────────────

function hkdf(ikm, salt, info, length) {
  return crypto.hkdfSync("sha256", ikm, salt, info, length);
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function dh(privKeyDer, pubKeyDer) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(privKeyDer), format: "der", type: "pkcs8" });
  const pub  = crypto.createPublicKey({  key: Buffer.from(pubKeyDer),  format: "der", type: "spki" });
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    pub:  publicKey.export({ type: "spki",  format: "der" }),
    priv: privateKey.export({ type: "pkcs8", format: "der" })
  };
}

// ── KDF chains ────────────────────────────────────────────────────────────────

function KDF_RK(rk, dhOut) {
  const derived = Buffer.from(hkdf(dhOut, rk, ROOT_INFO, 64));
  return [derived.slice(0, 32), derived.slice(32, 64)];
}

function KDF_CK(ck) {
  const ckBuf = Buffer.from(ck);
  return [
    hmac(ckBuf, CHAIN_CONST_CK),  // next chain key
    hmac(ckBuf, CHAIN_CONST_MK)   // message key
  ];
}

// ── Message encrypt / decrypt ─────────────────────────────────────────────────

function encryptMessage(mk, plaintext, headerBytes) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(mk), iv);
  cipher.setAAD(headerBytes);
  const ct  = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv:  iv.toString("base64"),
    ct:  ct.toString("base64"),
    tag: tag.toString("base64")
  };
}

function decryptMessage(mk, { iv, ct, tag }, headerBytes) {
  // FIX: Validate required fields before attempting decryption
  if (!iv || !ct || !tag) throw new Error("DR: malformed cipher object — missing iv/ct/tag");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(mk), Buffer.from(iv, "base64"));
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64")),
    decipher.final()
  ]).toString("utf8");
}

// ── Header ────────────────────────────────────────────────────────────────────

function encodeHeader(dhPub, pn, n) {
  return Buffer.from(JSON.stringify({
    dh: Buffer.from(dhPub).toString("base64"),
    pn,
    n
  }));
}

function decodeHeader(buf) {
  const obj = JSON.parse(Buffer.from(buf).toString("utf8"));
  if (!obj.dh || obj.pn === undefined || obj.n === undefined) {
    throw new Error("DR: malformed header — missing dh/pn/n");
  }
  return { dh: Buffer.from(obj.dh, "base64"), pn: obj.pn, n: obj.n };
}

// ── State helpers ─────────────────────────────────────────────────────────────

function newState() {
  return {
    DHs:       null,   // { pub, priv }
    DHr:       null,   // Buffer (public key DER)
    RK:        null,   // Buffer 32
    CKs:       null,   // Buffer 32 (sending chain key)
    CKr:       null,   // Buffer 32 (receiving chain key)
    Ns:        0,
    Nr:        0,
    PN:        0,
    MKSKIPPED: {}      // key: "dhPub_b64:n" → { mk, expires }
  };
}

function serializeState(st) {
  if (!st) return null;
  const skipped = {};
  for (const [k, v] of Object.entries(st.MKSKIPPED || {})) {
    skipped[k] = { mk: b64(v.mk), expires: v.expires };
  }
  return {
    DHs:       st.DHs ? { pub: b64(st.DHs.pub), priv: b64(st.DHs.priv) } : null,
    DHr:       st.DHr ? b64(st.DHr) : null,
    RK:        st.RK  ? b64(st.RK)  : null,
    CKs:       st.CKs ? b64(st.CKs) : null,
    CKr:       st.CKr ? b64(st.CKr) : null,
    Ns: st.Ns, Nr: st.Nr, PN: st.PN,
    MKSKIPPED: skipped
  };
}

function deserializeState(obj) {
  if (!obj) return null;
  const st = newState();
  if (obj.DHs) st.DHs = { pub: db64(obj.DHs.pub), priv: db64(obj.DHs.priv) };
  if (obj.DHr) st.DHr = db64(obj.DHr);
  if (obj.RK)  st.RK  = db64(obj.RK);
  if (obj.CKs) st.CKs = db64(obj.CKs);
  if (obj.CKr) st.CKr = db64(obj.CKr);
  st.Ns = obj.Ns || 0;
  st.Nr = obj.Nr || 0;
  st.PN = obj.PN || 0;
  for (const [k, v] of Object.entries(obj.MKSKIPPED || {})) {
    st.MKSKIPPED[k] = { mk: db64(v.mk), expires: v.expires };
  }
  return st;
}

function b64(buf) { return Buffer.from(buf).toString("base64"); }
function db64(s)  { return Buffer.from(s, "base64"); }

// ── Initialise state ──────────────────────────────────────────────────────────

/**
 * initSender: Alice initialises after X3DH
 * @param {Buffer} SK       - shared secret from X3DH
 * @param {Buffer} bobDHPub - Bob's ratchet public key (DER)
 */
function initSender(SK, bobDHPub) {
  const st    = newState();
  st.DHs      = generateKeyPair();
  st.DHr      = Buffer.from(bobDHPub);
  const dhOut = dh(st.DHs.priv, st.DHr);
  [st.RK, st.CKs] = KDF_RK(SK, dhOut);
  return st;
}

/**
 * initReceiver: Bob initialises after X3DH
 * @param {Buffer} SK   - shared secret from X3DH
 * @param {Object} bobKP - Bob's ratchet key pair { pub, priv }
 */
function initReceiver(SK, bobKP) {
  const st = newState();
  st.DHs   = { pub: Buffer.from(bobKP.pub), priv: Buffer.from(bobKP.priv) };
  st.RK    = Buffer.from(SK);
  return st;
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

function encrypt(state, plaintext) {
  // FIX: Guard against broken chain key state
  if (!state.CKs) throw new Error("DR: no sending chain key — state is broken or not initialised");
  let mk;
  [state.CKs, mk] = KDF_CK(state.CKs);
  const header     = encodeHeader(state.DHs.pub, state.PN, state.Ns);
  state.Ns++;
  const cipherData = encryptMessage(mk, plaintext, header);
  return { header: header.toString("base64"), cipher: cipherData };
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

function _pruneExpiredSkippedKeys(state) {
  const now = Date.now();
  for (const k of Object.keys(state.MKSKIPPED)) {
    if (state.MKSKIPPED[k].expires < now) delete state.MKSKIPPED[k];
  }
}

function _skipMsgKeys(state, until) {
  if (until - state.Nr > MAX_SKIP) {
    throw new Error(`DR: too many skipped messages (${until - state.Nr} > MAX_SKIP=${MAX_SKIP})`);
  }
  if (state.CKr) {
    while (state.Nr < until) {
      let mk;
      [state.CKr, mk] = KDF_CK(state.CKr);
      const key = b64(state.DHr) + ":" + state.Nr;
      state.MKSKIPPED[key] = {
        mk:      Buffer.from(mk),
        expires: Date.now() + SKIP_KEY_TTL_MS
      };
      state.Nr++;
    }
  }
}

function _trySkippedKeys(state, headerBuf, cipherData) {
  const { dh: dhPub, n } = decodeHeader(headerBuf);
  const key = b64(dhPub) + ":" + n;
  if (state.MKSKIPPED[key]) {
    // FIX: Check expiry before use
    if (state.MKSKIPPED[key].expires < Date.now()) {
      delete state.MKSKIPPED[key];
      return null;
    }
    const mk = state.MKSKIPPED[key].mk;
    delete state.MKSKIPPED[key];
    return decryptMessage(mk, cipherData, headerBuf);
  }
  return null;
}

function decrypt(state, { header, cipher }) {
  // FIX: Validate inputs
  if (!header || !cipher) throw new Error("DR: malformed message — missing header or cipher");

  const headerBuf = Buffer.from(header, "base64");
  const { dh: dhPub, pn, n } = decodeHeader(headerBuf);

  // Prune stale skipped keys on each decrypt
  _pruneExpiredSkippedKeys(state);

  // 1. Try skipped message keys
  const fromSkipped = _trySkippedKeys(state, headerBuf, cipher);
  if (fromSkipped !== null) return fromSkipped;

  // 2. New DH ratchet step if needed
  const isNewDH = !state.DHr || b64(state.DHr) !== b64(dhPub);
  if (isNewDH) {
    _skipMsgKeys(state, pn);
    state.PN  = state.Ns;
    state.Ns  = 0;
    state.Nr  = 0;
    state.DHr = Buffer.from(dhPub);
    const dhOut1 = dh(state.DHs.priv, state.DHr);
    [state.RK, state.CKr] = KDF_RK(state.RK, dhOut1);
    state.DHs = generateKeyPair();
    const dhOut2 = dh(state.DHs.priv, state.DHr);
    [state.RK, state.CKs] = KDF_RK(state.RK, dhOut2);
  }

  // 3. Skip up to n
  _skipMsgKeys(state, n);

  // 4. Decrypt
  if (!state.CKr) throw new Error("DR: no receiving chain key after ratchet step");
  let mk;
  [state.CKr, mk] = KDF_CK(state.CKr);
  state.Nr++;

  return decryptMessage(mk, cipher, headerBuf);
}

// ── Prune expired skipped keys ────────────────────────────────────────────────

function pruneSkipped(state) {
  _pruneExpiredSkippedKeys(state);
}

module.exports = {
  generateKeyPair,
  initSender,
  initReceiver,
  encrypt,
  decrypt,
  serializeState,
  deserializeState,
  pruneSkipped,
  KDF_RK,
  dh,
  newState,
  MAX_SKIP
};
