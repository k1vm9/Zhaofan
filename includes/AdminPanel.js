/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ZAO ADMIN PANEL — Express.js Dashboard
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 
 * Real-time monitoring and admin features:
 * - Live bot logs
 * - Bot status/metrics
 * - Command enable/disable
 * - User management
 * - Security settings
 * - Restart functionality
 */

'use strict';

const express = require('express');
const http = require('http');
const session = require('express-session');
const path = require('path');
const fs = require('fs-extra');

const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Configuration
const PORT = process.env.PANEL_PORT || 5000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'zao@admin123';

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'zao-secret-key-' + Date.now(),
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Serve static files
app.use(express.static(path.join(__dirname, '../panel')));

// ─── Auth Middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(403).json({ error: 'Not authenticated' });
}

// ─── Live Logs Storage ──────────────────────────────────────────────────────
const LOG_LIMIT = 500;
const logs = [];

const notifications = [];
const notifClients = new Set();
const MAX_NOTIFICATIONS = 120;
const loginAttempts = new Map();

function pushNotification(level, message) {
  const entry = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    level,
    message: String(message).slice(0, 280)
  };
  notifications.push(entry);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
  for (const client of notifClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) { notifClients.delete(client); }
  }
}

function isLoginBlocked(ip) {
  const now = Date.now();
  const row = loginAttempts.get(ip);
  if (!row) return false;
  if (row.blockUntil && row.blockUntil > now) return true;
  if (row.blockUntil && row.blockUntil <= now) loginAttempts.delete(ip);
  return false;
}

function onFailedLogin(ip) {
  const now = Date.now();
  const row = loginAttempts.get(ip) || { count: 0, firstSeen: now, blockUntil: 0 };
  if (now - row.firstSeen > 10 * 60 * 1000) {
    row.count = 0;
    row.firstSeen = now;
  }
  row.count += 1;
  if (row.count >= 8) row.blockUntil = now + 10 * 60 * 1000;
  loginAttempts.set(ip, row);
}

function addLog(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: String(message).substring(0, 500)
  };
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.shift();
}

// Patch console methods
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = function(...args) {
  originalLog.apply(console, args);
  addLog('info', args.join(' '));
};

console.error = function(...args) {
  originalError.apply(console, args);
  addLog('error', args.join(' '));
};

console.warn = function(...args) {
  originalWarn.apply(console, args);
  addLog('warn', args.join(' '));
};

// ─── Routes ─────────────────────────────────────────────────────────────────

// Login
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (isLoginBlocked(ip)) return res.status(429).json({ error: 'Too many attempts. Retry in 10 minutes.' });

  const { password } = req.body;
  const provided = String(password || '');
  const expected = String(ADMIN_PASSWORD || '');
  const ok = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (ok) {
    req.session.authenticated = true;
    loginAttempts.delete(ip);
    pushNotification('info', `Admin login from ${ip}`);
    return res.json({ success: true, message: 'Logged in' });
  }

  onFailedLogin(ip);
  pushNotification('warn', `Failed login attempt from ${ip}`);
  res.status(401).json({ error: 'Invalid password' });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.authenticated = false;
  res.json({ success: true });
});

// Get logs
app.get('/api/logs', requireAuth, (req, res) => {
  res.json(logs.slice(-100));
});

// Get bot status
app.get('/api/status', requireAuth, (req, res) => {
  try {
    const antiDetect = global._botApi ? require('./AntiDetectionEnhanced') : null;
    const status = {
      online: !!global._botApi,
      uptime: process.uptime(),
      botUserID: global.botUserID || 'Unknown',
      antiDetection: antiDetect?.getStatus() || null,
      memory: process.memoryUsage(),
      timestamp: Date.now()
    };
    res.json(status);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Get all commands
app.get('/api/commands', requireAuth, (req, res) => {
  try {
    const commands = Array.from(global.client?.commands?.entries() || []).map(([name, cmd]) => ({
      name,
      description: cmd.config?.description || 'No description',
      usage: cmd.config?.usage || '',
      enabled: !(global.config.commandDisabled || []).includes(name)
    }));
    res.json(commands);
  } catch (e) {
    res.json({ error: e.message });
  }
});



// Notifications
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(notifications.slice(-100));
});

app.get('/api/notifications/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  notifClients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(hb); notifClients.delete(res); });
});

// Dev center inspired quick diagnostics
app.get('/api/devcenter/quick-stats', requireAuth, (req, res) => {
  const commands = Array.from(global.client?.commands?.keys() || []);
  res.json({
    commands: commands.length,
    disabledCommands: (global.config?.commandDisabled || []).length,
    eventsLoaded: Array.from(global.client?.eventRegistered || []).length,
    uptimeSec: Math.floor(process.uptime()),
    node: process.version,
    rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100
  });
});

app.post('/api/devcenter/code-scan', requireAuth, (req, res) => {
  const cmd = `rg --files -g '*.js' -g '!white/**' -g '!node_modules/**' | xargs -r -n1 node --check`;
  const out = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: 120000 });
  const ok = out.status === 0;
  pushNotification(ok ? 'info' : 'error', ok ? 'Code scan completed with no syntax errors' : 'Code scan detected syntax issues');
  res.json({ ok, status: out.status, stdout: out.stdout?.slice(-4000) || '', stderr: out.stderr?.slice(-4000) || '' });
});

// ─── Server Start ────────────────────────────────────────────────────────────

function startPanel() {
  server.listen(PORT, () => {
    console.log(`[ADMIN-PANEL] 🌐 Started on http://localhost:${PORT}`);
    console.log(`[ADMIN-PANEL] 🔐 Default password: ${ADMIN_PASSWORD}`);
  });
}

// Export
module.exports = {
  startPanel,
  addLog,
  server,
  app
};
