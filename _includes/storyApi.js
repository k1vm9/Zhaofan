'use strict';
/**
 * storyApi.js — ZAO Bot
 * =======================
 * Create Facebook text stories and react/reply to stories.
 *
 * Ported from biar-fca-main/src/deltas/apis/posting/story.js
 * by @Jonell Magallanes / @ChoruOfficial
 * Adapted to ZAO's async/await + Promise style.
 *
 * Usage:
 *   // Create a text story
 *   const { storyID } = await api.story.create('Hello world 🌍', 'classic', 'blue');
 *
 *   // React to a story with an emoji
 *   await api.story.react(storyID, '❤️');
 *
 *   // Reply with a text message
 *   await api.story.msg(storyID, 'Great story!');
 *
 * Fonts:   headline | classic | casual | fancy
 * Backgrounds: orange | blue | green | modern
 * Reactions:   ❤️ 👍 🤗 😆 😡 😢 😮
 */

const { URL } = require('url');

const FONT_MAP = {
  headline: '1919119914775364',
  classic:  '516266749248495',
  casual:   '516266749248495',
  fancy:    '1790435664339626',
};

const BG_MAP = {
  orange: '2163607613910521',
  blue:   '401372137331149',
  green:  '367314917184744',
  modern: '554617635055752',
};

const ALLOWED_REACTIONS = ['❤️', '👍', '🤗', '😆', '😡', '😢', '😮'];

module.exports = function storyApi(defaultFuncs, api, ctx) {

  function _post(form) {
    return defaultFuncs
      .post('https://www.facebook.com/api/graphql/', ctx.jar, form)
      .then(res => {
        if (res && res.errors) throw Object.assign(new Error(JSON.stringify(res.errors[0])), { raw: res.errors });
        return res;
      });
  }

  function _storyIDFromURL(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      const idx   = parts.indexOf('stories');
      if (idx !== -1 && parts.length > idx + 2) return parts[idx + 2];
    } catch (_) {}
    return null;
  }

  /**
   * Create a text-based Facebook Story.
   * @param {string} message
   * @param {string} [fontName='classic']
   * @param {string} [backgroundName='blue']
   * @returns {Promise<{ success: boolean, storyID: string }>}
   */
  async function create(message, fontName = 'classic', backgroundName = 'blue') {
    if (!message) throw new Error('storyApi.create: message is required');
    const fontId = FONT_MAP[(fontName || '').toLowerCase()] || FONT_MAP.classic;
    const bgId   = BG_MAP[(backgroundName || '').toLowerCase()]  || BG_MAP.blue;

    const res = await _post({
      __a:                     '1',
      fb_api_caller_class:     'RelayModern',
      fb_api_req_friendly_name:'StoriesCreateMutation',
      variables: JSON.stringify({
        input: {
          audiences:          [{ stories: { self: { target_id: ctx.userID } } }],
          audiences_is_complete: true,
          logging:            { composer_session_id: 'createStoriesText-' + Date.now() },
          navigation_data:    { attribution_id_v2: 'StoriesCreateRoot.react,comet.stories.create' },
          source:             'WWW',
          message:            { ranges: [], text: message },
          text_format_metadata:  { inspirations_custom_font_id: fontId },
          text_format_preset_id: bgId,
          tracking:           [null],
          actor_id:           ctx.userID,
          client_mutation_id: '2',
        },
      }),
      doc_id: '24226878183562473',
    });

    const storyNode = res?.data?.story_create?.viewer?.actor?.story_bucket?.nodes?.[0]?.first_story_to_show;
    if (!storyNode || !storyNode.id) throw new Error('storyApi.create: storyID not found in response');
    return { success: true, storyID: storyNode.id };
  }

  async function _sendReply(storyIdOrUrl, message, isReaction) {
    if (!storyIdOrUrl) throw new Error('storyApi: storyID or URL is required');
    if (!message)      throw new Error('storyApi: message is required');
    if (isReaction && !ALLOWED_REACTIONS.includes(message)) {
      throw new Error(`storyApi: invalid reaction. Use one of: ${ALLOWED_REACTIONS.join(' ')}`);
    }

    const storyID = _storyIDFromURL(storyIdOrUrl) || storyIdOrUrl;
    const variables = {
      input: {
        attribution_id_v2:  'StoriesCometSuspenseRoot.react,comet.stories.viewer,via_cold_start',
        message,
        story_id:           storyID,
        story_reply_type:   isReaction ? 'LIGHT_WEIGHT' : 'TEXT',
        actor_id:           ctx.userID,
        client_mutation_id: String(Math.floor(Math.random() * 10 + 1)),
      },
    };
    if (isReaction) {
      variables.input.lightweight_reaction_actions = {
        offsets:  [0],
        reaction: message,
      };
    }

    const res = await _post({
      av:                       ctx.userID,
      __user:                   ctx.userID,
      __a:                      '1',
      fb_dtsg:                  ctx.fb_dtsg,
      jazoest:                  ctx.jazoest,
      fb_api_caller_class:     'RelayModern',
      fb_api_req_friendly_name:'useStoriesSendReplyMutation',
      variables:                JSON.stringify(variables),
      doc_id:                  '9697491553691692',
    });

    const result = res?.data?.direct_message_reply;
    if (!result) throw new Error('storyApi: unexpected empty response');
    return { success: true, result };
  }

  return {
    create,
    react: (storyIdOrUrl, reaction)  => _sendReply(storyIdOrUrl, reaction, true),
    msg:   (storyIdOrUrl, message)   => _sendReply(storyIdOrUrl, message,  false),
  };
};
