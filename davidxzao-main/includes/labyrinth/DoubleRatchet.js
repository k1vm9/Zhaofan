"use strict";
/**
 * DAVID V1 — Double Ratchet stub
 * Full Signal Protocol implementation goes here.
 * Currently a safe stub — e2ee.js uses global._labyrinth instead.
 */
class DoubleRatchet {
  constructor(opts = {}) { this.state = {}; this.opts = opts; }
  encrypt(plaintext) { return { ciphertext: Buffer.from(plaintext).toString("base64"), tag: null }; }
  decrypt(ciphertext) { try { return Buffer.from(ciphertext, "base64").toString("utf8"); } catch (_) { return null; } }
  getState() { return this.state; }
  loadState(s) { this.state = s || {}; }
}
module.exports = DoubleRatchet;
