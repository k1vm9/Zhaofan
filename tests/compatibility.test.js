"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  normalizeCommand,
  getLegacyUnsupportedGlobals,
  loadLegacyEvents,
} = require("../src/engine/loader");
const { mergeLegacySettings } = require("../src/utils/zaoCompatibility");
const { ACCOUNT_PATH } = require("../src/utils/runtimePaths");
const { parseCookieInput, hasMandatory } = require("../Djamel-fca/lib/cookies");

test("legacy permission levels map to Djamel roles", () => {
  const normalized = normalizeCommand({
    config: { name: "OldCommand", hasPermssion: 2, commandCategory: "Utility" },
  }, { legacyZAO: true });
  assert.equal(normalized.config.name, "oldcommand");
  assert.equal(normalized.config.role, 2);
  assert.equal(normalized.config.category, "Utility");
  assert.equal(normalized.__legacyZAO, true);
});

test("Djamel role is preferred, while compatible legacy commands default to public", () => {
  const explicit = normalizeCommand({
    config: { name: "explicit", role: 1, hasPermssion: 3 },
  }, { legacyZAO: true });
  const publicLegacy = normalizeCommand({
    config: { name: "public", hasPermssion: 0 },
  }, { legacyZAO: true });
  assert.equal(explicit.config.role, 1);
  assert.equal(publicLegacy.config.role, 0);
});

test("unsupported ZAO globals are not silently accepted by the compatibility loader", () => {
  assert.deepEqual(
    getLegacyUnsupportedGlobals("global.config.PREFIX; global._botApi.sendMessage(); global.GoatBot.config; global.data"),
    ["GoatBot", "data"],
  );
  assert.deepEqual(getLegacyUnsupportedGlobals("global.client; global.commands; global.commandPrefix"), []);
  assert.deepEqual(
    getLegacyUnsupportedGlobals("global.data.userName; global.data.missingService", { allowData: true }),
    ["missingService"],
  );
});

test("compatible group events load and duplicate anti-out handlers are not run twice", () => {
  const events = loadLegacyEvents(path.join(process.cwd(), "SCRIPTS", "ZAO-EVTS"));
  assert.equal(events.size, 1);
  const [event] = events.values();
  assert.equal(event.__legacyZAO, true);
  assert.equal(event.config.eventType.includes("log:unsubscribe"), true);
});

test("empty admin lists and owner ID remain explicitly editable", () => {
  const merged = mergeLegacySettings({ ownerID: "", adminBot: [], superAdminBot: [] });
  assert.equal(merged.ownerID.length, 0);
  assert.equal(merged.adminBot.length, 0);
  assert.equal(merged.superAdminBot.length, 0);
});

test("the active session path is isolated from the original ZAO session", () => {
  assert.equal(path.basename(ACCOUNT_PATH), "DJAMEL-FCA-STATE.json");
  assert.equal(path.basename(path.dirname(ACCOUNT_PATH)), "sessions");
});

test("Djamel cookie parser accepts cookie strings and checks mandatory keys", () => {
  const { cookies } = parseCookieInput("c_user=test-id; xs=test-session");
  assert.deepEqual(cookies.map(cookie => cookie.key), ["c_user", "xs"]);
  assert.equal(hasMandatory(cookies), true);
  assert.equal(hasMandatory([{ key: "c_user", value: "test-id" }]), false);
});
