'use strict';
/**
 * pinMessage.js — ZAO Bot
 * =========================
 * Pin or unpin a message in a group thread via MQTT Lightspeed tasks.
 *
 * Ported from biar-fca-main/src/deltas/apis/mqtt/pinMessage.js
 * Adapted to ZAO's style: removed deepdash / jsonpath-plus dependencies,
 * pure MQTT publish approach using ZAO's existing mqttClient on ctx.
 *
 * Usage:
 *   await api.pinMessage('pin',   threadID, messageID);
 *   await api.pinMessage('unpin', threadID, messageID);
 *
 * Returns:
 *   Array of { success: true, request_id } objects (one per MQTT publish)
 */

module.exports = function pinMessage(defaultFuncs, api, ctx) {
  return async function pin(action, threadID, messageID) {
    if (!action)    throw new Error('pinMessage: action is required ("pin" or "unpin")');
    if (!threadID)  throw new Error('pinMessage: threadID is required');
    if (!messageID) throw new Error('pinMessage: messageID is required');
    if (!ctx.mqttClient) throw new Error('pinMessage: MQTT client not connected');

    action = action.toLowerCase();
    if (action !== 'pin' && action !== 'unpin') {
      throw new Error(`pinMessage: invalid action "${action}". Use "pin" or "unpin".`);
    }

    const epoch_id   = parseInt(_offlineID());
    const version_id = '9523201934447612';
    const app_id     = '2220391788200892';

    function nextTask() {
      ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
      return ctx.wsTaskNumber;
    }
    function nextReq() {
      ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
      return ctx.wsReqNumber;
    }

    function buildReq(tasks, epochIncrement = 0) {
      return {
        app_id,
        payload:    JSON.stringify({ epoch_id: epoch_id + epochIncrement, tasks, version_id }),
        request_id: nextReq(),
        type:       3,
      };
    }

    function publish(content) {
      return new Promise((resolve, reject) => {
        ctx.mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1, retain: false }, err => {
          if (err) reject(err);
          else resolve({ success: true, request_id: content.request_id });
        });
      });
    }

    if (action === 'pin') {
      const pinTask = {
        label:      '430',
        payload:    JSON.stringify({ thread_key: threadID, message_id: messageID, timestamp_ms: Date.now() }),
        queue_name: `pin_msg_v2_${threadID}`,
        task_id:    nextTask(),
      };
      const searchTask = {
        label:      '751',
        payload:    JSON.stringify({ thread_key: threadID, message_id: messageID, pinned_message_state: 1 }),
        queue_name: 'set_pinned_message_search',
        task_id:    nextTask(),
      };
      return Promise.all([
        publish(buildReq([pinTask],    0)),
        publish(buildReq([searchTask], 1)),
      ]);
    }

    if (action === 'unpin') {
      const searchTask1 = {
        label:      '751',
        payload:    JSON.stringify({ thread_key: threadID, message_id: messageID, pinned_message_state: 0 }),
        queue_name: 'set_pinned_message_search',
        task_id:    nextTask(),
      };
      const unpinTask = {
        label:      '431',
        payload:    JSON.stringify({ thread_key: threadID, message_id: messageID, timestamp_ms: Date.now() }),
        queue_name: `unpin_msg_v2_${threadID}`,
        task_id:    nextTask(),
      };
      const searchTask2 = {
        label:      '751',
        payload:    JSON.stringify({ thread_key: threadID, message_id: messageID, pinned_message_state: 0 }),
        queue_name: 'set_pinned_message_search',
        task_id:    nextTask(),
      };
      await publish(buildReq([searchTask1], 0));
      await publish(buildReq([unpinTask],   1));
      return publish(buildReq([searchTask2], 2));
    }
  };
};

function _offlineID() {
  return String(Date.now() * 4096 + (Math.floor(Math.random() * 4294967295) & 4095));
}
