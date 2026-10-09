"use strict";

function normalizeAdminIds(values) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

function extractAdminTargetIds(event, args = []) {
  const ids = new Set();
  if (event?.messageReply?.senderID) ids.add(String(event.messageReply.senderID));
  if (event?.mentions && typeof event.mentions === "object") {
    for (const id of Object.keys(event.mentions)) ids.add(String(id));
  }
  for (const value of args) {
    const id = String(value ?? "").trim();
    if (/^\d{5,}$/.test(id)) ids.add(id);
  }
  return [...ids];
}

function updateAdminIds(current, operation, targets, { ownerID = "", senderID = "" } = {}) {
  const adminBot = normalizeAdminIds(current);
  const ids = normalizeAdminIds(targets);
  const added = [];
  const already = [];
  const removed = [];
  const notAdmin = [];

  if (operation === "add") {
    for (const id of ids) {
      if (adminBot.includes(id)) already.push(id);
      else {
        adminBot.push(id);
        added.push(id);
      }
    }
  } else if (operation === "remove") {
    for (const id of ids) {
      const index = adminBot.indexOf(id);
      if (index < 0 || (ownerID && id === String(ownerID)) ||
          (id === String(senderID) && adminBot.length === 1)) {
        notAdmin.push(id);
      } else {
        adminBot.splice(index, 1);
        removed.push(id);
      }
    }
    if (adminBot.length === 0 && senderID) adminBot.push(String(senderID));
  } else {
    throw new Error(`Unsupported admin operation: ${operation}`);
  }
  return { adminBot, added, already, removed, notAdmin };
}

module.exports = { normalizeAdminIds, extractAdminTargetIds, updateAdminIds };
