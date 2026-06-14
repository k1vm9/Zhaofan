'use strict';
/**
 * groupAdminRule.js — ZAO Bot
 * =============================
 * Promote or demote group chat admins via MQTT (Lightspeed).
 * Pre-checks current admin status before sending the MQTT task to avoid
 * no-op publishes.
 *
 * Ported from biar-fca-main/src/deltas/apis/messaging/gcrule.js by @ChoruOfficial
 * Adapted to ZAO's internal style: pure Promise API (no callback parameter).
 *
 * Usage:
 *   const result = await api.gcrule('admin',   userID, threadID);
 *   const result = await api.gcrule('unadmin', userID, threadID);
 *
 * Returns:
 *   { type: 'gc_rule_update', threadID, userID, action, senderID, timestamp }
 */

module.exports = function groupAdminRule(defaultFuncs, api, ctx) {
  return async function gcrule(action, userID, threadID) {
    const VALID = ['admin', 'unadmin'];
    action = (action || '').toLowerCase();

    if (!VALID.includes(action))  throw new Error(`gcrule: action must be "admin" or "unadmin", got "${action}"`);
    if (!userID)                  throw new Error('gcrule: userID is required');
    if (!threadID)                throw new Error('gcrule: threadID is required');
    if (!ctx.mqttClient)          throw new Error('gcrule: MQTT client not connected');

    const threadInfo = await api.getThreadInfo(String(threadID));
    if (!threadInfo)              throw new Error('gcrule: could not fetch thread info');
    if (!threadInfo.isGroup)      throw new Error('gcrule: only group chats are supported');

    const adminIDs       = (threadInfo.adminIDs || []).map(a => String(a.id || a));
    const isCurrentAdmin = adminIDs.includes(String(userID));

    if (action === 'admin'   && isCurrentAdmin)  throw new Error('gcrule: user is already an admin');
    if (action === 'unadmin' && !isCurrentAdmin) throw new Error('gcrule: user is not an admin');

    ctx.wsReqNumber  = (ctx.wsReqNumber  || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

    const payload = {
      app_id: String(ctx.appID || '2220391788200892'),
      payload: JSON.stringify({
        epoch_id: parseInt(_offlineID()),
        tasks: [{
          failure_count: null,
          label:         '25',
          payload:       JSON.stringify({
            thread_key: parseInt(threadID),
            contact_id: parseInt(userID),
            is_admin:   action === 'admin' ? 1 : 0,
          }),
          queue_name: 'admin_status',
          task_id:    ctx.wsTaskNumber,
        }],
        version_id: '24631415369801570',
      }),
      request_id: ctx.wsReqNumber,
      type:       3,
    };

    await new Promise((resolve, reject) => {
      ctx.mqttClient.publish('/ls_req', JSON.stringify(payload), { qos: 1, retain: false }, err => {
        if (err) reject(err); else resolve();
      });
    });

    return {
      type:      'gc_rule_update',
      threadID:  String(threadID),
      userID:    String(userID),
      action,
      senderID:  String(ctx.userID),
      timestamp: Date.now(),
    };
  };
};

function _offlineID() {
  const t = Date.now();
  const r = Math.floor(Math.random() * 4294967295);
  return String(t * 4096 + (r & 4095));
}
