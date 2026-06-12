'use strict';
/**
 * friendManager.js — ZAO Bot v2
 * ================================
 * Enhanced friend management with full coverage:
 *   list, requests, accept, reject, unfriend, block, unblock, mutual, search, suggest.
 *
 * Sources:
 *   - TatsuYTB/lib/lib/Fca-Horizon-Remastered/src/unfriend.js      (unfriend form POST)
 *   - TatsuYTB/lib/lib/Fca-Horizon-Remastered/src/changeBlockedStatus.js (block/unblock)
 *   - TatsuYTB/lib/lib/fca-auto/src/getFriendsList.js              (legacy list fallback)
 *   - TatsuYTB/lib/modules/commands/acp.js                         (accept/reject GraphQL)
 *   - ZAO original GraphQL layer                                    (kept + extended)
 */

const axios = require('axios');

module.exports = function friendManager(defaultFuncs, api, ctx) {

  function _log(msg) {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: '[ FRIEND-MGR ]: ', color: ['red', 'cyan'] },
          { message: msg, color: 'white' }
        ]);
        return;
      }
    } catch (_) {}
    console.log('[FRIEND-MGR]', msg);
  }

  function _gql(form) {
    return defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, {
      av:      ctx.userID,
      __user:  ctx.userID,
      __a:     '1',
      fb_dtsg: ctx.fb_dtsg,
      jazoest: ctx.jazoest,
      lsd:     ctx.lsd,
      ...form,
    }).then(res => {
      if (res?.data?.errors) throw Object.assign(new Error(JSON.stringify(res.data.errors)), { raw: res.data.errors });
      return res;
    });
  }

  function _formatEdges(edges) {
    if (!Array.isArray(edges)) return [];
    return edges.map(edge => {
      const n = edge.node || edge || {};
      return {
        userID:         n.id    || n.node?.id    || null,
        name:           n.name  || n.title?.text || null,
        profilePicture: n.profile_picture?.uri || n.image?.uri || n.thumbSrc || null,
        socialContext:  n.social_context?.text  || n.subtitle_text?.text || null,
        url:            n.url   || null,
        isFriend:       n.is_friend != null ? !!n.is_friend : undefined,
        gender:         n.gender || null,
      };
    }).filter(f => f.userID);
  }

  // Fallback friend list — from fca-auto/src/getFriendsList.js
  async function _getFriendsLegacy() {
    const GENDERS = {
      0:'unknown',1:'female_singular',2:'male_singular',3:'female_singular_guess',
      4:'male_singular_guess',5:'mixed',6:'neuter_singular',7:'unknown_singular',
      8:'female_plural',9:'male_plural',10:'neuter_plural',11:'unknown_plural'
    };
    const raw = await defaultFuncs
      .postFormData('https://www.facebook.com/chat/user_info_all', ctx.jar, {}, { viewer: ctx.userID });
    const payload = raw?.data?.payload || raw?.payload || {};
    if (typeof payload !== 'object') return [];
    return Object.keys(payload).map(key => {
      const u = payload[key];
      return {
        userID:        String(u.id || key),
        name:          u.name || null,
        profilePicture:u.thumbSrc || null,
        isFriend:      u.is_friend != null ? !!u.is_friend : true,
        gender:        GENDERS[u.gender] || 'unknown',
        url:           u.uri || null,
      };
    }).filter(f => f.userID);
  }

  function _cookieStr() {
    try {
      const st = api.getAppState();
      if (!st?.length) return null;
      return st.map(c => `${c.key}=${c.value}`).join('; ');
    } catch (_) { return null; }
  }

  // Form POST helper — used by unfriend, block, reject (legacy endpoints)
  async function _formPost(url, data) {
    const cookies = _cookieStr();
    const params  = new URLSearchParams(data);
    const res = await axios.post(url, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie':       cookies || '',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin':       'https://www.facebook.com',
        'Referer':      'https://www.facebook.com/',
      },
      timeout: 15000,
      validateStatus: null,
    });
    return res.data;
  }

  const friendModule = {

    /**
     * Get friend list.
     * Priority: 1) api.getFriendsList() built-in (ws3-fca / nkxfca native — same as Imran bot)
     *           2) GraphQL ProfileCometTopAppSectionQuery
     *           3) Legacy /chat/user_info_all endpoint
     * @param {string} [userID]  Defaults to bot's userID.
     */
    async list(userID) {
      const uid = String(userID || ctx.userID);

      // ── 1. Built-in getFriendsList (nkxfca native, most reliable) ─────────
      if (!userID && typeof api.getFriendsList === 'function') {
        try {
          const raw = await api.getFriendsList();
          if (Array.isArray(raw) && raw.length > 0) {
            _log(`getFriendsList built-in: ${raw.length} friends`);
            return raw.map(f => ({
              userID:         f.userID,
              name:           f.fullName  || f.name  || '—',
              profilePicture: f.profilePicture || null,
              url:            f.profileUrl || f.url  || null,
              gender:         f.gender    || null,
              isFriend:       f.isFriend  != null ? f.isFriend : true,
              vanity:         f.vanity    || null,
            }));
          }
        } catch (e) {
          _log('getFriendsList built-in failed, trying GraphQL: ' + e.message);
        }
      }

      // ── 2. GraphQL ────────────────────────────────────────────────────────
      try {
        const sectionToken = Buffer.from(`app_section:${uid}:2356318349`).toString('base64');
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'ProfileCometTopAppSectionQuery',
          variables: JSON.stringify({ collectionToken: null, scale: 2, sectionToken, useDefaultActor: false, userID: uid }),
          doc_id:   '24492266383698794',
        });
        const edges = res?.data?.node?.all_collections?.nodes?.[0]?.style_renderer?.collection?.pageItems?.edges;
        if (edges && edges.length > 0) return _formatEdges(edges);
      } catch (e) {
        _log('GraphQL friend list failed, falling back to legacy: ' + e.message);
      }

      // ── 3. Legacy /chat/user_info_all ─────────────────────────────────────
      return _getFriendsLegacy();
    },

    /** Get pending incoming friend requests. */
    async requests() {
      // Primary attempt: FriendingCometRootContentQuery
      try {
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'FriendingCometRootContentQuery',
          variables:                JSON.stringify({ scale: 3 }),
          doc_id:                   '9103543533085580',
        });

        // Try multiple paths — Facebook sometimes changes the response shape
        const viewer = res?.data?.viewer;
        let edges =
          viewer?.friend_requests?.edges ||
          viewer?.friendship_requests?.edges ||
          viewer?.pending_friend_requests?.edges ||
          viewer?.friends?.friend_requests?.edges;

        if (Array.isArray(edges)) {
          _log(`friend requests (primary): ${edges.length} results`);
          return _formatEdges(edges);
        }

        // If we got data but none of the paths matched, log it for diagnosis
        if (viewer) {
          _log('friend requests: unexpected response shape, viewer keys: ' +
            Object.keys(viewer || {}).join(', '));
        }
      } catch (e) {
        _log('friend requests primary failed: ' + e.message);
      }

      // Fallback: FriendingCometFriendRequestsRootQuery (alternative doc_id)
      try {
        const res2 = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'FriendingCometFriendRequestsRootQuery',
          variables:                JSON.stringify({ scale: 3, count: 30 }),
          doc_id:                   '4283060988374460',
        });

        const viewer2 = res2?.data?.viewer;
        const edges2 =
          viewer2?.friend_requests?.edges ||
          viewer2?.friendship_requests?.edges ||
          viewer2?.pending_friend_requests?.edges;

        if (Array.isArray(edges2)) {
          _log(`friend requests (fallback doc_id): ${edges2.length} results`);
          return _formatEdges(edges2);
        }
      } catch (e2) {
        _log('friend requests fallback failed: ' + e2.message);
      }

      // If both attempts return nothing, return empty array (not an error)
      _log('friend requests: no pending requests found (both methods returned empty)');
      return [];
    },

    /**
     * Accept a pending friend request.
     * @param {string} identifier  UID (numeric) or name substring.
     */
    async accept(identifier) {
      if (!identifier) throw new Error('friendManager.accept: identifier required');
      let uid = String(identifier);
      if (isNaN(identifier)) {
        const reqs  = await friendModule.requests();
        const found = reqs.find(r => (r.name || '').toLowerCase().includes(identifier.toLowerCase()));
        if (!found) throw new Error(`friendManager.accept: no pending request matching "${identifier}"`);
        uid = found.userID;
      }
      try {
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'FriendingCometFriendRequestConfirmMutation',
          variables: JSON.stringify({
            input: { friend_requester_id: uid, friending_channel: 'FRIENDS_HOME_MAIN', actor_id: ctx.userID, client_mutation_id: String(Math.floor(Math.random() * 10 + 1)) },
            scale: 3,
          }),
          doc_id: '24630768433181357',
        });
        return res?.data?.data || { ok: true };
      } catch (e) {
        _log('accept GraphQL failed, trying legacy: ' + e.message);
        await _formPost('https://www.facebook.com/requests/friends/ajax/', {
          viewer_id: uid, 'frefs[0]': 'jwl', floc: 'friend_center_requests', ref: '/reqs.php', action: 'confirm',
        });
        return { ok: true, method: 'legacy' };
      }
    },

    /**
     * Reject (delete) a pending friend request.
     * @param {string} identifier  UID or name substring.
     */
    async reject(identifier) {
      if (!identifier) throw new Error('friendManager.reject: identifier required');
      let uid = String(identifier);
      if (isNaN(identifier)) {
        const reqs  = await friendModule.requests();
        const found = reqs.find(r => (r.name || '').toLowerCase().includes(identifier.toLowerCase()));
        if (!found) throw new Error(`friendManager.reject: no pending request matching "${identifier}"`);
        uid = found.userID;
      }
      try {
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'FriendingCometFriendRequestDeleteMutation',
          variables: JSON.stringify({
            input: { friend_requester_id: uid, actor_id: ctx.userID, client_mutation_id: String(Math.floor(Math.random() * 10 + 1)) },
            scale: 3,
          }),
          doc_id: '4108254489275063',
        });
        return res?.data?.data || { ok: true };
      } catch (e) {
        _log('reject GraphQL failed, trying legacy: ' + e.message);
        await _formPost('https://www.facebook.com/requests/friends/ajax/', {
          viewer_id: uid, 'frefs[0]': 'jwl', floc: 'friend_center_requests', ref: '/reqs.php', action: 'reject',
        });
        return { ok: true, method: 'legacy' };
      }
    },

    /**
     * Unfriend / remove from friend list.
     * Ported from Horizon unfriend.js — uses the legacy confirm endpoint.
     * @param {string} userID
     */
    async unfriend(userID) {
      if (!userID) throw new Error('friendManager.unfriend: userID required');
      await _formPost('https://www.facebook.com/ajax/profile/removefriendconfirm.php', {
        uid:          String(userID),
        unref:        'bd_friends_tab',
        floc:         'friends_tab',
        'nctr[_mod]': `pagelet_timeline_app_collection_${ctx.userID}:2356318349:2`,
      });
    },

    /**
     * Block a user from messaging (Messenger block).
     * Ported from Horizon changeBlockedStatus.js.
     * @param {string} userID
     */
    async block(userID) {
      if (!userID) throw new Error('friendManager.block: userID required');
      await _formPost('https://www.facebook.com/messaging/block_messages/', { fbid: String(userID) });
    },

    /**
     * Unblock a user from messaging.
     * Ported from Horizon changeBlockedStatus.js.
     * @param {string} userID
     */
    async unblock(userID) {
      if (!userID) throw new Error('friendManager.unblock: userID required');
      await _formPost('https://www.facebook.com/messaging/unblock_messages/', { fbid: String(userID) });
    },

    /**
     * Get mutual friends between the bot and another user.
     * @param {string} userID
     * @returns {Promise<{count: number, friends: Array}>}
     */
    async mutual(userID) {
      if (!userID) throw new Error('friendManager.mutual: userID required');
      try {
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'ProfileCometMutualFriendsQuery',
          variables: JSON.stringify({ scale: 3, userID: String(userID) }),
          doc_id:   '23918786547773425',
        });
        const edges = res?.data?.node?.mutual_friends?.edges || [];
        const count = res?.data?.node?.mutual_friends?.count  || edges.length;
        return { count, friends: _formatEdges(edges) };
      } catch (e) {
        _log('mutual friends query failed: ' + e.message);
        return { count: 0, friends: [] };
      }
    },

    /**
     * Search for Facebook users by name.
     * @param {string} query
     * @param {number} [limit=10]
     * @returns {Promise<Array>}
     */
    async search(query, limit = 10) {
      if (!query) throw new Error('friendManager.search: query required');
      try {
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'CometTypeaheadSearchQuery',
          variables: JSON.stringify({ query, count: limit, scale: 3 }),
          doc_id:   '5888219157898442',
        });
        const edges =
          res?.data?.viewer?.typeahead_results?.edges ||
          res?.data?.entities?.edges || [];
        return _formatEdges(edges);
      } catch (e) {
        _log('user search failed: ' + e.message);
        return [];
      }
    },

    suggest: {
      /** People You May Know. */
      async list(limit = 30) {
        const res = await _gql({
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'FriendingCometPYMKPanelPaginationQuery',
          variables:                JSON.stringify({ count: limit, cursor: null, scale: 3 }),
          doc_id:                   '9917809191634193',
        });
        return _formatEdges(res?.data?.viewer?.people_you_may_know?.edges);
      },

      /** Send a friend request. */
      async send(userID) {
        if (!userID) throw new Error('friendManager.suggest.send: userID required');
        try {
          const res = await _gql({
            fb_api_caller_class:      'RelayModern',
            fb_api_req_friendly_name: 'FriendingCometFriendRequestSendMutation',
            variables: JSON.stringify({
              input: {
                friend_requestee_ids: [String(userID)],
                friending_channel:    'FRIENDS_HOME_MAIN',
                actor_id:             ctx.userID,
                client_mutation_id:   String(Math.floor(Math.random() * 10 + 1)),
              },
              scale: 3,
            }),
            doc_id: '23982103144788355',
          });
          return res?.data?.data || { ok: true };
        } catch (e) {
          _log('send request GraphQL failed, trying legacy: ' + e.message);
          await _formPost('https://www.facebook.com/a/profile.php', { action: 'add_friend', friend: String(userID) });
          return { ok: true, method: 'legacy' };
        }
      },

      /** @deprecated Use suggest.send() */
      async request(userID) { return friendModule.suggest.send(userID); },
    },

    /** @deprecated Use suggest.send() */
    async request(userID) { return friendModule.suggest.send(userID); },
  };

  return friendModule;
};
