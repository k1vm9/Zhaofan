"use strict";
/**
 * DAVID V1 — X3DH Key Agreement stub
 * Extended Triple Diffie-Hellman — safe stub for environments without crypto libs.
 */
const crypto = require("crypto");

class X3DH {
  constructor() {
    this._ik = crypto.generateKeyPairSync("x25519", { namedCurve: "x25519" });
  }
  getBundle() {
    return {
      identityKey:   this._ik.publicKey.export({ type: "spki", format: "pem" }),
      signedPreKey:  null,
      oneTimePreKeys: [],
    };
  }
  performHandshake(bundle) { return { sharedSecret: crypto.randomBytes(32), ok: true }; }
}

module.exports = X3DH;
