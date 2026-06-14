module.exports.config = {
  name:            "e2ee",
  version:         "4.0.0",
  hasPermssion:    0,
  credits:         "SAIN / ZAO Labyrinth v4 (Signal + Liberty Protocol)",
  description:     "Unified E2EE — Signal Protocol (X3DH + Double Ratchet) + PIN passive mode",
  commandCategory: "Security",
  usages:          "status | bundle | handshake <msg> | send <msg> | pinmsg <msg> | pin <set|clear> [pin] | autoencrypt <on|off> | verify | selftest | diagnose | drop | list | import <bundle>",
  cooldowns:       3
};

const SIGNAL_PFX  = "🔐ZAO|";
const LIBERTY_PFX = "🔒E2EE:";

function _parseWire(raw) {
  try {
    const stripped = raw.startsWith(SIGNAL_PFX)
      ? raw.slice(SIGNAL_PFX.length)
      : raw.startsWith(LIBERTY_PFX)
        ? raw.slice(LIBERTY_PFX.length)
        : raw;
    return JSON.parse(Buffer.from(stripped, "base64").toString("utf8"));
  } catch (_) { return null; }
}

function _isAdmin(senderID) {
  try {
    const cfg    = global.config || {};
    const admins = [
      ...(cfg.adminBot      || []),
      ...(cfg.ADMINBOT      || []),
      ...(cfg.admin         || []),
      ...(cfg.superAdmin    || []),
      ...(cfg.superAdminBot || [])
    ].map(String);
    return admins.includes(String(senderID));
  } catch (_) { return false; }
}

function _getLab() {
  try { return global._labyrinth || null; } catch (_) { return null; }
}

// ── HELP ──────────────────────────────────────────────────────────────────────
const HELP = [
  "🔐 ZAO E2EE v4 — Commands",
  "",
  "  .e2ee status              — engine + session status",
  "  .e2ee bundle              — publish bot's Signal prekey bundle",
  "  .e2ee handshake <msg>     — complete X3DH handshake (both roles)",
  "  .e2ee send <message>      — send Signal-encrypted message",
  "  .e2ee pinmsg <message>    — send PIN-encrypted message",
  "  .e2ee pin set <pin>       — start PIN session for this thread",
  "  .e2ee pin clear           — remove PIN session for this thread",
  "  .e2ee autoencrypt on/off  — auto-encrypt all outgoing (this thread)",
  "  .e2ee verify              — show safety number for this session",
  "  .e2ee selftest            — comprehensive E2EE round-trip test",
  "  .e2ee diagnose            — internal engine health probe",
  "  .e2ee drop                — destroy all sessions for this thread",
  "  .e2ee list                — list all sessions (admin only)",
  "  .e2ee import <bundle>     — import Liberty-format bundle and respond"
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const lab    = _getLab();
  const action = (args[0] || "status").toLowerCase().trim();

  // ── status ────────────────────────────────────────────────────────────────
  if (action === "status") {
    const lines = ["🔐 ZAO E2EE v4 — Status", ""];
    if (!lab) {
      lines.push("⚠️  Labyrinth not active. Set labyrinth.enabled=true and restart.");
    } else {
      const st        = lab.getStatus ? lab.getStatus() : {};
      const info      = lab.getSessionInfo ? lab.getSessionInfo(threadID) : null;
      const hasSignal = lab.hasSession(threadID);
      const hasPin    = lab.hasPinSession(threadID);

      lines.push(`  Engine:          ✅ Active`);
      lines.push(`  Protocol:        Signal X3DH + Double Ratchet`);
      lines.push(`  Cipher:          AES-256-GCM | Curve: X25519/Ed25519`);
      lines.push(`  PIN passive:     ${st.hasGlobalPin ? "🔑 Enabled" : "⚫ Off"}`);
      lines.push(`  Keystore PIN:    ${st.hasPin ? "🔑 Set (encrypted)" : "⚠️ Not set"}`);
      lines.push(`  Uptime:          ${Math.floor((st.uptimeMs || 0) / 60000)} min`);
      lines.push("");
      lines.push(`  ── This thread (${threadID}) ──`);
      lines.push(`    Signal session: ${hasSignal ? "🔒 Active" : "🔓 None"}`);
      lines.push(`    PIN session:    ${hasPin ? "🔑 Active" : "⚫ None"}`);
      lines.push(`    Auto-encrypt:   ${lab.isAutoEncrypt(threadID) ? "✅ ON" : "⚫ OFF"}`);
      if (info) {
        lines.push(`    DR msgs sent:   ${info.msgSent || 0}`);
        lines.push(`    DR msgs recv:   ${info.msgRecv || 0}`);
        if (info.hasSafetyNum) lines.push("    Safety number:  ✅ (use .e2ee verify)");
      }
      lines.push("");
      lines.push(`  ── Global stats ──`);
      lines.push(`    Total threads:  ${st.sessions || 0}`);
      lines.push(`    Signal:         ${st.signalSessions || 0}`);
      lines.push(`    PIN:            ${st.pinSessions || 0}`);
      lines.push(`    Auto-enc on:    ${st.autoEncThreads || 0} thread(s)`);
      lines.push(`    OPKs left:      ${st.opksAvailable ?? "?"}`);
      lines.push(`    Handshakes:     ${st.handshakes ?? "?"}`);
      lines.push(`    Msgs encrypted: ${st.msgSent ?? "?"}`);
      lines.push(`    Msgs decrypted: ${st.msgRecv ?? "?"}`);
      lines.push(`    Identity key:   ${st.identityKey || "?"}`);
      lines.push("");
      lines.push(HELP);
    }
    return api.sendMessage(lines.join("\n"), threadID, messageID);
  }

  // ── help ──────────────────────────────────────────────────────────────────
  if (action === "help") {
    return api.sendMessage(HELP, threadID, messageID);
  }

  // ── require lab for everything below ─────────────────────────────────────
  if (!lab) {
    return api.sendMessage(
      "⚠️ Labyrinth E2EE is not active.\n" +
      "Set labyrinth.enabled=true in ZAO-SETTINGS.json and restart.",
      threadID, messageID
    );
  }

  // ── bundle ────────────────────────────────────────────────────────────────
  if (action === "bundle") {
    try {
      const bundleMsg = lab.buildBundleMessage();
      return api.sendMessage(
        "🔑 ZAO Prekey Bundle (Signal X3DH)\n\n" +
        "Share this with the peer:\n" +
        "  .e2ee handshake <this bundle>\n\n" +
        "Or paste their bundle here:\n" +
        "  .e2ee handshake <their bundle>\n\n" +
        bundleMsg,
        threadID, messageID
      );
    } catch (e) {
      return api.sendMessage("❌ Bundle error: " + (e.message || e), threadID, messageID);
    }
  }

  // ── handshake ─────────────────────────────────────────────────────────────
  if (action === "handshake") {
    const raw = args.slice(1).join("").trim();
    if (!raw) {
      return api.sendMessage(
        "Usage: .e2ee handshake <bundle or handshake_init>\n\nGet bot bundle: .e2ee bundle",
        threadID, messageID
      );
    }

    const wireRaw = (raw.startsWith(SIGNAL_PFX) || raw.startsWith(LIBERTY_PFX))
      ? raw : SIGNAL_PFX + raw;
    const payload = _parseWire(wireRaw);

    if (!payload || !payload.type) {
      return api.sendMessage(
        "❌ Could not parse payload. Paste the full 🔐ZAO|... or 🔒E2EE:... string.",
        threadID, messageID
      );
    }

    // Bot is Alice (sender) — received a prekey_bundle
    if (payload.type === "prekey_bundle") {
      try {
        const bundle = payload.bundle;
        if (!bundle || !bundle.ikPub || !bundle.spkPub) throw new Error("Malformed bundle");
        if (!bundle.signingIKPub || !bundle.spkSig) throw new Error("Bundle missing signature fields");
        const initWire = lab.initHandshake(threadID, bundle);
        return api.sendMessage(
          "🔐 X3DH Handshake Initiated (sender role)\n\n" +
          "Session established ✓\n\n" +
          "Send this to the peer (they'll run .e2ee handshake <this>):\n\n" +
          initWire,
          threadID, messageID
        );
      } catch (e) {
        return api.sendMessage("❌ Handshake sender error: " + (e.message || e), threadID, messageID);
      }
    }

    // Bot is Bob (receiver) — received a handshake_init
    if (payload.type === "handshake_init") {
      try {
        const result = lab.decrypt(threadID, wireRaw);
        if (!result) {
          return api.sendMessage(
            "❌ Handshake failed — OPK may be consumed or bundle is stale.\n" +
            "Generate a fresh bundle: .e2ee bundle",
            threadID, messageID
          );
        }
        const sn    = lab.getSafetyNumber(threadID);
        const lines = [
          "✅ E2EE Session Established (receiver role)",
          "",
          "🔒 Signal Protocol active:",
          "  • Key Exchange:    X3DH (Extended Triple Diffie-Hellman)",
          "  • Encryption:      AES-256-GCM",
          "  • Forward Secrecy: Double Ratchet ✓",
          "  • Auth Curve:      Ed25519 (SPK signature verified)",
          "  • DH Curve:        X25519",
          result.plaintext ? "\n📩 First message: " + result.plaintext : null,
          sn ? "\n🔑 Safety Number (verify out-of-band):\n" + sn : null,
          "",
          "Use .e2ee send <msg> or .e2ee autoencrypt on"
        ].filter(l => l !== null);
        return api.sendMessage(lines.join("\n"), threadID, messageID);
      } catch (e) {
        return api.sendMessage("❌ Handshake receiver error: " + (e.message || e), threadID, messageID);
      }
    }

    return api.sendMessage(
      "❌ Unknown payload type: " + payload.type +
      "\nExpected: prekey_bundle or handshake_init.",
      threadID, messageID
    );
  }

  // ── send ──────────────────────────────────────────────────────────────────
  if (action === "send") {
    const plaintext = args.slice(1).join(" ").trim();
    if (!plaintext) return api.sendMessage("Usage: .e2ee send <message>", threadID, messageID);
    if (!lab.hasSession(threadID)) {
      return api.sendMessage(
        "🔓 No Signal session for this thread.\n" +
        "Start one: .e2ee bundle → share → peer runs .e2ee handshake <bundle>",
        threadID, messageID
      );
    }
    try {
      const encrypted = lab.encrypt(threadID, plaintext);
      if (!encrypted) throw new Error("Encryption returned null — session may be broken");
      return api.sendMessage(encrypted, threadID, messageID);
    } catch (e) {
      return api.sendMessage("❌ Encrypt error: " + (e.message || e), threadID, messageID);
    }
  }

  // ── pinmsg ────────────────────────────────────────────────────────────────
  if (action === "pinmsg") {
    const plaintext = args.slice(1).join(" ").trim();
    if (!plaintext) return api.sendMessage("Usage: .e2ee pinmsg <message>", threadID, messageID);
    if (!lab.hasPinSession(threadID) && !lab.getGlobalPin()) {
      return api.sendMessage(
        "🔓 No PIN session.\nSet one first: .e2ee pin set <your-pin>",
        threadID, messageID
      );
    }
    try {
      const encrypted = lab.pinEncrypt(threadID, plaintext);
      if (!encrypted) throw new Error("PIN encrypt returned null");
      return api.sendMessage(encrypted, threadID, messageID);
    } catch (e) {
      return api.sendMessage("❌ PIN encrypt error: " + (e.message || e), threadID, messageID);
    }
  }

  // ── pin set/clear ─────────────────────────────────────────────────────────
  if (action === "pin") {
    const sub = (args[1] || "").toLowerCase().trim();
    if (sub === "set") {
      const pin = args.slice(2).join(" ").trim();
      if (!pin) return api.sendMessage("Usage: .e2ee pin set <your-pin>", threadID, messageID);
      if (pin.length < 4) {
        return api.sendMessage("⚠️ PIN must be at least 4 characters.", threadID, messageID);
      }
      lab.setPinSession(threadID, pin);
      return api.sendMessage(
        "🔑 PIN session set for this thread (persisted across restarts).\n" +
        "Both sides must use the same PIN.\n" +
        "Send: .e2ee pinmsg <message>",
        threadID, messageID
      );
    }
    if (sub === "clear") {
      lab.clearPinSession(threadID);
      return api.sendMessage("🔓 PIN session cleared for this thread.", threadID, messageID);
    }
    return api.sendMessage("Usage: .e2ee pin set <pin>  |  .e2ee pin clear", threadID, messageID);
  }

  // ── autoencrypt ───────────────────────────────────────────────────────────
  if (action === "autoencrypt") {
    const sub = (args[1] || "").toLowerCase().trim();
    if (sub === "on") {
      if (!lab.hasAnySession(threadID)) {
        return api.sendMessage(
          "⚠️ No session active for this thread.\n" +
          "Start: Signal → .e2ee handshake | PIN → .e2ee pin set",
          threadID, messageID
        );
      }
      lab.setAutoEncrypt(threadID, true);
      const mode = lab.hasSession(threadID) ? "Signal (X3DH + DR)" : "PIN";
      return api.sendMessage(
        `✅ Auto-encrypt ON — all outgoing messages in this thread will be encrypted using ${mode}.`,
        threadID, messageID
      );
    }
    if (sub === "off") {
      lab.setAutoEncrypt(threadID, false);
      return api.sendMessage("⚫ Auto-encrypt OFF for this thread.", threadID, messageID);
    }
    return api.sendMessage("Usage: .e2ee autoencrypt on  |  .e2ee autoencrypt off", threadID, messageID);
  }

  // ── verify ────────────────────────────────────────────────────────────────
  if (action === "verify") {
    if (!lab.hasSession(threadID)) {
      return api.sendMessage(
        "🔓 No Signal session for this thread.\n" +
        "Safety numbers are available only after a Signal handshake.",
        threadID, messageID
      );
    }
    const sn = lab.getSafetyNumber(threadID);
    if (!sn) {
      return api.sendMessage(
        "⚠️ Safety number unavailable — peer identity key not recorded.\n" +
        "Complete a full handshake first.",
        threadID, messageID
      );
    }
    return api.sendMessage(
      "🔑 Safety Number for this session:\n\n" + sn + "\n\n" +
      "Compare this number with your peer out-of-band (voice call, in-person).\n" +
      "Matching numbers = channel is authenticated and free of man-in-the-middle attacks.",
      threadID, messageID
    );
  }

  // ── diagnose — internal engine health probe ───────────────────────────────
  if (action === "diagnose") {
    if (!_isAdmin(senderID)) {
      return api.sendMessage("⛔ Admin only.", threadID, messageID);
    }
    try {
      api.sendMessage("🔍 Running E2EE engine diagnostics…", threadID, messageID);
      const health = lab.diagnose();
      const lines  = [
        `🔐 Labyrinth v4 — Diagnostics (${health.tests.length} tests)`,
        ""
      ];
      for (const t of health.tests) {
        lines.push(`  ${t.pass ? "✅" : "❌"} ${t.name}${t.error ? " — " + t.error : ""}`);
      }
      lines.push("");
      lines.push(health.ok
        ? "✅ All systems operational — E2EE engine is fully functional."
        : "⚠️ Some tests failed — check bot logs for details."
      );
      return api.sendMessage(lines.join("\n"), threadID, messageID);
    } catch (e) {
      return api.sendMessage("❌ Diagnose error: " + (e.message || e), threadID, messageID);
    }
  }

  // ── selftest — comprehensive external round-trip test ─────────────────────
  if (action === "selftest") {
    try {
      const DR   = require("../../includes/labyrinth/DoubleRatchet");
      const X3DH = require("../../includes/labyrinth/X3DH");
      const crypto = require("crypto");

      const results = [];
      const tid = "_selftest_" + threadID + "_" + Date.now();
      lab.dropSession(tid);

      function check(name, pass, detail) {
        results.push({ name, pass, detail });
        return pass;
      }

      // ── 1. Bundle ──────────────────────────────────────────────────────
      let bobBundle;
      try {
        const bMsg  = lab.buildBundleMessage();
        const bPay  = _parseWire(bMsg);
        bobBundle   = bPay && bPay.bundle;
        check("Build prekey bundle", !!bobBundle && !!bobBundle.ikPub && !!bobBundle.spkPub);
      } catch (e) { check("Build prekey bundle", false, e.message); }

      if (!bobBundle) {
        lab.dropSession(tid);
        return api.sendMessage("❌ Cannot continue — bundle build failed.", threadID, messageID);
      }

      // ── 2. Alice X3DH ─────────────────────────────────────────────────
      let aliceIK, aliceSt, senderR;
      try {
        aliceIK  = X3DH.generateKeyPair();
        senderR  = X3DH.senderX3DH(aliceIK, bobBundle);
        aliceSt  = DR.initSender(senderR.SK, Buffer.from(bobBundle.spkPub, "base64"));
        check("X3DH sender (Alice)", !!aliceSt && !!aliceSt.CKs);
      } catch (e) { check("X3DH sender (Alice)", false, e.message); }

      // ── 3. First message + handshake_init ─────────────────────────────
      const firstMsgText = "🔐 ZAO E2EE v4 self-test — first message";
      let result;
      try {
        const aliceEnc    = DR.encrypt(aliceSt, firstMsgText);
        const initPayload = {
          v: 1, type: "handshake_init",
          ikAPub:   Buffer.from(aliceIK.pub).toString("base64"),
          ekAPub:   senderR.EKpub,
          opkId:    senderR.opkId,
          firstMsg: aliceEnc
        };
        const initWire = SIGNAL_PFX + Buffer.from(JSON.stringify(initPayload)).toString("base64");
        result = lab.decrypt(tid, initWire);
        check("X3DH receiver (Bob) + handshake_init",
          !!result && result.msgType === "handshake_init"
        );
        check("First message decrypted correctly",
          result && result.plaintext === firstMsgText,
          result ? ("got: " + result.plaintext) : "result null"
        );
      } catch (e) {
        check("X3DH receiver + first message", false, e.message);
      }

      // ── 4. Double Ratchet reply (Bot → Alice) ──────────────────────────
      let aliceGotReply = false;
      try {
        const replyText = "✅ Reply from Bot";
        const botEnc    = lab.encrypt(tid, replyText);
        const botPayl   = _parseWire(botEnc);
        const alicePt   = DR.decrypt(aliceSt, botPayl);
        aliceGotReply   = alicePt === replyText;
        check("Double Ratchet reply (Bob→Alice)", aliceGotReply,
          aliceGotReply ? "" : "got: " + alicePt
        );
      } catch (e) { check("Double Ratchet reply (Bob→Alice)", false, e.message); }

      // ── 5. Multi-message ratchet ───────────────────────────────────────
      try {
        const msgs = ["alpha", "beta", "gamma", "delta", "epsilon"];
        let   ok   = true;
        let   err  = "";
        for (const m of msgs) {
          const enc = lab.encrypt(tid, m);
          const pl  = _parseWire(enc);
          const pt  = DR.decrypt(aliceSt, pl);
          if (pt !== m) { ok = false; err = `expected "${m}", got "${pt}"`; break; }
        }
        check("Multi-message Double Ratchet (5 msgs)", ok, err);
      } catch (e) { check("Multi-message Double Ratchet", false, e.message); }

      // ── 6. Out-of-order delivery (skipped keys) ────────────────────────
      try {
        const enc1 = lab.encrypt(tid, "ooo-1");
        const enc2 = lab.encrypt(tid, "ooo-2");
        const enc3 = lab.encrypt(tid, "ooo-3");
        // Decrypt out-of-order: 3, 1, 2
        const pl3  = _parseWire(enc3);
        const pl1  = _parseWire(enc1);
        const pl2  = _parseWire(enc2);
        const pt3  = DR.decrypt(aliceSt, pl3);
        const pt1  = DR.decrypt(aliceSt, pl1);
        const pt2  = DR.decrypt(aliceSt, pl2);
        check("Out-of-order decrypt (skipped keys)",
          pt3 === "ooo-3" && pt1 === "ooo-1" && pt2 === "ooo-2",
          `got: "${pt3}" "${pt1}" "${pt2}"`
        );
      } catch (e) { check("Out-of-order decrypt", false, e.message); }

      // ── 7. Session serialise/deserialise round-trip ───────────────────
      try {
        const st   = lab.sessionStore.get(tid);
        const ser  = DR.serializeState(st);
        const des  = DR.deserializeState(ser);
        const ser2 = DR.serializeState(des);
        check("Session serialise/deserialise", JSON.stringify(ser) === JSON.stringify(ser2));
      } catch (e) { check("Session serialise/deserialise", false, e.message); }

      // ── 8. Safety number ──────────────────────────────────────────────
      try {
        const sn = lab.getSafetyNumber(tid);
        check("Safety number generation",
          !!sn && /^\d{5} \d{5} \d{5}\n\d{5} \d{5} \d{5}$/.test(sn),
          sn ? sn : "null"
        );
      } catch (e) { check("Safety number", false, e.message); }

      // ── 9. PIN encrypt/decrypt ────────────────────────────────────────
      try {
        const testPin = "selftest_pin_" + crypto.randomBytes(3).toString("hex");
        lab.setPinSession(tid, testPin);
        const pinEnc = lab.pinEncrypt(tid, "🔑 PIN test message");
        const pinRes = lab.decrypt(tid, pinEnc);
        check("PIN encrypt/decrypt",
          pinRes && pinRes.plaintext === "🔑 PIN test message",
          pinRes ? JSON.stringify(pinRes) : "null"
        );
      } catch (e) { check("PIN encrypt/decrypt", false, e.message); }

      // ── 10. Global PIN passive decrypt ────────────────────────────────
      try {
        const globalPin = "selftest_global_" + crypto.randomBytes(3).toString("hex");
        const prevGlobal = lab.getGlobalPin();
        lab.setGlobalPin(globalPin);
        const gpEnc = lab.pinEncrypt(tid, "passive-test");
        const gpPt  = lab.tryPassiveDecrypt(gpEnc);
        lab.setGlobalPin(prevGlobal);
        check("Global PIN passive decrypt", gpPt === "passive-test",
          gpPt !== null ? ("got: " + gpPt) : "returned null"
        );
      } catch (e) { check("Global PIN passive decrypt", false, e.message); }

      // ── 11. Auto-encrypt flag persists across set/clear ───────────────
      try {
        lab.setAutoEncrypt(tid, true);
        const on  = lab.isAutoEncrypt(tid);
        lab.setAutoEncrypt(tid, false);
        const off = !lab.isAutoEncrypt(tid);
        check("Auto-encrypt flag (set/clear)", on && off);
      } catch (e) { check("Auto-encrypt flag", false, e.message); }

      // ── 12. Double-encrypt guard ──────────────────────────────────────
      try {
        // A message already in wire format should NOT be re-encrypted
        const alreadyEnc = lab.encrypt(tid, "guard-test");
        const isWire     = alreadyEnc && alreadyEnc.startsWith(SIGNAL_PFX);
        // If we pass it to encryptSmart it should detect it's already encoded
        // (the guard is in index.js _wrapSendMessage, not in encryptSmart itself)
        check("Wire format detection", isWire);
      } catch (e) { check("Wire format detection", false, e.message); }

      // ── 13. OPK count ─────────────────────────────────────────────────
      try {
        const opksBefore = lab.keyStore.OPKs.length;
        check("OPK pool not empty (>= 1)", opksBefore >= 1, `count: ${opksBefore}`);
      } catch (e) { check("OPK pool", false, e.message); }

      // ── Cleanup ───────────────────────────────────────────────────────
      lab.dropSession(tid);

      const passed = results.filter(r => r.pass).length;
      const total  = results.length;
      const lines  = [
        `🔐 Labyrinth v4 — Self-Test (${passed}/${total})`,
        ""
      ];
      for (const r of results) {
        const icon = r.pass ? "✅" : "❌";
        const note = (!r.pass && r.detail) ? ` — ${r.detail}` : "";
        lines.push(`  ${icon} ${r.name}${note}`);
      }
      lines.push("");
      lines.push(passed === total
        ? "✅ All tests passed — E2EE is fully operational."
        : `⚠️ ${total - passed} test(s) failed — review above for details.`
      );

      return api.sendMessage(lines.join("\n"), threadID, messageID);

    } catch (e) {
      return api.sendMessage("❌ Self-test crashed: " + (e.message || e), threadID, messageID);
    }
  }

  // ── drop ──────────────────────────────────────────────────────────────────
  if (action === "drop") {
    const hadSignal = lab.hasSession(threadID);
    const hadPin    = lab.hasPinSession(threadID);
    const hadAuto   = lab.isAutoEncrypt(threadID);
    if (!hadSignal && !hadPin && !hadAuto) {
      return api.sendMessage("⚠️ No active sessions or settings for this thread.", threadID, messageID);
    }
    lab.dropSession(threadID);
    const dropped = [
      hadSignal ? "Signal session" : null,
      hadPin    ? "PIN session"    : null,
      hadAuto   ? "auto-encrypt"   : null
    ].filter(Boolean).join(", ");
    return api.sendMessage("🔓 Dropped: " + dropped + " for this thread.", threadID, messageID);
  }

  // ── list — admin only ─────────────────────────────────────────────────────
  if (action === "list") {
    if (!_isAdmin(senderID)) return api.sendMessage("⛔ Admin only.", threadID, messageID);
    try {
      const detail = lab.listSessionsDetail ? lab.listSessionsDetail() : { signal: [], pin: [] };
      const all    = new Set([...detail.signal, ...detail.pin]);

      if (all.size === 0) {
        return api.sendMessage("📋 No active E2EE sessions.", threadID, messageID);
      }

      let msg = `🔒 Active E2EE sessions (${all.size}):\n\n`;
      let i   = 1;
      for (const tid of all) {
        const info = lab.getSessionInfo ? lab.getSessionInfo(tid) : null;
        const mode = info ? info.mode : "?";
        const msgs = info ? ` [↑${info.msgSent} ↓${info.msgRecv}]` : "";
        const ae   = (info && info.autoEncrypt) ? " [auto-enc]" : "";
        const sn   = (info && info.hasSafetyNum) ? " [sn✓]" : "";
        msg += `${i}. ${tid.slice(0, 30)}\n   Mode: ${mode}${msgs}${ae}${sn}\n`;
        i++;
      }
      return api.sendMessage(msg.trim(), threadID, messageID);
    } catch (e) {
      return api.sendMessage("❌ List error: " + (e.message || e), threadID, messageID);
    }
  }

  // ── import — Liberty-format bundle ────────────────────────────────────────
  if (action === "import") {
    const raw = args.slice(1).join("").trim();
    if (!raw) {
      return api.sendMessage(
        "Usage: .e2ee import <🔒E2EE:... bundle>\n\n" +
        "Accepts Liberty Protocol (WHITE-V3) bundles and responds with ZAO's Signal bundle.",
        threadID, messageID
      );
    }
    try {
      const input   = raw.startsWith(LIBERTY_PFX) ? raw : LIBERTY_PFX + raw;
      const payload = _parseWire(input);
      if (!payload) {
        return api.sendMessage("❌ Could not parse Liberty bundle.", threadID, messageID);
      }
      if (payload.type !== "handshake") {
        return api.sendMessage(
          "❌ Not a Liberty handshake bundle.\n" +
          "Expected type: handshake. Got: " + (payload.type || "unknown"),
          threadID, messageID
        );
      }
      const myBundle = lab.buildBundleMessage();
      return api.sendMessage(
        "🔐 Liberty bundle received (acknowledged).\n\n" +
        "ZAO uses Signal Protocol (X25519). Here is ZAO's bundle:\n\n" +
        myBundle + "\n\n" +
        "For PIN-only encryption (works with Liberty):\n" +
        "  .e2ee pin set <shared-pin>  then  .e2ee pinmsg <message>",
        threadID, messageID
      );
    } catch (e) {
      return api.sendMessage("❌ Import error: " + (e.message || e), threadID, messageID);
    }
  }

  // fallback
  return api.sendMessage(HELP, threadID, messageID);
};
