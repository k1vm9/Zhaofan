'use strict';
/**
 * messengerNotes.js — ZAO Bot
 * =============================
 * Interact with Facebook Messenger Notes (the 24-hour temporary status-like
 * notes visible in your inbox tray — NOT Facebook profile page notes).
 *
 * Ported from biar-fca-main/src/deltas/apis/messaging/notes.js by @ChoruOfficial
 * Adapted to ZAO's FCA wrapper: uses `defaultFuncs` + `ctx` pattern.
 *
 * Usage (after patching onto api object):
 *   const notes = api.notes;
 *   await notes.create('Hello world 👋');
 *   const current = await notes.check();
 *   await notes.delete(current.id);
 *   await notes.recreate(current.id, 'Updated note');
 *
 * Privacy options for create: "EVERYONE" | "FRIENDS" | "ONLY_ME"
 */

module.exports = function messengerNotes(defaultFuncs, api, ctx) {

  function _post(form) {
    return defaultFuncs
      .post('https://www.facebook.com/api/graphql/', ctx.jar, form)
      .then(res => {
        if (res && res.errors) throw Object.assign(new Error(res.errors[0].message || 'GraphQL error'), { raw: res.errors });
        return res;
      });
  }

  /**
   * Check the currently active Messenger Note for the logged-in user.
   * @returns {Promise<object|null>} The current note object or null.
   */
  async function check() {
    const res = await _post({
      fb_api_caller_class:     'RelayModern',
      fb_api_req_friendly_name:'MWInboxTrayNoteCreationDialogQuery',
      variables:               JSON.stringify({ scale: 2 }),
      doc_id:                  '30899655739648624',
    });
    return res?.data?.viewer?.actor?.msgr_user_rich_status ?? null;
  }

  /**
   * Create a new Messenger Note (lasts 24 hours).
   * @param {string} text    Note text content.
   * @param {string} privacy "EVERYONE" | "FRIENDS" | "ONLY_ME"
   * @returns {Promise<string>} The creation status.
   */
  async function create(text, privacy = 'EVERYONE') {
    if (!text) throw new Error('messengerNotes.create: text is required');
    const res = await _post({
      fb_api_caller_class:     'RelayModern',
      fb_api_req_friendly_name:'MWInboxTrayNoteCreationDialogCreationStepContentMutation',
      variables: JSON.stringify({
        input: {
          client_mutation_id: String(Math.round(Math.random() * 10)),
          actor_id:           ctx.userID,
          description:        text,
          duration:           86400,
          note_type:          'TEXT_NOTE',
          privacy,
          session_id:         _guid(),
        },
      }),
      doc_id: '24060573783603122',
    });
    const status = res?.data?.xfb_rich_status_create?.status;
    if (!status) throw new Error('messengerNotes.create: unexpected empty response');
    return status;
  }

  /**
   * Delete a Messenger Note by its ID.
   * @param {string} noteID
   * @returns {Promise<object>}
   */
  async function del(noteID) {
    if (!noteID) throw new Error('messengerNotes.delete: noteID is required');
    const res = await _post({
      fb_api_caller_class:     'RelayModern',
      fb_api_req_friendly_name:'useMWInboxTrayDeleteNoteMutation',
      variables: JSON.stringify({
        input: {
          client_mutation_id: String(Math.round(Math.random() * 10)),
          actor_id:           ctx.userID,
          rich_status_id:     noteID,
        },
      }),
      doc_id: '9532619970198958',
    });
    const deleted = res?.data?.xfb_rich_status_delete;
    if (!deleted) throw new Error('messengerNotes.delete: unexpected empty response');
    return deleted;
  }

  /**
   * Delete an old note then create a new one.
   * @param {string} oldNoteID  ID of note to delete.
   * @param {string} newText    Content for the new note.
   * @returns {Promise<{ deleted: object, created: string }>}
   */
  async function recreate(oldNoteID, newText) {
    const deleted = await del(oldNoteID);
    const created = await create(newText);
    return { deleted, created };
  }

  return { check, create, delete: del, recreate };
};

function _guid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
