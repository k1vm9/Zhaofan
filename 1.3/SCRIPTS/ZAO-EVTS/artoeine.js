module.exports.config = {
 name: "antiout",
 eventType: ["log:unsubscribe"],
 version: "0.0.2",
 credits: "DungUwU",
 description: "Listen events — anti-out with cooldown to prevent ban loops"
};

// Cooldown map prevents rapid re-add loops that trigger Facebook bans
// Key: `${threadID}:${userID}` → last re-add timestamp
const _cooldown = new Map();
const COOLDOWN_MS = 45 * 1000;

module.exports.run = async({ event, api, Threads, Users }) => {
 try {
  if (!event.logMessageData) return;
  let threadRow = await Threads.getData(event.threadID);
  let data = (threadRow && threadRow.data) || {};
  if (data.antiout !== true) return;

  const leftID = event.logMessageData.leftParticipantFbId;
  if (!leftID) return;
  if (String(leftID) == String(api.getCurrentUserID())) return;

  // Cooldown check — skip if re-added recently
  const key = `${event.threadID}:${leftID}`;
  const last = _cooldown.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MS) return;
  _cooldown.set(key, Date.now());

  // Prune old entries
  if (_cooldown.size > 300) {
   const cutoff = Date.now() - COOLDOWN_MS * 2;
   for (const [k, ts] of _cooldown) { if (ts < cutoff) _cooldown.delete(k); }
  }

  const type = (String(event.author) == String(leftID)) ? "self-separation" : "kicked";
  if (type !== "self-separation") return;

  const name = (global.data && global.data.userName && global.data.userName.get(leftID))
   || await Users.getNameUser(leftID).catch(() => String(leftID));

  api.addUserToGroup(leftID, event.threadID, (error) => {
   if (error) {
    api.sendMessage(` ${name} 👿🔥 سـحـقـاً لـقـد افـلـت/`, event.threadID);
   } else {
    api.sendMessage(``, event.threadID);
   }
  });
 } catch (e) {
  console.error('[antiout] error:', e.message);
 }
};
