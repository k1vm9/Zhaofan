'use strict';
/**
 * postComment.js — ZAO Bot
 * ==========================
 * Post a comment (or reply to a comment) on a Facebook post via GraphQL.
 * Supports text, mentions, stickers, and image/video attachments.
 *
 * Ported from biar-fca-main/src/deltas/apis/posting/comment.js by @ChoruOfficial
 * Adapted to ZAO's async/await + Promise return style.
 *
 * Usage:
 *   // Simple text comment
 *   const info = await api.createComment('Nice post!', postID);
 *
 *   // Reply to a comment
 *   const info = await api.createComment('Thanks!', postID, replyCommentID);
 *
 *   // Rich comment with mentions
 *   const info = await api.createComment({
 *     body: '@John nice!',
 *     mentions: [{ tag: '@John', id: '123456', fromIndex: 0 }],
 *   }, postID);
 *
 * Returns: { id, url, count }
 */

module.exports = function postComment(defaultFuncs, api, ctx) {
  return async function createComment(msg, postID, replyCommentID) {
    if (!msg)    throw new Error('createComment: msg is required');
    if (!postID) throw new Error('createComment: postID is required');

    const messageObject = typeof msg === 'string'
      ? { body: msg }
      : { ...msg };
    messageObject.mentions    = messageObject.mentions    || [];
    messageObject.attachments = messageObject.attachments || [];

    const form = {
      feedLocation:   'NEWSFEED',
      feedbackSource: 1,
      groupID:        null,
      input: {
        client_mutation_id: String(Math.round(Math.random() * 19)),
        actor_id:           ctx.userID,
        attachments:        [],
        feedback_id:        Buffer.from('feedback:' + postID).toString('base64'),
        message: {
          ranges: [],
          text:   messageObject.body || '',
        },
        reply_comment_parent_fbid: replyCommentID || null,
        is_tracking_encrypted:     true,
        tracking:                  [],
        feedback_source:           'NEWS_FEED',
        idempotence_token:         'client:' + _guid(),
        session_id:                _guid(),
      },
      scale:            1,
      useDefaultActor:  false,
    };

    // ── Mentions ─────────────────────────────────────────────────────────────
    for (const item of messageObject.mentions) {
      const { tag, id, fromIndex } = item;
      if (typeof tag !== 'string' || !id) continue;
      const offset = (messageObject.body || '').indexOf(tag, fromIndex || 0);
      if (offset < 0) continue;
      form.input.message.ranges.push({ entity: { id }, length: tag.length, offset });
    }

    // ── Sticker ──────────────────────────────────────────────────────────────
    if (messageObject.sticker) {
      form.input.attachments.push({ media: { id: String(messageObject.sticker) } });
    }

    // ── URL attachment ───────────────────────────────────────────────────────
    if (typeof messageObject.url === 'string') {
      form.input.attachments.push({ link: { external: { url: messageObject.url } } });
    }

    // ── File/stream attachments ──────────────────────────────────────────────
    if (messageObject.attachments && messageObject.attachments.length > 0) {
      const uploads = await Promise.all(messageObject.attachments.map(item => {
        return defaultFuncs
          .postFormData('https://www.facebook.com/ajax/ufi/upload/', ctx.jar, {
            profile_id: ctx.userID,
            source:     19,
            target_id:  ctx.userID,
            file:       item,
          })
          .then(res => {
            if (!res || res.error || !res.payload?.fbid) throw Object.assign(new Error('Upload failed'), { raw: res });
            return { media: { id: res.payload.fbid } };
          });
      }));
      form.input.attachments.push(...uploads);
    }

    const res = await defaultFuncs
      .post('https://www.facebook.com/api/graphql/', ctx.jar, {
        fb_api_caller_class:     'RelayModern',
        fb_api_req_friendly_name:'useCometUFICreateCommentMutation',
        variables:               JSON.stringify(form),
        server_timestamps:       true,
        doc_id:                  6993516810709754,
      });

    if (res && res.errors) throw Object.assign(new Error(JSON.stringify(res.errors[0])), { raw: res.errors });

    const edge = res?.data?.comment_create?.feedback_comment_edge;
    if (!edge) throw new Error('createComment: unexpected empty response');

    return {
      id:    edge.node.id,
      url:   edge.node.feedback?.url || null,
      count: res.data.comment_create?.feedback?.total_comment_count || 0,
    };
  };
};

function _guid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
