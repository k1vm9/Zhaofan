'use strict';
/**
 * userFollow.js — ZAO Bot
 * =========================
 * Follow or unfollow a Facebook user via GraphQL mutations.
 *
 * Ported from biar-fca-main/src/deltas/apis/posting/follow.js by @YanMaglinte / @ChoruOfficial
 * Adapted to ZAO's async/await style with Promise return.
 *
 * Usage:
 *   await api.follow(userID, true);   // follow
 *   await api.follow(userID, false);  // unfollow
 */

module.exports = function userFollow(defaultFuncs, api, ctx) {
  return function follow(senderID, shouldFollow) {
    if (!senderID) return Promise.reject(new Error('userFollow: senderID is required'));

    const form = shouldFollow ? {
      av:                          ctx.userID,
      fb_api_req_friendly_name:    'CometUserFollowMutation',
      fb_api_caller_class:         'RelayModern',
      doc_id:                      '25472099855769847',
      variables: JSON.stringify({
        input: {
          attribution_id_v2:  'ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,via_cold_start,1717249218695,723451,250100865708545,,',
          is_tracking_encrypted: true,
          subscribe_location: 'PROFILE',
          subscribee_id:      String(senderID),
          tracking:           null,
          actor_id:           ctx.userID,
          client_mutation_id: '1',
        },
        scale: 1,
      }),
    } : {
      av:                          ctx.userID,
      fb_api_req_friendly_name:    'CometUserUnfollowMutation',
      fb_api_caller_class:         'RelayModern',
      doc_id:                      '25472099855769847',
      variables: JSON.stringify({
        action_render_location: 'WWW_COMET_FRIEND_MENU',
        input: {
          attribution_id_v2:  'ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,tap_search_bar,1717294006136,602597,250100865708545,,',
          is_tracking_encrypted: true,
          subscribe_location: 'PROFILE',
          tracking:           null,
          unsubscribee_id:    String(senderID),
          actor_id:           ctx.userID,
          client_mutation_id: '10',
        },
        scale: 1,
      }),
    };

    return new Promise((resolve, reject) => {
      defaultFuncs
        .post('https://www.facebook.com/api/graphql/', ctx.jar, form)
        .then(res => {
          if (res && res.errors) return reject(new Error(JSON.stringify(res.errors)));
          resolve(res);
        })
        .catch(reject);
    });
  };
};
