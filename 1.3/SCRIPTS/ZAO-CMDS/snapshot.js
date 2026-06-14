'use strict';

/**
 * Snapshot Command — ZAO Smart Deploy
 * =====================================
 * Creates a version snapshot of key bot files.
 * Snapshots are stored in panel/smart-versions.json and viewable
 * from the panel → Smart Deploy page.
 *
 * Usage (bot admin only):
 *   /snapshot [label]    — create snapshot with optional label
 *   /snapshot list       — show last 8 snapshots
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..', '..');
const VERSIONS_F = path.join(ROOT, 'panel', 'smart-versions.json');

const KEY_FILES = [
  'ZAO-SETTINGS.json',
  'ZAO.js',
  'Main.js',
  'includes/listen.js',
  'includes/protection/antispam.js',
  'includes/protection/rateLimit.js',
  'includes/labyrinth/Labyrinth.js',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSIONS_F, 'utf-8')); }
  catch (_) { return []; }
}

function _saveVersions(versions) {
  try {
    fs.mkdirSync(path.dirname(VERSIONS_F), { recursive: true });
    fs.writeFileSync(VERSIONS_F, JSON.stringify(versions, null, 2), 'utf-8');
    return true;
  } catch (_) { return false; }
}

function _createSnapshot(label, source = 'bot-command') {
  const snapshot = {};
  for (const relPath of KEY_FILES) {
    try { snapshot[relPath] = fs.readFileSync(path.join(ROOT, relPath), 'utf-8').slice(0, 10000); }
    catch (_) {}
  }

  const versions = _loadVersions();
  const version = {
    id:        Date.now(),
    label:     label || `Snapshot ${new Date().toLocaleString()}`,
    date:      new Date().toISOString(),
    fileCount: Object.keys(snapshot).length,
    files:     Object.keys(snapshot),
    source,
    snapshot,
  };
  versions.push(version);
  while (versions.length > 30) versions.shift();

  if (!_saveVersions(versions)) return { ok: false, error: 'Failed to write versions file' };
  return { ok: true, id: version.id, label: version.label, fileCount: version.fileCount };
}

// ── Config ───────────────────────────────────────────────────────────────────

module.exports.config = {
  name:            'snapshot',
  aliases:         ['snap', 'sdsnap'],
  version:         '1.0',
  author:          'ZAO Smart Deploy',
  hasPermssion:    2,
  countDown:       10,
  role:            2,
  description:     'Create / list Smart Deploy version snapshots from inside Messenger.',
  commandCategory: 'admin',
  guide: {
    en: '{pn} [label]  — create snapshot\n{pn} list       — view recent snapshots'
  }
};

// ── Run ──────────────────────────────────────────────────────────────────────

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  // Admin gate — only ADMINBOT members may use this command
  const admins = (global.config?.ADMINBOT || []).map(String);
  if (!admins.includes(String(event.senderID))) {
    return api.sendMessage(
      '⚠️ هذا الأمر للمشرفين فقط.\n⚠️ This command is for bot admins only.',
      threadID, messageID
    );
  }

  const sub = (args[0] || '').toLowerCase().trim();

  // ── List ──────────────────────────────────────────────────────────────────
  if (sub === 'list') {
    const versions = _loadVersions();
    if (!versions.length) {
      return api.sendMessage(
        '📚 No snapshots yet.\nUse: /snapshot [label] to create one.',
        threadID, messageID
      );
    }
    const rows = versions.slice(-8).reverse().map((v, i) => {
      const d = new Date(v.date);
      const dt = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const src = v.source === 'bot-command' ? '🤖' : '🖥️';
      return `${src} ${v.label}\n   📅 ${dt}  •  📁 ${v.fileCount} files`;
    }).join('\n\n');
    return api.sendMessage(
      `📚 Smart Deploy — Recent Snapshots (${versions.length} total):\n\n${rows}\n\n💡 View & manage all snapshots in panel → Smart Deploy`,
      threadID, messageID
    );
  }

  // ── Create ────────────────────────────────────────────────────────────────
  const label = args.join(' ').trim() || `Bot-cmd ${new Date().toLocaleString()}`;

  const result = _createSnapshot(label);

  if (result.ok) {
    return api.sendMessage(
      `✅ Snapshot created!\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📝 ${result.label}\n` +
      `📁 ${result.fileCount} files captured\n` +
      `🆔 ID: ${result.id}\n\n` +
      `🖥️  View in panel → Smart Deploy`,
      threadID, messageID
    );
  } else {
    return api.sendMessage(
      `❌ Snapshot failed: ${result.error}\n` +
      `Check that the panel directory is writable.`,
      threadID, messageID
    );
  }
};
