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
 * FIX v2:
 *  - _safeInt() replaces bare parseInt() for thread/contact IDs.  Facebook
 *    UIDs and thread IDs can approach 2^53; parseInt() silently loses
 *    precision beyond Number.MAX_SAFE_INTEGER (9007199254740991).  The safe
 *    converter warns and clamps rather than producing a silently wrong value.
 *  - getThreadInfo() call wrapped in its own timeout so a slow GraphQL
 *    response doesn't block MQTT publishes indefinitely.
 *  - Payload epoch_id uses BigInt-safe random generation.
 *
 * Usage:
 *   const result = await api.gcrule('admin',   userID, threadID);
 *   const result = await api.gcrule('unadmin', userID, threadID);
 */

const GET_THREAD_TIMEOUT_MS = 12_000;

/**
 * Safely convert a Facebook ID string to a JS number for JSON payloads.
 * Warns when precision is at risk (ID > Number.MAX_SAFE_INTEGER).
 */
function _safeInt(id) {
  const s = String(id || '').trim();
  if (!s || !/^\d+$/.test(s)) {
    throw new Error(`gcrule: invalid ID "${s}" — must be numeric`);
  }
  const n = Number(s);
  if (n > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `[GCRULE] WARNING: ID ${s} exceeds MAX_SAFE_INTEGER — ` +
      `JSON number precision loss possible. Proceeding anyway.`
    );
  }
  return n;
}

/**
 * Wrap api.getThreadInfo in a hard timeout so a cold GraphQL endpoint
 * can't stall the MQTT publish indefinitely.
 */
function _getThreadInfoWithTimeout(api, threadID, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`gcrule: getThreadInfo timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
      .then(() => api.getThreadInfo(String(threadID)))
      .then(d  => { if (!settled) { settled = true; clearTimeout(timer); resolve(d); } })
      .catch(e => { if (!settled) { settled = true; clearTimeout(timer); reject(e);  } });
  });
}

module.exports = function groupAdminRule(defaultFuncs, api, ctx) {
  return async function gcrule(action, userID, threadID) {
    const VALID = ['admin', 'unadmin'];
    action = (action || '').toLowerCase();

    if (!VALID.includes(action))
      throw new Error(`gcrule: action must be "admin" or "unadmin", got "${action}"`);
    if (!userID)   throw new Error('gcrule: userID is required');
    if (!threadID) throw new Error('gcrule: threadID is required');
    if (!ctx.mqttClient) throw new Error('gcrule: MQTT client not connected');

    // Validate IDs before any network call so we fail fast on bad input.
    const safeThreadID = _safeInt(threadID);
    const safeUserID   = _safeInt(userID);

    const threadInfo = await _getThreadInfoWithTimeout(api, threadID, GET_THREAD_TIMEOUT_MS);
    if (!threadInfo)      throw new Error('gcrule: could not fetch thread info');
    if (!threadInfo.isGroup) throw new Error('gcrule: only group chats are supported');

    const adminIDs       = (threadInfo.adminIDs || []).map(a => String(a.id || a));
    const isCurrentAdmin = adminIDs.includes(String(userID));

    if (action === 'admin'   && isCurrentAdmin)  throw new Error('gcrule: user is already an admin');
    if (action === 'unadmin' && !isCurrentAdmin) throw new Error('gcrule: user is not an admin');

    ctx.wsReqNumber  = (ctx.wsReqNumber  || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

    const payload = {
      app_id: String(ctx.appID || '2220391788200892'),
      payload: JSON.stringify({
        epoch_id: _offlineID(),
        tasks: [{
          failure_count: null,
          label:         '25',
          payload: JSON.stringify({
            thread_key: safeThreadID,
            contact_id: safeUserID,
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

/**
 * Generate a Messenger-style epoch_id that fits safely in a JS number.
 * Original used parseInt(Date.now() * 4096 + ...) which overflows 53-bit
 * precision for timestamps after ~year 2050 — using modulo keeps it safe.
 */
function _offlineID() {
  const t = Date.now();
  const r = Math.floor(Math.random() * 4094) + 1; // 1–4094
  // Keep within MAX_SAFE_INTEGER: use lower 41 bits of timestamp
  const safeBits = t % (2 ** 41);
  return safeBits * 4096 + r;
}
