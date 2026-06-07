const axios = require("axios");

module.exports.config = {
  name: "tempmail",
  aliases: ["tm", "bmail"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (MOHAMMAD AKASH/adapted)",
  description: "إنشاء بريد إلكتروني مؤقت وعرض رسائله",
  commandCategory: "أدوات",
  usages: "tempmail — ينشئ بريداً مؤقتاً\ntempmail inbox [البريد] — يعرض الرسائل",
  cooldowns: 5
};

const API_BASE = "https://api.mail.tm";
const _accounts = {};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  if ((args[0] || "").toLowerCase() === "inbox") {
    const email = args[1];
    if (!email) {
      return api.sendMessage("❌ اكتب عنوان البريد: .tempmail inbox [البريد]", threadID, messageID);
    }
    if (!_accounts[email]) {
      return api.sendMessage("❌ هذا البريد لم يُنشأ من خلال البوت.", threadID, messageID);
    }
    try {
      const tokenRes = await axios.post(`${API_BASE}/token`, {
        address: email,
        password: _accounts[email]
      }, { timeout: 10000 });
      const token = tokenRes.data.token;

      const inbox = await axios.get(`${API_BASE}/messages?page=1`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });

      const msgs = inbox.data["hydra:member"] || [];
      if (!msgs.length) {
        return api.sendMessage("📭 لا توجد رسائل بعد في هذا البريد.", threadID, messageID);
      }

      let out = `📬 رسائل بريد ${email}:\n━━━━━━━━━━━━━━━\n\n`;
      for (const m of msgs.slice(0, 5)) {
        out += `📩 من: ${m.from?.address || "مجهول"}\n`;
        out += `📌 الموضوع: ${m.subject || "بدون موضوع"}\n`;
        out += `✉️ الرسالة: ${(m.intro || "").replace(/<[^>]+>/g, "").slice(0, 300)}\n\n`;
      }
      return api.sendMessage(out.trim(), threadID, messageID);
    } catch (e) {
      return api.sendMessage("❌ فشل جلب الرسائل، حاول لاحقاً.", threadID, messageID);
    }
  }

  try {
    const domainRes = await axios.get(`${API_BASE}/domains`, { timeout: 10000 });
    const domain = domainRes.data["hydra:member"]?.[0]?.domain;
    if (!domain) throw new Error("no domain");

    const rnd = Math.random().toString(36).substring(2, 10);
    const email = `${rnd}@${domain}`;
    const password = rnd + "Zao!";

    await axios.post(`${API_BASE}/accounts`, { address: email, password }, { timeout: 10000 });
    _accounts[email] = password;

    return api.sendMessage(
      `📩 بريدك المؤقت:\n━━━━━━━━━━━━━━━\n📧 البريد: ${email}\n\n💡 لعرض الرسائل:\n.tempmail inbox ${email}\n\n⏳ ملاحظة: البريد المؤقت لا يدوم طويلاً`,
      threadID,
      messageID
    );
  } catch (e) {
    return api.sendMessage("❌ فشل إنشاء البريد المؤقت، حاول لاحقاً.", threadID, messageID);
  }
};
