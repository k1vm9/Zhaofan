const fs = require("fs-extra");
const path = require("path");
const { atomicWriteJsonSync } = require("../../utils/atomicWrite");

module.exports = {
  config: {
    name: "setaccount",
    version: "1.0",
    author: "ZAO",
    cooldowns: 5,
    hasPermssion: 2,
    description: "Update the bot's Facebook login credentials from chat. Bot admins only.",
    commandCategory: "admin",
    guide: "  {pn} [email] [password]\n"
         + "  {pn} status  — check if credentials are saved\n"
         + "  {pn} clear   — remove saved credentials\n\n"
         + "⚠️  Use this in a PRIVATE conversation with the bot only!",
    usePrefix: true
  },

  run: async function ({ api, event, args }) {
    const { senderID, messageID, threadID } = event;
    const adminIDs = (global.config.ADMINBOT || []).map(String);
    if (!adminIDs.includes(String(senderID))) return;

    const action = (args[0] || "").toLowerCase();

    if (action === "status") {
      const email    = global.config.EMAIL    || "";
      const password = global.config.PASSWORD || "";
      const hasEmail = !!(email.trim());
      const hasPass  = !!(password.trim());

      return api.sendMessage(
        "🔐 Account Credentials Status\n"
        + "━━━━━━━━━━━━━━━\n"
        + `📧 Email: ${hasEmail ? "✅ Saved (hidden)" : "❌ Not set"}\n`
        + `🔑 Password: ${hasPass ? "✅ Saved (hidden)" : "❌ Not set"}\n`
        + "━━━━━━━━━━━━━━━\n"
        + (hasEmail && hasPass
          ? "✅ Bot will auto re-login when session expires."
          : "⚠️ No credentials set. Use: .setaccount [email] [password]"),
        threadID
      );
    }

    if (action === "clear") {
      global.config.EMAIL    = "";
      global.config.PASSWORD = "";
      try {
        const settingsPath = path.join(process.cwd(), "ZAO-SETTINGS.json");
        const raw = fs.readFileSync(settingsPath, "utf-8");
        const obj = JSON.parse(raw);
        obj.EMAIL    = "";
        obj.PASSWORD = "";
        atomicWriteJsonSync(settingsPath, obj, { spaces: 4 });
      } catch (e) {}

      try { api.unsendMessage(messageID); } catch (e) {}
      return api.sendMessage("✅ Credentials cleared from ZAO-SETTINGS.json.", threadID);
    }

    const email    = args[0];
    const password = args.slice(1).join(" ");

    if (!email || !password) {
      try { api.unsendMessage(messageID); } catch (e) {}
      return api.sendMessage(
        "❌ Usage: .setaccount [email] [password]\n\n"
        + "Example:\n.setaccount example@gmail.com mypassword\n\n"
        + "⚠️ Use this in a PRIVATE chat with the bot only!",
        threadID
      );
    }

    try { api.unsendMessage(messageID); } catch (e) {}

    global.config.EMAIL    = email.trim();
    global.config.PASSWORD = password.trim();

    try {
      const settingsPath = path.join(process.cwd(), "ZAO-SETTINGS.json");
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const obj = JSON.parse(raw);
      obj.EMAIL    = email.trim();
      obj.PASSWORD = password.trim();
      atomicWriteJsonSync(settingsPath, obj, { spaces: 4 });
    } catch (e) {}

    return api.sendMessage(
      "✅ Credentials saved to ZAO-SETTINGS.json!\n"
      + "━━━━━━━━━━━━━━━\n"
      + "📧 Email: saved ✅\n"
      + "🔑 Password: saved ✅\n"
      + "━━━━━━━━━━━━━━━\n"
      + "🔄 The bot will auto re-login when the next session expires.\n\n"
      + "⚠️ Your original message was deleted for security.",
      threadID
    );
  }
};
