"use strict";

const axios = require("axios");

module.exports.config = {
  name: "بروفايل",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "تغيير صورة بروفايل البوت — رد على صورة بـ .بروفايل",
  commandCategory: "نظام",
  usages: "[رد على صورة]",
  cooldowns: 15
};

module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, messageReply } = event;

  if (!messageReply) {
    return api.sendMessage(
      "↩️ طريقة الاستخدام:\n1. أرسل الصورة في المحادثة\n2. ارد على الصورة بـ .بروفايل",
      threadID, messageID
    );
  }

  const attachments = messageReply.attachments || [];
  const photo = attachments.find(a =>
    a.type === "photo" || a.type === "animated_image" || a.type === "sticker"
  );

  if (!photo) {
    return api.sendMessage(
      "⚠️ الرسالة التي رددت عليها لا تحتوي على صورة.\nأرسل صورة ثم ارد عليها بـ .بروفايل",
      threadID, messageID
    );
  }

  const imgUrl = photo.largePreviewUrl || photo.url || photo.previewUrl;
  if (!imgUrl) {
    return api.sendMessage("❌ تعذّر الحصول على رابط الصورة.", threadID, messageID);
  }

  await api.sendMessage("⏳ جاري تحديث صورة البروفايل...", threadID);

  try {
    const response = await axios({
      method: "GET",
      url: imgUrl,
      responseType: "stream",
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    await new Promise((resolve, reject) => {
      try {
        const r = api.changeAvatar(response.data, (err, res) => {
          if (err) return reject(err);
          resolve(res);
        });
        if (r && typeof r.then === "function") r.then(resolve).catch(reject);
      } catch (e) { reject(e); }
    });

    api.sendMessage(
      "✅ تم تحديث صورة بروفايل البوت بنجاح!\n📌 ملاحظة: الظهور للجمهور يعتمد على إعدادات الخصوصية في الحساب.",
      threadID, messageID
    );
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 150);
    api.sendMessage(`❌ فشل تحديث صورة البروفايل:\n${msg}`, threadID, messageID);
  }
};
