'use strict';
/**
 * كتلة_جسم.js — حاسبة مؤشر كتلة الجسم (BMI)
 * مُقتبس من TatsuYTB/lib/modules/commands/bmi.js
 */

module.exports.config = {
  name:            'كتلة_جسم',
  aliases:         ['bmi', 'كتلة', 'وزن'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team (from TatsuYTB/bmi.js)',
  description:     'احسب مؤشر كتلة جسمك',
  commandCategory: 'أدوات',
  usages:          'كتلة_جسم [الطول بالمتر] [الوزن بالكيلو] — مثال: .كتلة_جسم 1.75 70',
  cooldowns:       5,
};

module.exports.run = async function ({ api, event, args, Users }) {
  const { threadID, messageID, senderID } = event;

  if (!args[0] || !args[1]) {
    return api.sendMessage(
      '⚖️ مثال: .كتلة_جسم 1.75 70\nأو: .كتلة_جسم 175 70 (سم وكيلو)',
      threadID, messageID
    );
  }

  if (!isFinite(args[0])) return api.sendMessage('❌ الطول غير صحيح.', threadID, messageID);
  if (!isFinite(args[1])) return api.sendMessage('❌ الوزن غير صحيح.', threadID, messageID);

  let height = parseFloat(args[0]);
  const weight = parseFloat(args[1]);

  if (height < 0 || weight < 0) return api.sendMessage('❌ قيم غير صالحة.', threadID, messageID);
  if (height >= 3) height = height / 100;

  const bmi = (weight / (height * height)).toFixed(2);

  let state;
  if      (bmi < 15)   state = '⚠️ نقص حاد جداً في الوزن';
  else if (bmi < 16)   state = '⚠️ نقص حاد في الوزن';
  else if (bmi < 18.5) state = '🟡 نقص في الوزن';
  else if (bmi < 25)   state = '✅ وزن طبيعي';
  else if (bmi < 30)   state = '🟡 زيادة طفيفة في الوزن';
  else if (bmi < 35)   state = '🟠 سمنة درجة أولى';
  else if (bmi < 40)   state = '🔴 سمنة درجة ثانية';
  else                  state = '🔴 سمنة مفرطة درجة ثالثة';

  let name = '';
  try { name = (await Users.getNameUser(senderID)) || ''; } catch (_) {}

  const msg = [
    `⚖️ نتائج مؤشر كتلة الجسم${name ? ' لـ ' + name : ''}:`,
    ``,
    `📏 الطول: ${height.toFixed(2)} م`,
    `🏋️ الوزن: ${weight} كغ`,
    `📊 مؤشر كتلة الجسم: ${bmi}`,
    `🏥 الحالة الصحية: ${state}`,
  ].join('\n');

  return api.sendMessage(msg, threadID, messageID);
};
