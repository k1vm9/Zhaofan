module.exports.config = {
  name: "0antiout_0",
  eventType: ["log:unsubscribe"],
  version: "1.0.1",
  credits: "DungUwU",
  description: "منع الخروج من المجموعة — يعمل فقط عند التفعيل"
};

// Per-user-per-thread cooldown: prevents spamming addUserToGroup when
// the same user leaves repeatedly, which triggers Facebook temp bans.
// Key: `${threadID}:${userID}` → timestamp of last re-add attempt.
const _antioutCooldown = new Map();
const ANTIOUT_COOLDOWN_MS = 45 * 1000; // 45 seconds between re-adds per user

module.exports.run = async ({ event, api, Threads, Users }) => {
  let threadRow = await Threads.getData(event.threadID);
  let data = (threadRow && threadRow.data) || {};

  if (data.antiout !== true) return;
  if (!event.logMessageData) return;

  const leftID = event.logMessageData.leftParticipantFbId;
  if (!leftID) return;
  if (String(leftID) == String(api.getCurrentUserID())) return;

  // Cooldown check — skip re-add if this user was re-added too recently
  const cooldownKey = `${event.threadID}:${leftID}`;
  const lastAttempt = _antioutCooldown.get(cooldownKey) || 0;
  if (Date.now() - lastAttempt < ANTIOUT_COOLDOWN_MS) return;
  _antioutCooldown.set(cooldownKey, Date.now());

  // Prune stale cooldown entries to prevent unbounded Map growth
  if (_antioutCooldown.size > 500) {
    const cutoff = Date.now() - ANTIOUT_COOLDOWN_MS * 2;
    for (const [k, ts] of _antioutCooldown) {
      if (ts < cutoff) _antioutCooldown.delete(k);
    }
  }

  const name = (global.data && global.data.userName && global.data.userName.get(leftID))
    || await Users.getNameUser(leftID);

  const type = (event.author == leftID) ? "self-separation" : "kicked";

  if (type === "self-separation") {
    api.addUserToGroup(leftID, event.threadID, (error) => {
      if (error) {
        api.sendMessage(`https://www.raed.net/img?id=869907`, event.threadID);
      } else {
        api.sendMessage(
          `🩸 ${name} 🩸\n\n  يـمـنـع الـهـروب فـي حـضـور هـذا الـسـيـد الـشـاب 😈🔥`,
          event.threadID
        );
      }
    });
  }
};
