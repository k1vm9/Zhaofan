'use strict';
/**
 * diskGuard.js  v2 — UPGRADED
 *
 * Upgraded with:
 * - warnPct lowered 90% → 80% (catch disk pressure earlier)
 * - criticalPct at 95% → emergency dump of cache/ dir as well
 * - Routine pruning also covers SCRIPTS/ZAO-CMDS/cache (media files)
 * - Check interval configurable; default 20 min (was 30 min)
 * - Heavier per-file size limit in pressure mode (500 KB keep, was 256 KB)
 *   — keeps more log context for debugging while still freeing space
 * - getDiskInfo() now returns a human-readable freeHuman / usedHuman string
 * - Added cleanCacheDir() helper to nuke temp media files on pressure
 */

const fs   = require('fs');
const path = require('path');

let started = false;

function _logger() {
  try { return require('../utils/log.js'); } catch (_) { return null; }
}

function getDiskInfo(target) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s     = fs.statfsSync(target || process.cwd());
    const total = Number(s.blocks)  * Number(s.bsize);
    const free  = Number(s.bavail)  * Number(s.bsize);
    if (!total || total <= 0) return null;
    const usedPct = (1 - free / total) * 100;
    const mb = n => (n / 1024 / 1024).toFixed(0) + 'MB';
    return {
      total, free,
      used:      total - free,
      usedPct,
      totalHuman: mb(total),
      freeHuman:  mb(free),
      usedHuman:  mb(total - free)
    };
  } catch (_) { return null; }
}

/** Truncate oversized *.log/*.out/*.err files, keeping only the last `keepBytes`. */
function rotateLargeLogs(dir, maxBytes, keepBytes) {
  if (typeof maxBytes  !== 'number') maxBytes  = 5 * 1024 * 1024;
  if (typeof keepBytes !== 'number') keepBytes = 1 * 1024 * 1024;
  let rotated = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!/\.(log|out|err)$/i.test(ent.name)) continue;
      const fp = path.join(dir, ent.name);
      try {
        const st = fs.statSync(fp);
        if (st.size <= maxBytes) continue;
        const start = Math.max(0, st.size - keepBytes);
        const fd    = fs.openSync(fp, 'r');
        const buf   = Buffer.alloc(keepBytes);
        const read  = fs.readSync(fd, buf, 0, keepBytes, start);
        fs.closeSync(fd);
        const tmp = fp + '.rot.tmp';
        fs.writeFileSync(tmp, buf.subarray(0, read));
        fs.renameSync(tmp, fp);
        rotated++;
      } catch (_) {}
    }
  } catch (_) {}
  return rotated;
}

/** Keep only newest `maxFiles` regular files in `dir`. */
function pruneDirectory(dir, maxFiles, excludeRegex) {
  if (typeof maxFiles !== 'number') maxFiles = 10;
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      if (excludeRegex && excludeRegex.test(name)) continue;
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        entries.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch (_) {}
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (let i = maxFiles; i < entries.length; i++) {
      try { fs.unlinkSync(entries[i].fp); removed++; } catch (_) {}
    }
  } catch (_) {}
  return removed;
}

/**
 * Nuke temp media files from a cache directory.
 * Extensions: jpg, gif, mp4, mp3, png, m4a, webm, ogg, wav, mpeg, webp
 */
function cleanCacheDir(dir) {
  const MEDIA_EXTS = /\.(jpg|jpeg|gif|mp4|mp3|png|m4a|webm|ogg|wav|mpeg|webp)$/i;
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const name of fs.readdirSync(dir)) {
      if (!MEDIA_EXTS.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch (_) {}
    }
  } catch (_) {}
  return removed;
}

const SNAPSHOT_EXCLUDE = /-snap-\d{8}-\d{6}\.json$/;

function tick(opts) {
  opts = opts || {};
  const log      = _logger();
  const cwd      = process.cwd();
  const warnPct  = opts.warnPct     || 80;   // warn at 80% (was 90%)
  const critPct  = opts.criticalPct || 95;   // emergency at 95%
  const tasks    = [];

  // ── Routine maintenance (every tick) ─────────────────────────────────────
  const r1 = rotateLargeLogs(path.join(cwd, 'logs'), 5 * 1024 * 1024, 1 * 1024 * 1024);
  if (r1) tasks.push(`rotated ${r1} logs/`);
  const r2 = rotateLargeLogs('/tmp/logs', 5 * 1024 * 1024, 1 * 1024 * 1024);
  if (r2) tasks.push(`rotated ${r2} /tmp/logs`);
  const p1 = pruneDirectory(path.join(cwd, 'backups'), 10, SNAPSHOT_EXCLUDE);
  if (p1) tasks.push(`pruned ${p1} backups/`);
  const c1 = cleanCacheDir(path.join(cwd, 'SCRIPTS', 'ZAO-CMDS', 'cache'));
  if (c1) tasks.push(`cleared ${c1} cmd-cache files`);

  // ── Disk pressure check ───────────────────────────────────────────────────
  const cwdInfo = getDiskInfo(cwd);
  const tmpInfo = getDiskInfo('/tmp');
  const cwdPct  = cwdInfo ? cwdInfo.usedPct : 0;
  const tmpPct  = tmpInfo ? tmpInfo.usedPct : 0;

  const highPressure = cwdPct >= warnPct || tmpPct >= warnPct;
  const critical     = cwdPct >= critPct || tmpPct >= critPct;

  if (highPressure) {
    const r3 = rotateLargeLogs(path.join(cwd, 'logs'),  2 * 1024 * 1024, 512 * 1024);
    const r4 = rotateLargeLogs('/tmp/logs',             2 * 1024 * 1024, 512 * 1024);
    const p2 = pruneDirectory(path.join(cwd, 'backups'), 4, SNAPSHOT_EXCLUDE);
    const p3 = pruneDirectory(path.join(cwd, 'data', 'tmp'), 5);
    const p4 = pruneDirectory('/tmp', 100);
    const c2 = cleanCacheDir(path.join(cwd, 'cache'));
    if (r3) tasks.push(`PRESSURE rotated ${r3} logs/`);
    if (r4) tasks.push(`PRESSURE rotated ${r4} /tmp/logs`);
    if (p2) tasks.push(`PRESSURE pruned ${p2} backups/`);
    if (p3) tasks.push(`PRESSURE pruned ${p3} data/tmp`);
    if (p4) tasks.push(`PRESSURE pruned ${p4} /tmp`);
    if (c2) tasks.push(`PRESSURE cleared ${c2} cache/`);

    if (log) {
      log.log([
        { message: '[ DISK-GUARD ]: ', color: ['red', 'cyan'] },
        { message:
          `Disk pressure — cwd=${cwdPct.toFixed(1)}% (${cwdInfo ? cwdInfo.freeHuman : '?'} free) ` +
          `tmp=${tmpPct.toFixed(1)}%${critical ? ' ⛔ CRITICAL' : ''}`,
          color: critical ? 'red' : 'yellow' }
      ]);
    }
  }

  if (critical) {
    // Nuke everything we can in the cache dirs aggressively
    const c3 = cleanCacheDir(path.join(cwd, 'SCRIPTS', 'ZAO-CMDS', 'cache'));
    const p5  = pruneDirectory(path.join(cwd, 'backups'), 2, SNAPSHOT_EXCLUDE);
    if (c3) tasks.push(`CRITICAL cleared ${c3} more cache`);
    if (p5) tasks.push(`CRITICAL pruned ${p5} backups to 2`);

    // Upgrade #4: notify admins on critical disk pressure
    try {
      const api    = global.api || (global.client && global.client.api);
      const admins = (global.config && global.config.ADMINBOT) || [];
      if (api && admins.length) {
        const cwdStr = cwdInfo ? `cwd=${cwdInfo.usedPct.toFixed(1)}% (${cwdInfo.freeHuman} free)` : 'cwd=?';
        const tmpStr = tmpInfo ? `tmp=${tmpInfo.usedPct.toFixed(1)}%` : 'tmp=?';
        const msg =
          `⛔ تحذير: مساحة القرص حرجة!\n\n` +
          `${cwdStr}\n${tmpStr}\n\n` +
          `تم تنظيف ملفات الكاش تلقائيًا. يُنصح بمراجعة الملفات الكبيرة عبر اللوحة.`;
        for (const adminID of admins) {
          const id = String(adminID).trim();
          if (!id) continue;
          try { api.sendMessage(msg, id, () => {}); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  if (tasks.length && log) {
    log.log([
      { message: '[ DISK-GUARD ]: ', color: ['red', 'cyan'] },
      { message: tasks.join(' | '), color: 'white' }
    ]);
  }
}

function start(opts) {
  if (started) return;
  started = true;
  opts = opts || {};
  const checkEveryMs = opts.checkEveryMs || 20 * 60 * 1000; // 20 min (was 30)

  // First sweep after 90 s so startup write spikes settle
  const t1 = setTimeout(() => { try { tick(opts); } catch (_) {} }, 90 * 1000);
  if (t1.unref) t1.unref();
  const t2 = setInterval(() => { try { tick(opts); } catch (_) {} }, checkEveryMs);
  if (t2.unref) t2.unref();
}

module.exports = { start, tick, getDiskInfo, pruneDirectory, rotateLargeLogs, cleanCacheDir };
