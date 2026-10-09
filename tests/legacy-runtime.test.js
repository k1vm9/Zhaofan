"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const onEventCmds = require("../src/engine/handlerEvents");
const { initLegacyState } = require("../src/utils/zaoCompatibility");
const { getLegacyUnsupportedGlobals } = require("../src/engine/loader");
const { extractAdminTargetIds, updateAdminIds } = require("../src/utils/adminManagement");

function makeApi(messages = []) {
  return {
    sendMessage(content, threadID, callback) {
      messages.push({ content, threadID });
      if (typeof callback === "function") callback(null, { messageID: `sent-${messages.length}` });
      return Promise.resolve({ messageID: `sent-${messages.length}` });
    },
    unsendMessage() {},
    setMessageReaction() {},
    getCurrentUserID: () => "bot-user",
    getThreadInfoCached: async () => ({ adminIDs: [] }),
  };
}

function resetRuntime({ adminOnly = false, lockBot = false, commands = new Map() } = {}) {
  for (const key of [
    "GoatBot", "client", "data", "db", "Users", "Threads", "Currencies",
    "commands", "config", "ownerID", "commandPrefix", "lastMqttActivity",
    "lastMqttOnlyActivity", "_bufferMsg", "_trackMsg", "_msgListeners",
  ]) delete global[key];
  global.GoatBot = {
    botID: "bot-user",
    startTime: Date.now(),
    commands,
    onChat: [],
    onReply: new Map(),
    dmLocked: false,
    config: {
      prefix: "!",
      ownerID: "owner-user",
      adminBot: ["admin-user"],
      superAdminBot: ["owner-user"],
      adminOnly: { enable: adminOnly },
      rateLimit: { maxMessagesPerWindow: 50, windowMs: 6000 },
    },
  };
  global.lockBot = lockBot;
  global.log = { info() {}, ok() {}, warn() {}, error() {} };
  global.client = undefined;
  initLegacyState(commands);
}

function messageEvent({ id, senderID = "member-user", body = "!probe", type = "message", extra = {} }) {
  return {
    type,
    threadID: "thread-test",
    senderID,
    messageID: id,
    body,
    isGroup: false,
    ...extra,
  };
}

test("the handler enforces public/admin permissions and Shindo's bot-wide lock", async () => {
  const calls = [];
  const commands = new Map([
    ["probe", { config: { name: "probe", role: 0, cooldowns: 0 }, run: async () => calls.push("public") }],
    ["adminprobe", { config: { name: "adminprobe", role: 2, cooldowns: 0 }, run: async () => calls.push("admin") }],
  ]);
  resetRuntime({ commands });
  const api = makeApi();
  await onEventCmds(api, messageEvent({ id: "perm-public-1" }), commands);
  assert.equal(calls.includes("public"), true);

  const shindo = require("../SCRIPTS/ZAO-CMDS/Shindo");
  await shindo.run({
    api,
    event: messageEvent({ id: "lock-on", senderID: "admin-user", body: "!قفل تفعيل" }),
    args: ["تفعيل"],
    permssion: 2,
  });
  await onEventCmds(api, messageEvent({ id: "perm-locked-public" }), commands);
  assert.equal(calls.filter(name => name === "public").length, 1);

  await onEventCmds(api, messageEvent({
    id: "perm-locked-admin",
    senderID: "admin-user",
    body: "!adminprobe",
  }), commands);
  assert.equal(calls.includes("admin"), true);

  global.GoatBot.config.adminOnly.enable = true;
  await onEventCmds(api, messageEvent({ id: "perm-adminonly-public" }), commands);
  assert.equal(calls.filter(name => name === "public").length, 1);
});

test("Djamel and ZAO reply callbacks are dispatched to their matching handlers", async () => {
  const commands = new Map();
  resetRuntime({ commands });
  const api = makeApi();
  let djamelReplyCount = 0;
  let zaoReplyCount = 0;
  global.GoatBot.onReply.set("djamel-reply", {
    messageID: "reply-target-djamel",
    author: "member-user",
    callback: async ({ event }) => { djamelReplyCount += event.body === "answer" ? 1 : 0; },
  });
  const legacyCommand = {
    __legacyZAO: true,
    config: { name: "legacy-reply" },
    handleReply: async ({ event, handleReply }) => {
      zaoReplyCount += event.body === "answer" && handleReply.name === "legacy-reply" ? 1 : 0;
    },
  };
  commands.set("legacy-reply", legacyCommand);
  global.client.commands = commands;
  global.client.handleReply.push({ messageID: "reply-target-zao", name: "legacy-reply", author: "member-user" });

  await onEventCmds(api, messageEvent({
    id: "reply-djamel-1",
    body: "answer",
    type: "message_reply",
    extra: { messageReply: { messageID: "reply-target-djamel" } },
  }), commands);
  await onEventCmds(api, messageEvent({
    id: "reply-zao-1",
    body: "answer",
    type: "message_reply",
    extra: { messageReply: { messageID: "reply-target-zao" } },
  }), commands);

  assert.equal(djamelReplyCount, 1);
  assert.equal(zaoReplyCount, 1);
  assert.equal(global.client.handleReply.length, 0);
});

test("supported ZAO group events receive the adapted database and API context", async () => {
  resetRuntime();
  const api = makeApi();
  let seen = null;
  global.client.events.set("legacy-event", {
    config: { name: "legacy-event", eventType: ["log:unsubscribe"] },
    run: async context => { seen = context; },
  });
  await onEventCmds(api, messageEvent({
    id: "group-leave-1",
    type: "event",
    extra: {
      senderID: "member-user",
      logMessageType: "log:unsubscribe",
      logMessageData: { leftParticipantFbId: "member-user" },
    },
  }), global.GoatBot.commands);
  assert.equal(seen.api, api);
  assert.equal(seen.event.logMessageType, "log:unsubscribe");
  assert.equal(typeof seen.Threads.getData, "function");
});

test("admin command helpers preserve IDs as strings and protect the final admin", () => {
  const targets = extractAdminTargetIds({
    messageReply: { senderID: "10000000000001" },
    mentions: { "10000000000002": "member" },
  }, ["10000000000003"]);
  assert.deepEqual(targets, ["10000000000001", "10000000000002", "10000000000003"]);

  const add = updateAdminIds(["10000000000001"], "add", ["10000000000002", "10000000000002"]);
  assert.deepEqual(add.adminBot, ["10000000000001", "10000000000002"]);
  assert.equal(add.added.length, 1);

  const removeLast = updateAdminIds(["10000000000001"], "remove", ["10000000000001"], {
    senderID: "10000000000001",
  });
  assert.equal(removeLast.adminBot[0], "10000000000001");
  assert.equal(removeLast.notAdmin.length, 1);
});

test("previously skipped commands now use only supported runtime globals", () => {
  const paths = [
    "admins.js", "antdetect.js", "ping.js", "slot.js", "uptime.js",
    "warn.js", "Shindo.js", "pin.js", "معلومات.js",
  ];
  for (const file of paths) {
    const source = fs.readFileSync(path.join(process.cwd(), "SCRIPTS", "ZAO-CMDS", file), "utf8");
    assert.deepEqual(getLegacyUnsupportedGlobals(source), [], `${file} uses an unsupported runtime global`);
    assert.equal(/require\s*\(\s*["'][^"']*ZAO-ENGINE\//.test(source), false, `${file} imports ZAO-ENGINE`);
  }
});
