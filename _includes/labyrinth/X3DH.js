"use strict";

/**
 * X3DH — Extended Triple Diffie-Hellman Key Agreement
 * ====================================================
 * Based on Signal Protocol spec (https://signal.org/docs/specifications/x3dh/)
 *
 * Roles:
 *   Bob   = the bot  (publishes a prekey bundle)
 *   Alice = the user (initiates the handshake)
 *
 * Key types:
 *   IK  — Long-term identity key (X25519)
 *   SPK — Signed prekey (X25519, rotated periodically)
 *   OPK — One-time prekey (X25519, consumed once)
 *   EK  — Ephemeral key (X25519, generated per handshake by Alice)
 *
 * Shared secret (when Bob has OPK):
 *   DH1 = DH(IK_A, SPK_B)
 *   DH2 = DH(EK_A, IK_B)
 *   DH3 = DH(EK_A, SPK_B)
 *   DH4 = DH(EK_A, OPK_B)
 *   SK  = KDF(DH1 || DH2 || DH3 || DH4)
 *
 * Shared secret (no OPK):
 *   SK  = KDF(DH1 || DH2 || DH3)
 *
 * FIXES (v4):
 *   - OPK ID comparison now uses String() coercion in receiverX3DH to handle
 *     mixed string/number types (legacy numeric IDs vs. new hex string IDs).
 *   - SPK signature is verified before any DH computation.
 */

const crypto = require("crypto");

const X3DH_INFO = Buffer.from("ZAOLabyrinth-X3DH-v1");
const F_BYTES   = Buffer.alloc(32, 0xff);   // 32 × 0xFF prefix (Signal spec)

function dh(privDer, pubDer) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(privDer), format: "der", type: "pkcs8" });
  const pub  = crypto.createPublicKey({  key: Buffer.from(pubDer),  format: "der", type: "spki"  });
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    pub:  publicKey.export({ type: "spki",  format: "der" }),
    priv: privateKey.export({ type: "pkcs8", format: "der" })
  };
}

// ── Signature helpers (Ed25519 for signing SPK) ───────────────────────────

function generateSigningKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    pub:  publicKey.export({ type: "spki",  format: "der" }),
    priv: privateKey.export({ type: "pkcs8", format: "der" })
  };
}

function signPreKey(edPrivDer, spkPubDer) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(edPrivDer), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(spkPubDer), priv).toString("base64");
}

function verifyPreKey(edPubDer, spkPubDer, signatureB64) {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(edPubDer), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(spkPubDer), pub, Buffer.from(signatureB64, "base64"));
  } catch (_) {
    return false;
  }
}

// ── Bob (receiver) publishes a prekey bundle ──────────────────────────────

/**
 * buildPrekeyBundle — called by the bot to build its public prekey bundle.
 * @param {Object} keys   - from KeyStore: { IK, SPK, OPKs, signingIK }
 * @param {string} opkId  - optional specific OPK ID to include
 */
function buildPrekeyBundle(keys, opkId) {
  const opk = opkId !== undefined
    ? (keys.OPKs || []).find(o => String(o.id) === String(opkId))
    : (keys.OPKs || [])[0] || null;

  return {
    ikPub:        Buffer.from(keys.IK.pub).toString("base64"),
    spkPub:       Buffer.from(keys.SPK.pub).toString("base64"),
    spkSig:       keys.SPK.sig,
    signingIKPub: Buffer.from(keys.signingIK.pub).toString("base64"),
    opkId:        opk ? opk.id : null,
    opkPub:       opk ? Buffer.from(opk.kp.pub).toString("base64") : null
  };
}

// ── Alice (sender) performs X3DH ──────────────────────────────────────────

/**
 * senderX3DH — Alice computes the shared secret given Bob's bundle.
 * Returns { SK, EKpub, opkId }
 *
 * @param {Object} aliceIK    - { pub, priv }
 * @param {Object} bobBundle  - from buildPrekeyBundle
 */
function senderX3DH(aliceIK, bobBundle) {
  if (!verifyPreKey(
    Buffer.from(bobBundle.signingIKPub, "base64"),
    Buffer.from(bobBundle.spkPub,       "base64"),
    bobBundle.spkSig
  )) throw new Error("X3DH: SPK signature verification failed — bundle may be tampered");

  const IK_A  = aliceIK;
  const IK_B  = Buffer.from(bobBundle.ikPub,  "base64");
  const SPK_B = Buffer.from(bobBundle.spkPub, "base64");
  const EK_A  = generateKeyPair();

  const DH1 = dh(IK_A.priv,  SPK_B);
  const DH2 = dh(EK_A.priv,  IK_B);
  const DH3 = dh(EK_A.priv,  SPK_B);

  let ikm;
  if (bobBundle.opkPub) {
    const OPK_B = Buffer.from(bobBundle.opkPub, "base64");
    const DH4   = dh(EK_A.priv, OPK_B);
    ikm = Buffer.concat([F_BYTES, DH1, DH2, DH3, DH4]);
  } else {
    ikm = Buffer.concat([F_BYTES, DH1, DH2, DH3]);
  }

  const SK = hkdf(ikm, Buffer.alloc(32, 0), X3DH_INFO, 32);
  return {
    SK,
    EKpub: Buffer.from(EK_A.pub).toString("base64"),
    opkId: bobBundle.opkId
  };
}

// ── Bob (receiver) performs X3DH ─────────────────────────────────────────

/**
 * receiverX3DH — Bob computes the shared secret from Alice's initial message.
 * @param {Object} bobKeys   - from KeyStore: { IK, SPK, OPKs }
 * @param {Object} initMsg   - { ikAPub, ekAPub, opkId }
 *
 * FIX: OPK lookup now uses String() coercion so legacy numeric IDs and new
 * hex-string IDs both match correctly.
 */
function receiverX3DH(bobKeys, initMsg) {
  const IK_A  = Buffer.from(initMsg.ikAPub, "base64");
  const EK_A  = Buffer.from(initMsg.ekAPub, "base64");
  const IK_B  = bobKeys.IK;
  const SPK_B = bobKeys.SPK;

  const DH1 = dh(SPK_B.priv, IK_A);
  const DH2 = dh(IK_B.priv,  EK_A);
  const DH3 = dh(SPK_B.priv, EK_A);

  let ikm;
  // FIX: String() coercion handles mixed string/number OPK ID types.
  if (initMsg.opkId !== null && initMsg.opkId !== undefined) {
    const opkEntry = (bobKeys.OPKs || []).find(o => String(o.id) === String(initMsg.opkId));
    if (!opkEntry) throw new Error(
      `X3DH: OPK '${initMsg.opkId}' not found — already consumed or unknown ID`
    );
    const DH4 = dh(opkEntry.kp.priv, EK_A);
    ikm = Buffer.concat([F_BYTES, DH1, DH2, DH3, DH4]);
  } else {
    ikm = Buffer.concat([F_BYTES, DH1, DH2, DH3]);
  }

  return hkdf(ikm, Buffer.alloc(32, 0), X3DH_INFO, 32);
}

module.exports = {
  generateKeyPair,
  generateSigningKeyPair,
  signPreKey,
  verifyPreKey,
  buildPrekeyBundle,
  senderX3DH,
  receiverX3DH
};
