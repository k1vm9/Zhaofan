const QRCode = require("qrcode");
const fs = require("fs-extra");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache");

module.exports.config = {
  name: "qrgen",
  aliases: ["qr", "qrcode"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (MOHAMMAD AKASH/adapted)",
  description: "توليد QR Code من نص أو رابط",
  commandCategory: "أدوات",
  usages: "qrgen [نص أو رابط]",
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const data = args.join(" ").trim();

  if (!data) {
    return api.sendMessage(
      "⚠️ الاستخدام: .qrgen [نص أو رابط]\nمثال: .qrgen https://example.com",
      threadID,
      messageID
    );
  }

  const tmpPath = path.join(CACHE_DIR, `qr_${Date.now()}_${event.senderID}.png`);

  try {
    fs.ensureDirSync(CACHE_DIR);
    await QRCode.toFile(tmpPath, data, {
      color: { dark: "#000000", light: "#FFFFFF" },
      scale: 8,
      margin: 2
    });

    await api.sendMessage(
      {
        body: `✅ QR Code جاهز!\n📝 النص: ${data.length > 60 ? data.slice(0, 60) + "…" : data}`,
        attachment: fs.createReadStream(tmpPath)
      },
      threadID,
      messageID
    );
  } catch (e) {
    return api.sendMessage(`❌ فشل توليد QR Code: ${e.message}`, threadID, messageID);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
};
