'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const CONFIG_PATH  = path.join(ROOT, 'devcenter.config.json');
const VERSIONS_PATH = path.join(ROOT, 'data', 'dc-versions.json');

const DEFAULT_CONFIG = {
  openrouterModel : 'anthropic/claude-3.5-sonnet',
  githubRepo      : '',
  githubBranch    : 'main',
  pipelineMode    : false
};

// ─── Config ──────────────────────────────────────────────────

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch (_) {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function configStatus(cfg) {
  return {
    openrouterModel   : cfg.openrouterModel || DEFAULT_CONFIG.openrouterModel,
    openrouterApiKeySet: !!(process.env.OPENROUTER_API_KEY || cfg.openrouterApiKey),
    githubRepo        : cfg.githubRepo   || '',
    githubBranch      : cfg.githubBranch || 'main',
    githubTokenSet    : !!(process.env.GITHUB_TOKEN  || cfg.githubToken),
    pipelineMode      : cfg.pipelineMode || false
  };
}

// ─── File tree ───────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'backups', 'nkxfca_database',
  'Fca_Database', 'cache', '.cache', 'attached_assets', '.local', 'white'
]);

function getFileTree(dir, prefix, depth) {
  prefix = prefix || '';
  depth  = depth  || 0;
  if (depth > 3) return '';
  let result = '';
  try {
    const items = fs.readdirSync(dir)
      .filter(f => !IGNORE_DIRS.has(f) && !f.startsWith('.'))
      .sort((a, b) => {
        const aD = fs.statSync(path.join(dir, a)).isDirectory();
        const bD = fs.statSync(path.join(dir, b)).isDirectory();
        return (aD === bD) ? a.localeCompare(b) : (aD ? -1 : 1);
      });
    items.forEach((item, i) => {
      const fp   = path.join(dir, item);
      const isD  = (() => { try { return fs.statSync(fp).isDirectory(); } catch (_) { return false; } })();
      const last = i === items.length - 1;
      result += prefix + (last ? '└── ' : '├── ') + item + (isD ? '/' : '') + '\n';
      if (isD) result += getFileTree(fp, prefix + (last ? '    ' : '│   '), depth + 1);
    });
  } catch (_) {}
  return result;
}

// ─── Context loader ──────────────────────────────────────────

function loadContextFiles(prompt) {
  const lower = prompt.toLowerCase();
  const files  = [];
  const seen   = new Set();
  const MAX    = 18000;

  function addFile(rel) {
    const clean = rel.replace(/\\/g, '/');
    if (seen.has(clean)) return;
    seen.add(clean);
    const full = path.join(ROOT, clean);
    if (!fs.existsSync(full)) return;
    try {
      if (!fs.statSync(full).isFile()) return;
      let content = fs.readFileSync(full, 'utf-8');
      if (content.length > MAX) content = content.substring(0, MAX) + '\n... [truncated]';
      files.push({ path: clean, content });
    } catch (_) {}
  }

  const kw = (...words) => words.some(w => lower.includes(w));

  addFile('package.json');
  addFile('ZAO-SETTINGS.json');

  if (kw('main.js','launcher','watchdog','panel','server','api endpoint','http','port'))
    addFile('Main.js');

  if (kw('zao.js','login','connect','mqtt','listen','event','bot logic','tier')) {
    const p = path.join(ROOT, 'ZAO.js');
    if (fs.existsSync(p)) {
      let c = fs.readFileSync(p, 'utf-8');
      if (c.length > MAX) c = c.substring(0, MAX) + '\n... [truncated]';
      files.push({ path: 'ZAO.js', content: c });
      seen.add('ZAO.js');
    }
  }

  if (kw('command','cmd','prefix')) {
    const dir = path.join(ROOT, 'SCRIPTS', 'ZAO-CMDS');
    if (fs.existsSync(dir)) {
      const list = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
      files.push({ path: 'SCRIPTS/ZAO-CMDS/_list.txt', content: list.join('\n') });
      seen.add('SCRIPTS/ZAO-CMDS/_list.txt');
      list.forEach(f => {
        if (lower.includes(f.replace('.js','').toLowerCase())) addFile(`SCRIPTS/ZAO-CMDS/${f}`);
      });
    }
  }

  if (kw('event','join','leave','member')) {
    const dir = path.join(ROOT, 'SCRIPTS', 'ZAO-EVTS');
    if (fs.existsSync(dir))
      fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => addFile(`SCRIPTS/ZAO-EVTS/${f}`));
  }

  if (kw('stealth','human','simulation','delay','typing')) {
    addFile('includes/stealthEngine.js');
    addFile('includes/humanStealth.js');
  }

  if (kw('database','db','sqlite','mongo','sequelize')) addFile('DB/index.js');
  if (kw('health','mqtt health','reconnect'))            addFile('includes/mqttHealthCheck.js');
  if (kw('listen','message handler','dispatch'))         addFile('includes/listen.js');
  if (kw('devcenter','dev center','github'))             addFile('includes/devCenter.js');
  if (kw('e2ee','labyrinth','encrypt','signal'))         addFile('includes/labyrinth/index.js');
  if (kw('human sim','activity sim'))                    addFile('includes/HumanActivitySimulator.js');

  const fileMatches = prompt.match(/[\w./\\-]+\.(js|json|md|txt|lang)/g) || [];
  fileMatches.forEach(f => addFile(f.replace(/\\/g, '/')));

  return files;
}

// ─── Diff ────────────────────────────────────────────────────

function computeLineDiff(original, modified) {
  const a = (original || '').split('\n');
  const b = (modified  || '').split('\n');
  let added = 0, removed = 0;

  if (a.length > 400 || b.length > 400) {
    const lines = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (i >= a.length)       { lines.push({ t: '+', text: b[i], n: i+1 }); added++; }
      else if (i >= b.length)  { lines.push({ t: '-', text: a[i], n: i+1 }); removed++; }
      else if (a[i] !== b[i])  {
        lines.push({ t: '-', text: a[i], n: i+1 }); removed++;
        lines.push({ t: '+', text: b[i], n: i+1 }); added++;
      } else                   { lines.push({ t: '=', text: a[i], n: i+1 }); }
    }
    return { lines, added, removed };
  }

  const m = a.length, n = b.length;
  const dp = Array.from({ length: m+1 }, () => new Int32Array(n+1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = (a[i-1] === b[j-1]) ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const trace = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      trace.push({ t: '=', text: a[i-1], an: i, bn: j }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      trace.push({ t: '+', text: b[j-1], bn: j }); added++; j--;
    } else {
      trace.push({ t: '-', text: a[i-1], an: i }); removed++; i--;
    }
  }
  trace.reverse();
  return { lines: trace, added, removed };
}

// ─── Pollinations AI (free, no key needed) ───────────────────

async function callPollinations(messages) {
  const axios = require('axios');
  const ENDPOINTS = [
    'https://text.pollinations.ai/openai',
    'https://api.pollinations.ai/v1/chat/completions',
  ];
  const TIMEOUT_MS = 90000;
  let lastError = null;
  for (const url of ENDPOINTS) {
    try {
      const resp = await axios.post(url, {
        model: 'openai',
        messages,
        stream: false,
        seed: Math.floor(Math.random() * 99999)
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: TIMEOUT_MS
      });
      const reply = resp.data?.choices?.[0]?.message?.content;
      if (reply && reply.trim()) return reply.trim();
    } catch (e) {
      lastError = e;
    }
  }
  const errMsg = lastError
    ? (lastError.code === 'ECONNABORTED' ? 'Pollinations AI request timed out (90s). Try a shorter prompt.' : `Pollinations AI error: ${lastError.message}`)
    : 'Pollinations AI unavailable — check internet connection.';
  throw new Error(errMsg);
}

// ─── Multi-Agent Pipeline ────────────────────────────────────

const PIPELINE_AGENTS = {
  analyst: {
    name: 'Analyst',
    icon: '🔍',
    systemPrompt: `You are an expert Node.js code analyst specialising in Facebook Messenger bots. Your job is to analyse the request and codebase, identify what needs to change and why, and produce a clear, concise analysis plan. Be precise and technical.`
  },
  implementer: {
    name: 'Implementer',
    icon: '💻',
    systemPrompt: `You are an expert Node.js developer for Facebook Messenger bots. Based on the analyst's plan, write the actual code changes. Return ONLY valid JSON in this exact format (no markdown fences):
{"explanation":"what changed","changes":[{"file":"path/to/file.js","action":"modify","content":"full new file content"}]}
Valid actions: modify, create, delete. Return complete file content for every modified file.`
  },
  reviewer: {
    name: 'Reviewer',
    icon: '✅',
    systemPrompt: `You are a senior code reviewer for Facebook Messenger bots. Review the implementer's changes for correctness, safety, and completeness. If the JSON is valid and safe, respond with: APPROVED\n\nIf there are issues, respond with: ISSUES FOUND\n<list issues>`
  }
};

async function runMultiAgentPipeline(prompt, contextFiles, cfg) {
  const steps = [];
  const tree = getFileTree(ROOT);
  let ctxText = `## Project Structure\n\`\`\`\n${tree}\`\`\`\n\n`;
  for (const f of contextFiles.slice(0, 6)) {
    ctxText += `## ${f.path}\n\`\`\`js\n${f.content}\n\`\`\`\n\n`;
  }

  // Step 1: Analyst
  const analystMsgs = [
    { role: 'system', content: PIPELINE_AGENTS.analyst.systemPrompt },
    { role: 'user', content: `${ctxText}\n## Developer Request\n${prompt}\n\nAnalyse what changes are needed.` }
  ];
  const analystReply = await callPollinations(analystMsgs);
  steps.push({ agent: 'analyst', name: PIPELINE_AGENTS.analyst.name, icon: PIPELINE_AGENTS.analyst.icon, reply: analystReply });

  // Step 2: Implementer
  const SYSTEM_PROMPT_IMPL = `You are an expert Node.js developer embedded in ZAO Bot's Dev Center. ZAO Bot is a Facebook Messenger bot with stealth/anti-detection, E2EE, multi-account session management, command/event system, and an HTTP control panel.\n\nRESPOND WITH ONLY VALID JSON — no markdown fences:\n{"explanation":"Clear description","changes":[{"file":"path/relative/to/root.js","action":"modify","content":"complete new file content"}]}\nValid actions: modify, create, delete. Rules: match existing code style, minimise changes, never remove stealth/E2EE features.`;

  const implMsgs = [
    { role: 'system', content: SYSTEM_PROMPT_IMPL },
    { role: 'user', content: `${ctxText}\n## Developer Request\n${prompt}\n\n## Analyst's Analysis\n${analystReply}\n\nNow implement the changes. Return only valid JSON.` }
  ];
  const implReply = await callPollinations(implMsgs);
  steps.push({ agent: 'implementer', name: PIPELINE_AGENTS.implementer.name, icon: PIPELINE_AGENTS.implementer.icon, reply: implReply });

  // Parse implementer output
  let parsed = { explanation: '', changes: [] };
  try {
    const fence = implReply.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fence ? fence[1].trim() : implReply;
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(braceMatch ? braceMatch[0] : jsonStr);
    if (!Array.isArray(parsed.changes)) parsed.changes = [];
  } catch (_) {
    parsed.explanation = implReply;
  }

  // Step 3: Reviewer
  const reviewMsgs = [
    { role: 'system', content: PIPELINE_AGENTS.reviewer.systemPrompt },
    { role: 'user', content: `Original request: ${prompt}\n\nAnalyst's plan:\n${analystReply}\n\nImplementer's JSON output:\n${implReply}\n\nIs the implementation correct and safe?` }
  ];
  const reviewReply = await callPollinations(reviewMsgs);
  steps.push({ agent: 'reviewer', name: PIPELINE_AGENTS.reviewer.name, icon: PIPELINE_AGENTS.reviewer.icon, reply: reviewReply });

  return { steps, result: parsed };
}

// ─── Versioning ───────────────────────────────────────────────

function loadVersions() {
  try {
    if (fs.existsSync(VERSIONS_PATH))
      return JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf-8'));
  } catch (_) {}
  return [];
}

function saveVersion(prompt, result) {
  try {
    if (!fs.existsSync(path.dirname(VERSIONS_PATH)))
      fs.mkdirSync(path.dirname(VERSIONS_PATH), { recursive: true });
    const versions = loadVersions();
    versions.push({
      id: Date.now(),
      ts: new Date().toISOString(),
      prompt: (prompt || '').substring(0, 200),
      files: (result.changes || []).map(c => c.file),
      explanation: (result.explanation || '').substring(0, 300)
    });
    // Keep last 20 versions
    if (versions.length > 20) versions.splice(0, versions.length - 20);
    fs.writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2), 'utf-8');
  } catch (_) {}
}

// ─── OpenRouter ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Node.js developer embedded in ZAO Bot's Dev Center.
ZAO Bot is a Facebook Messenger bot with: stealth/anti-detection, E2EE, multi-account session management, command/event system, SQLite+MongoDB databases, and an HTTP control panel.

RESPOND WITH ONLY VALID JSON — no markdown fences, no extra text:
{
  "explanation": "Clear description of what you changed and why",
  "changes": [
    {
      "file": "path/relative/to/project/root.js",
      "action": "modify",
      "content": "complete new file content"
    }
  ]
}

Valid actions: "modify" (existing), "create" (new file), "delete" (set content to "").
Rules:
- Match existing code style exactly (indentation, quote style, semicolons)
- Minimise changes — only touch files that must change
- Never remove stealth, E2EE, or session-safety features
- Never expose credentials or session tokens in code
- If request is unsafe or ambiguous, explain in "explanation" and return empty "changes" array`;

async function callOpenRouter(prompt, contextFiles, cfg) {
  const axios  = require('axios');
  const apiKey = process.env.OPENROUTER_API_KEY || cfg.openrouterApiKey || '';
  if (!apiKey) throw new Error('OpenRouter API key not configured. Add it in Dev Center → Configuration, or use Pipeline mode (free).');

  const tree = getFileTree(ROOT);
  let context = `## Project Structure\n\`\`\`\n${tree}\`\`\`\n\n`;
  let totalChars = context.length + SYSTEM_PROMPT.length + prompt.length;
  const MAX_CTX = 70000;

  for (const f of contextFiles) {
    const block = `## ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
    if (totalChars + block.length > MAX_CTX) break;
    context += block;
    totalChars += block.length;
  }

  const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model   : cfg.openrouterModel || DEFAULT_CONFIG.openrouterModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: `${context}\n## Developer Task\n${prompt}` }
    ],
    temperature: 0.15,
    max_tokens : 8192
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type' : 'application/json',
      'HTTP-Referer' : 'https://zao-bot.replit.app',
      'X-Title'      : 'ZAO Dev Center'
    },
    timeout: 120000
  });

  const raw = (res.data.choices[0].message.content || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : raw;
  const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
  let parsed;
  try { parsed = JSON.parse(braceMatch ? braceMatch[0] : jsonStr); }
  catch (e) { throw new Error(`AI did not return valid JSON. Response: ${raw.substring(0, 300)}`); }

  if (!Array.isArray(parsed.changes)) parsed.changes = [];
  return parsed;
}

// ─── Prepare changes + diff ──────────────────────────────────

function prepareChangesWithDiff(aiResult) {
  const changes = (aiResult.changes || []).map(change => {
    const full = path.join(ROOT, change.file || '');
    let original = '';
    try { if (fs.existsSync(full)) original = fs.readFileSync(full, 'utf-8'); } catch (_) {}
    const diff = (change.action === 'delete')
      ? { lines: [], added: 0, removed: original.split('\n').length }
      : computeLineDiff(original, change.content || '');
    return { ...change, diff, hasOriginal: !!original };
  });
  return { ...aiResult, changes };
}

// ─── Apply ───────────────────────────────────────────────────

const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024; // [FIX] 2 MB per-file cap — prevents AI from writing unbounded content

function applyChanges(changes) {
  const results = [];
  for (const c of changes) {
    const full = path.join(ROOT, c.file || '');
    if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
      results.push({ file: c.file, ok: false, error: 'Path traversal denied' });
      continue;
    }
    // [FIX] Reject files whose content exceeds the per-file size cap.
    const contentStr = c.content || '';
    if (c.action !== 'delete' && Buffer.byteLength(contentStr, 'utf-8') > MAX_FILE_WRITE_BYTES) {
      results.push({ file: c.file, ok: false, error: `Content too large (>${MAX_FILE_WRITE_BYTES / 1024}KB limit)` });
      continue;
    }
    try {
      if (c.action === 'delete') {
        if (fs.existsSync(full)) fs.unlinkSync(full);
        results.push({ file: c.file, ok: true, action: 'deleted' });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contentStr, 'utf-8');
        results.push({ file: c.file, ok: true, action: c.action });
      }
    } catch (e) { results.push({ file: c.file, ok: false, error: e.message }); }
  }
  return results;
}

// ─── Git ─────────────────────────────────────────────────────

function gitStatus() {
  try {
    const opts  = { cwd: ROOT, encoding: 'utf-8', timeout: 10000 };
    const status = execSync('git --no-optional-locks status --short', opts).trim();
    const log    = execSync('git --no-optional-locks log --oneline -8', opts).trim();
    const branch = execSync('git --no-optional-locks branch --show-current', opts).trim();
    return { ok: true, status, recentCommits: log, branch };
  } catch (e) { return { ok: false, error: e.message }; }
}

function gitCommitAndPush(message, cfg) {
  const token  = process.env.GITHUB_TOKEN || cfg.githubToken  || '';
  const repo   = (cfg.githubRepo   || '').trim();
  const branch = (cfg.githubBranch || 'main').trim();
  if (!token) throw new Error('GitHub token not configured');
  if (!repo)  throw new Error('GitHub repository not configured (e.g. username/repo)');

  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  const opts   = { cwd: ROOT, encoding: 'utf-8', timeout: 60000, stdio: 'pipe' };
  try {
    try { execSync('git config user.email "zao-devcenter@replit.app"', opts); } catch (_) {}
    try { execSync('git config user.name "ZAO Dev Center"', opts); } catch (_) {}
    execSync('git --no-optional-locks add -A', opts);
    const dirty = execSync('git --no-optional-locks status --short', opts).trim();
    if (!dirty) return { ok: true, message: 'Nothing to commit — working tree clean', noop: true };
    const safe = message.replace(/["`$\\]/g, "'").substring(0, 200);
    execSync(`git --no-optional-locks commit -m "${safe}"`, opts);
    execSync(`git push "${remote}" "${branch}"`, opts);
    const last = execSync('git --no-optional-locks log --oneline -1', opts).trim();
    return { ok: true, message: `Pushed to ${repo}:${branch}`, commit: last };
  } catch (e) {
    const raw = ((e.stderr ? e.stderr.toString() : '') + e.message);
    throw new Error(raw.split(token).join('***'));
  }
}

function gitRevert() {
  const opts = { cwd: ROOT, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' };
  try {
    try { execSync('git config user.email "zao-devcenter@replit.app"', opts); } catch (_) {}
    try { execSync('git config user.name "ZAO Dev Center"', opts); } catch (_) {}
    execSync('git --no-optional-locks revert HEAD --no-edit', opts);
    const last = execSync('git --no-optional-locks log --oneline -1', opts).trim();
    return { ok: true, lastCommit: last };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  readConfig, saveConfig, configStatus,
  loadContextFiles, callOpenRouter,
  prepareChangesWithDiff, applyChanges,
  gitStatus, gitCommitAndPush, gitRevert,
  runMultiAgentPipeline, loadVersions, saveVersion
};
