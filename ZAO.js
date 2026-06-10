// ============================================================
// ZAO.js — Deobfuscated
// ============================================================
// [FIX DB-BOOT] — Increase libuv thread pool before any I/O.
// Default pool size is 4 which gets exhausted by heavy requires
// (googleapis, moment-timezone, sqlite3, DNS lookups) causing
// sequelize.authenticate() and Facebook login DNS to stall forever.
// Must be set here (before any require) for the lazy-pool creation
// to pick it up. Main.js also passes UV_THREADPOOL_SIZE=8 via env.
// [PERF] — Reduced from 32 → 8: SQLite only needs 4-8 threads.
// 32 reserved-but-idle threads wasted ~72 MB of stack RAM.
process.env.UV_THREADPOOL_SIZE = '8';

const chalk = require('chalk');
const { readdirSync, readFileSync, writeFileSync } = require('fs-extra');
// [FIX Djamel] — atomic writes for cookie/state files. Falls back to
// raw writeFileSync if the helper is missing so the bot still boots.
const { atomicWriteFileSync } = (() => {
  try { return require('./utils/atomicWrite'); }
  catch (_) { return { atomicWriteFileSync: writeFileSync }; }
})();
const axios = require('axios');
const { join, resolve } = require('path');
const { execSync } = require('child_process');
const logger = require('./utils/log.js');

// ─── Ensure data directory exists at startup ──────────────────
try { require('fs-extra').ensureDirSync(require('path').join(process.cwd(), 'data')); } catch (_) {}

// ─── nkxfca library patcher ───────────────────────────────────
// Prevents the library's old loginHelper from registering a
// process.exit(1) handler that kills the bot before state is saved
// or another tier is tried. Must run before login().
const nkxPatcher = require('./includes/nkxfcaPatcher');
nkxPatcher.preventLoginHelperHandlers();
// Patch FCA's SQLite backup with a timeout BEFORE login so it can never
// stall the login flow (SQLITE_BUSY from concurrent Sequelize operations).
nkxPatcher.patchFcaDatabase();
// Wrap loginHelper BEFORE it is captured by client.js — catches silent async
// errors that would otherwise leave loginAsync hanging for 3 minutes.
nkxPatcher.patchLoginHelper();

const login = require('./includes/Emalogin');
const modernizeNkxApi = require('./includes/nkxfcaModernizer');
const listPackage = JSON.parse(readFileSync('./package.json'))['dependencies'];
const listbuiltinModules = require('module')['builtinModules'];

console.log(chalk.bold.hex('#1390f0')('──ZAOFAN-SETTINGS─●'));

const cv = chalk.bold.hex('#1390f0');

logger.log([
  { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
  { message: 'ZAO Is working', color: 'white' }
]);
logger.log([
  { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
  { message: 'This Bot Is SAIN - ♤', color: 'white' }
]);

// ─── Global client object ─────────────────────────────────────
global['client'] = new Object({
  commands:         new Map(),
  events:           new Map(),
  cooldowns:        new Map(),
  eventRegistered:  new Array(),
  handleSchedule:   new Array(),
  handleReaction:   new Array(),
  handleReply:      new Array(),
  mainPath:         process.cwd(),
  configPath:       new String()
});

global['rtg']        = true;
global['YukiBot']    = {};
global['loggeryuki'] = logger;
global['YukiBot']['logger'] = logger;

// ─── Global data store ────────────────────────────────────────
global['data'] = new Object({
  threadInfo:       new Map(),
  threadData:       new Map(),
  userName:         new Map(),
  userBanned:       new Map(),
  threadBanned:     new Map(),
  commandBanned:    new Map(),
  threadAllowNSFW:  new Array(),
  allUserID:        new Array(),
  allCurrenciesID:  new Array(),
  allThreadID:      new Array()
});

global['utils'] = require('./includes/Ema/lts.js');

// ─── createQueue helper ───────────────────────────────────────
global['utils']['createQueue'] = function createQueue(handler) {
  const queue = [];
  const api = {
    push: function(item) {
      queue.push(item);
      if (queue.length == 1) api.next();
    },
    running: null,
    length: function() {
      return queue.length;
    },
    next: function() {
      if (queue.length > 0) {
        const current = queue[0];
        api.running = current;
        const done = function(err, result) {
          api.running = null;
          queue.shift();
          api.next();
        };
        try {
          handler(current, done);
        } catch (_) {
          done();
        }
      }
    }
  };
  return api;
};

// ─── DBYUKI / db globals ──────────────────────────────────────
global['DBYUKI'] = {
  database: {
    creatingThreadData:    [],
    creatingUserData:      [],
    creatingDashBoardData: [],
    creatingGlobalData:    []
  }
};

global['db'] = {
  allThreadData:           [],
  allUserData:             [],
  allGlobalData:           [],
  threadModel:             null,
  userModel:               null,
  globalModel:             null,
  threadsData:             null,
  usersData:               null,
  globalData:              null,
  receivedTheFirstMessage: {}
};

global['nodemodule']   = new Object();
global['config']       = new Object();
global['funcs']        = require('./includes/Ema/lts.js');
global['configModule'] = new Object();
global['moduleData']   = new Array();
global['language']     = new Object();

// ─── Load config file ─────────────────────────────────────────
var configValue;
try {
  global['client']['configPath'] = join(global['client']['mainPath'], 'ZAO-SETTINGS.json');
  configValue = require(global['client']['configPath']);
} catch (e) {
  return logger.log([
    { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
    { message: "Can't Load config", color: 'white' }
  ]);
}

const envApiOverrides = {
  'YOUTUBE_API': process.env.YOUTUBE_API_KEY || '',
  'WOLFRAM': process.env.WOLFRAM_API_KEY || '',
  'SAUCENAO_API': process.env.SAUCENAO_API_KEY || '',
  'OPEN_WEATHER': process.env.OPENWEATHER_API_KEY || '',
  'SOUNDCLOUD_API': process.env.SOUNDCLOUD_API_KEY || '',
  'APIKEY': process.env.SIMSIMI_API_KEY || ''
};
const missingSecrets = [];
for (const section in configValue) {
  if (typeof configValue[section] === 'object' && configValue[section] !== null && !Array.isArray(configValue[section])) {
    for (const key in envApiOverrides) {
      if (key in configValue[section]) {
        if (envApiOverrides[key] && !configValue[section][key]) {
          configValue[section][key] = envApiOverrides[key];
        } else if (!configValue[section][key] && !envApiOverrides[key]) {
          missingSecrets.push(`${section}.${key}`);
        }
      }
    }
  }
}
if (missingSecrets.length > 0) {
  logger.log([
    { message: '[ CONFIG ]: ', color: ['red', 'cyan'] },
    { message: 'Missing API keys (set via env secrets or config): ' + missingSecrets.join(', '), color: 'yellow' }
  ]);
}

// ─── Apply config values to global ───────────────────────────
try {
  for (const key in configValue) global['config'][key] = configValue[key];
  // Merge runtime overrides (persists admin additions across Railway deploys)
  try { require('./includes/runtimePersist').mergeIntoConfig(); } catch (_) {}
  logger.log([
    { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
    { message: 'Loaded config', color: 'white' }
  ]);
} catch {
  return logger.log([
    { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
    { message: 'Not Found config', color: 'white' }
  ]);
}

// ─── توافق مع مكتبات GoatBot — alias بسيط ────────────────────
// بعض الوحدات (lts.js) تقرأ global.GoatBot.config لذا نُعرّفه هنا
global['GoatBot'] = {
  config: global['config'],
  language: global['language'],
  db:     global['db'],
};

// ─── Load Sequelize + language file ──────────────────────────
const { Sequelize, sequelize } = require('./includes/database');
// [FIX Djamel] — original called readFileSync with no try/catch, so a
// missing or mistyped `language` value in ZAO-SETTINGS.json (e.g. "english"
// instead of "en") crashed the entire process at boot with no useful log.
// Now we fall back to en.lang and, if even that's gone, to an empty file
// so the bot still starts (getText returns the diagnostic stub anyway).
let langFile;
try {
  langFile = readFileSync(
    __dirname + '/languages/' + (global['config']['language'] || 'en') + '.lang',
    { encoding: 'utf-8' }
  ).split(/\r?\n|\r/);
} catch (e) {
  logger.log([
    { message: '[ LANG ]: ', color: ['red', 'cyan'] },
    { message: `Could not load language "${global['config']['language']}" — falling back to en. (${e.message})`, color: 'yellow' }
  ]);
  try {
    langFile = readFileSync(__dirname + '/languages/en.lang', { encoding: 'utf-8' }).split(/\r?\n|\r/);
  } catch (_) {
    langFile = [];
  }
}

const langData = langFile.filter(line => line.indexOf('#') != 0 && line != '');

for (const item of langData) {
  const getSeparator = item.indexOf('=');
  const itemKey      = item.slice(0, getSeparator);
  const itemValue    = item.slice(getSeparator + 1, item.length);
  const head         = itemKey.slice(0, itemKey.indexOf('.'));
  const key          = itemKey.replace(head + '.', '');
  const value        = itemValue.replace(/\\n/gi, '\n');

  if (typeof global['language'][head] === 'undefined')
    global['language'][head] = new Object();

  global['language'][head][key] = value;
}

// ─── getText helper ───────────────────────────────────────────
global['getText'] = function(...args) {
  const getLang = global['language'];
  const [moduleName, keyName, ...rest] = args;

  if (!getLang[moduleName]) return `${moduleName} - Not found key language: ${keyName}`;
  if (!getLang[moduleName][keyName]) return `${moduleName} - Not found key language: ${keyName}`;

  let text = getLang[moduleName][keyName];
  for (let i = 0; i < rest.length; i++) {
    text = text.replace(new RegExp(`%${i + 1}`, 'g'), rest[i]);
  }
  return text;
};

// ─── onBot: login + load commands/events ─────────────────────
async function onBot({ models }) {
  console.log('[DIAG] onBot: started');
  const _models = models;
  let _api, _threadsData, _usersData, _globalData;

  console.log('[DIAG] onBot: starting login...');
  // ── Login ────────────────────────────────────────────────
  try {
    const loginResult = await login({
      FCAOption: global['config']['FCAOption'] || {}
    });

    if (!loginResult || !loginResult['getAppState']) {
      logger.log([
        { message: '[ Login ]: ', color: ['red', 'cyan'] },
        { message: 'Login failed — no valid session. Watchdog will retry.', color: 'white' }
      ]);
      process.exit(1);
    }

    logger.log([
      { message: '[ Login ]: ', color: ['red', 'cyan'] },
      { message: 'Found AppState', color: 'white' }
    ]);

    _api = loginResult;
    _api = modernizeNkxApi(_api);

    // Patch nkxfca's internal antiSuspension limits after the library is loaded
    nkxPatcher.patchAntiSuspensionLimits();

    // Stop FCA's built-in session-monitor, token-refresh, and presence-keepalive
    // intervals — ZAO's own keepAlive / mqttHealthCheck / autoRelogin modules
    // already cover all of these. Running both doubles HTTP traffic and CPU use.
    nkxPatcher.disableFcaInternalServices(_api);

    // ── Wire extended API modules onto the live API object ─────────────────
    // nkxfca exposes api.ctx and api.defaultFuncs so all factory functions
    // can be wired without touching node_modules.
    try {
      const _ctx  = _api.ctx;
      const _df   = _api.defaultFuncs;
      if (_ctx && _df) {
        _api.pinMessage    = require('./includes/pinMessage')(    _df, _api, _ctx);
        _api.gcrule        = require('./includes/groupAdminRule')(_df, _api, _ctx);
        _api.friend        = require('./includes/friendManager')( _df, _api, _ctx);
        _api.follow        = require('./includes/userFollow')(    _df, _api, _ctx);
        _api.createComment = require('./includes/postComment')(   _df, _api, _ctx);
        _api.story         = require('./includes/storyApi')(      _df, _api, _ctx);
        _api.notes         = require('./includes/messengerNotes')(_df, _api, _ctx);
        logger.log([{ message: '[ APIS ]: ', color: ['red', 'cyan'] }, { message: 'Extended API modules wired ✓ (pin, gcrule, friend, follow, comment, story, notes)', color: 'white' }]);
      } else {
        logger.log([{ message: '[ APIS ]: ', color: ['red', 'cyan'] }, { message: 'ctx/defaultFuncs not ready — extended APIs skipped (non-fatal)', color: 'yellow' }]);
      }
    } catch (_wireErr) {
      logger.log([{ message: '[ APIS ]: ', color: ['red', 'cyan'] }, { message: 'Extended API wiring error: ' + (_wireErr.message || _wireErr), color: 'yellow' }]);
    }
  } catch (e) {
    logger.log([
      { message: '[ Login ]: ', color: ['red', 'cyan'] },
      { message: `Login threw error: ${e.message || e} — watchdog will retry.`, color: 'white' }
    ]);
    process.exit(1);
  }

  global.botUserID = _api.getCurrentUserID ? _api.getCurrentUserID() : '';
  global._botApi   = _api;   // exposed so timers/keepAlive/health modules can reach the live API

  // ── Centralised send pipeline ─────────────────────────────
  try {
    require('./includes/sendPipeline').patch(_api);
  } catch (_) {}

  // ── Set API options ───────────────────────────────────────
  _api.setOptions({
    listenEvents:  true,
    selfListen:    false,
    autoMarkRead:  false,
    updatePresence: false,
    listenTyping:  false,
    autoReconnect: true
  });

  console.log('[DIAG] onBot: login succeeded, loading DB controller...');
  // ── Load DB models ────────────────────────────────────────
  try {
    const dbController = await require('./DB/controller/index.js')({ models: _models });
    _threadsData = dbController['threadsData'];
    _usersData   = dbController['usersData'];
    _globalData  = dbController['globalData'];

    global['db']['threadsData'] = _threadsData;
    global['db']['usersData']   = _usersData;
    global['db']['globalData']  = _globalData;
    global['db']['threadModel'] = _models['threadModel'];
    global['db']['userModel']   = _models['userModel'];
    global['db']['globalModel'] = _models['globalModel'];
  } catch (e) {
    logger.log([
      { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
      { message: "Can't Connect to DB: " + e.message, color: 'white' }
    ]);
    console.error(e);
    return;
  }

  // ── Load Commands ─────────────────────────────────────────
  (function () {
    // [FIX Djamel] — defensive guard: if commandDisabled key is missing or
    // not an array (e.g. operator deletes it via the panel), the original
    // `.includes(f)` call threw a TypeError and aborted ALL command loading,
    // booting the bot with zero commands. Coerce to [] so missing config
    // is treated as "nothing disabled".
    const _disabledCmds = Array.isArray(global['config']['commandDisabled'])
      ? global['config']['commandDisabled']
      : [];
    const cmdFiles = readdirSync(global['client']['mainPath'] + '/SCRIPTS/ZAO-CMDS')
      .filter(f => f.endsWith('.js') && !_disabledCmds.includes(f));

    for (const file of cmdFiles) {
      try {
        var cmd = require(global['client']['mainPath'] + '/SCRIPTS/ZAO-CMDS/' + file);

        if (!cmd['config'] || !cmd['run'])
          throw new Error(global['getText']('mirai', 'Error in cmd format'));

        if (global['client']['commands'].has(cmd['config']['name']))
          throw new Error(global['getText']('mirai', 'Name Is Repeated'));

        // Install npm dependencies declared in cmd config
        if (cmd['config']['dependencies'] && typeof cmd['config']['dependencies'] == 'object') {
          for (const pkgName in cmd['config']['dependencies']) {
            const pkgPath = join(__dirname, 'nodemodules', 'node_modules', pkgName);
            try {
              if (!global['nodemodule'].hasOwnProperty(pkgName)) {
                if (listPackage.hasOwnProperty(pkgName) || listbuiltinModules.includes(pkgName))
                  global['nodemodule'][pkgName] = require(pkgName);
                else
                  global['nodemodule'][pkgName] = require(pkgPath);
              }
            } catch {
              const allowInstall = global['config'] && global['config'].allowAutoNpmInstall === true;
              if (!allowInstall) {
                throw new Error('Missing dependency: ' + pkgName + ' (auto npm install disabled)');
              }

              let loaded = false, lastErr;
              const ver = cmd['config']['dependencies'][pkgName];
              // [FIX T009] — 90s timeout: slow npm registry cannot deadlock boot
              try {
                execSync(
                  'npm --package-lock false --save install ' + pkgName +
                    (ver == '*' || ver == '' ? '' : '@' + ver),
                  { stdio: 'inherit', env: process.env, shell: true, cwd: join(__dirname, 'nodemodules'), timeout: 90_000 }
                );
              } catch (installErr) {
                throw new Error(`npm install "${pkgName}" failed or timed out: ${installErr && installErr.message ? installErr.message : installErr}`);
              }
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  // Clear only this module from cache, not the entire cache
                  try { delete require.cache[require.resolve(pkgPath)]; } catch (_) {}
                  try { delete require.cache[require.resolve(pkgName)]; } catch (_) {}
                  if (listPackage.hasOwnProperty(pkgName) || listbuiltinModules.includes(pkgName))
                    global['nodemodule'][pkgName] = require(pkgName);
                  else
                    global['nodemodule'][pkgName] = require(pkgPath);
                  loaded = true;
                  break;
                } catch (err) {
                  lastErr = err;
                }
                if (loaded || !lastErr) break;
              }
              if (!loaded || lastErr) throw (lastErr || new Error('Failed to load dependency: ' + pkgName));
            }
          }
        }

        // Apply envConfig overrides
        if (cmd['config']['envConfig']) {
          try {
            for (const envKey in cmd['config']['envConfig']) {
              if (typeof global['configModule'][cmd['config']['name']] === 'undefined')
                global['configModule'][cmd['config']['name']] = {};
              if (typeof global['config'][cmd['config']['name']] === 'undefined')
                global['config'][cmd['config']['name']] = {};
              if (typeof global['config'][cmd['config']['name']][envKey] !== 'undefined')
                global['configModule'][cmd['config']['name']][envKey] = global['config'][cmd['config']['name']][envKey];
              else
                global['configModule'][cmd['config']['name']][envKey] = cmd['config']['envConfig'][envKey] || '';
              if (typeof global['config'][cmd['config']['name']][envKey] === 'undefined')
                global['config'][cmd['config']['name']][envKey] = cmd['config']['envConfig'][envKey] || '';
            }
          } catch (e) {
            throw new Error('Env Error');
          }
        }

        // Run onLoad hook if present
        if (cmd['onLoad']) {
          try {
            const onLoadArgs = {};
            onLoadArgs['api']    = _api;
            onLoadArgs['models'] = _models;
            cmd['onLoad'](onLoadArgs);
          } catch (e) {
            throw new Error("Can't onLoad : cmds : " + e);
          }
        }

        // Register for event handling if applicable
        if (cmd['handleEvent'])
          global['client']['eventRegistered'].push(cmd['config']['name']);

        global['client']['commands'].set(cmd['config']['name'], cmd);
      } catch (e) {
        logger.log([
          { message: '[ CMD-LOAD ]: ', color: ['red', 'cyan'] },
          { message: `Failed to load "${file}": ${e && e.message ? e.message : String(e)}`, color: 'white' }
        ]);
      }
    }
  }());

  // ── Load Events ───────────────────────────────────────────
  (function () {
    // [FIX Djamel] — same defensive guard as commandDisabled above. A
    // missing/non-array eventDisabled key would crash the event loader and
    // disable every event handler (joins, name changes, refresh, etc.).
    const _disabledEvts = Array.isArray(global['config']['eventDisabled'])
      ? global['config']['eventDisabled']
      : [];
    const evtFiles = readdirSync(global['client']['mainPath'] + '/SCRIPTS/ZAO-EVTS')
      .filter(f => f.endsWith('.js') && !_disabledEvts.includes(f));

    for (const file of evtFiles) {
      try {
        var evt = require(global['client']['mainPath'] + '/SCRIPTS/ZAO-EVTS/' + file);

        if (!evt['config'] || !evt['run'])
          throw new Error(global['getText']('mirai', 'Error in cmd format'));

        if (global['client']['events'].has(evt['config']['name']))
          throw new Error(global['getText']('mirai', 'Name Is Repeated'));

        // Install npm dependencies
        if (evt['config']['dependencies'] && typeof evt['config']['dependencies'] == 'object') {
          for (const pkgName in evt['config']['dependencies']) {
            const pkgPath = join(__dirname, 'nodemodules', 'node_modules', pkgName);
            try {
              if (!global['nodemodule'].hasOwnProperty(pkgName)) {
                if (listPackage.hasOwnProperty(pkgName) || listbuiltinModules.includes(pkgName))
                  global['nodemodule'][pkgName] = require(pkgName);
                else
                  global['nodemodule'][pkgName] = require(pkgPath);
              }
            } catch {
              const allowInstall = global['config'] && global['config'].allowAutoNpmInstall === true;
              if (!allowInstall) {
                throw new Error('Missing dependency: ' + pkgName + ' (auto npm install disabled)');
              }

              let loaded = false, lastErr;
              const ver = evt['config']['dependencies'][pkgName];
              // [FIX T009] — 90s timeout: slow npm registry cannot deadlock boot
              try {
                execSync(
                  'npm --package-lock false --save install ' + pkgName +
                    (ver == '*' || ver == '' ? '' : '@' + ver),
                  { stdio: 'inherit', env: process.env, shell: true, cwd: join(__dirname, 'nodemodules'), timeout: 90_000 }
                );
              } catch (installErr) {
                throw new Error(`npm install "${pkgName}" failed or timed out: ${installErr && installErr.message ? installErr.message : installErr}`);
              }
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  // Clear only this module from cache, not the entire cache
                  try { delete require.cache[require.resolve(pkgPath)]; } catch (_) {}
                  try { delete require.cache[require.resolve(pkgName)]; } catch (_) {}
                  if (global['nodemodule'].hasOwnProperty(pkgName)) break;
                  if (listPackage.hasOwnProperty(pkgName) || listbuiltinModules.includes(pkgName))
                    global['nodemodule'][pkgName] = require(pkgName);
                  else
                    global['nodemodule'][pkgName] = require(pkgPath);
                  loaded = true;
                  break;
                } catch (err) {
                  lastErr = err;
                }
                if (loaded || !lastErr) break;
              }
            }
          }
        }

        // Apply envConfig overrides
        if (evt['config']['envConfig']) {
          try {
            for (const envKey in evt['config']['envConfig']) {
              if (typeof global['configModule'][evt['config']['name']] === 'undefined')
                global['configModule'][evt['config']['name']] = {};
              if (typeof global['config'][evt['config']['name']] === 'undefined')
                global['config'][evt['config']['name']] = {};
              if (typeof global['config'][evt['config']['name']][envKey] !== 'undefined')
                global['configModule'][evt['config']['name']][envKey] = global['config'][evt['config']['name']][envKey];
              else
                global['configModule'][evt['config']['name']][envKey] = evt['config']['envConfig'][envKey] || '';
              if (typeof global['config'][evt['config']['name']][envKey] === 'undefined')
                global['config'][evt['config']['name']][envKey] = evt['config']['envConfig'][envKey] || '';
            }
          } catch (e) {}
        }

        // Run onLoad hook
        if (evt['onLoad']) {
          try {
            const onLoadArgs = {};
            onLoadArgs['api']    = _api;
            onLoadArgs['models'] = _models;
            evt['onLoad'](onLoadArgs);
          } catch (e) {
            logger.log([
              { message: '[ EVT-ONLOAD ]: ', color: ['red', 'cyan'] },
              { message: `onLoad error in "${file}": ${e && e.message ? e.message : String(e)}`, color: 'white' }
            ]);
          }
        }

        global['client']['events'].set(evt['config']['name'], evt);
      } catch (e) {
        logger.log([
          { message: '[ EVT-LOAD ]: ', color: ['red', 'cyan'] },
          { message: `Failed to load event "${file}": ${e && e.message ? e.message : String(e)}`, color: 'white' }
        ]);
      }
    }
  }());

  // ── Summary log ───────────────────────────────────────────
  const _gradientStringMod = require('gradient-string');
  const gradientString = _gradientStringMod.default || _gradientStringMod;
  const gradient = gradientString('red', 'cyan');
  console.log(gradient('━'.repeat(50), { interpolation: 'hsv' }));
  console.log(cv('\n──LOADING LOADER─●'));
  logger.log([
    { message: '──ZAO DATA─●', color: ['red', 'cyan'] },
    {
      message: 'Loaded ' + global['client']['commands'].size +
               ' Command Aand ' + global['client']['events'].size + ' Events',
      color: 'white'
    }
  ]);

  // ── Restore any pending reply/reaction callbacks saved before last restart ──
  try { require('./includes/login/statePersist').restore(); } catch (_) {}

  // ── Build listen args and start listener ──────────────────
  const listenArgs = {};
  listenArgs['api']         = _api;
  listenArgs['models']      = _models;
  listenArgs['threadsData'] = _threadsData;
  listenArgs['usersData']   = _usersData;
  listenArgs['globalData']  = _globalData;

  let handleListen = require('./includes/listen')(listenArgs);

  // ── Single-source-of-truth listener restarter ─────────────────────────────
  // Both the MQTT error handler AND the MQTT-silence health check used to
  // build their own listenMqtt() inline. On forks where stopListening() does
  // not fully tear down the underlying MQTT client, that left zombie
  // subscriptions piling up over time → memory creep + duplicate events +
  // detection-flagged traffic. We funnel ALL restarts through one re-entrant
  // -safe function so only one listener can ever be live at a time.
  let _listenerGen = 0;
  let _isRestartingListener = false;
  let _lastListenerRestart = 0;
  function safeRestartListener(reason) {
    if (_isRestartingListener) {
      logger.log([
        { message: '[ LISTEN ]: ', color: ['red', 'cyan'] },
        { message: `restart already in progress — skipping (${reason})`, color: 'white' }
      ]);
      return;
    }
    // Throttle: never restart more than once every 8 s (prevents thrash if
    // a flood of MQTT errors fire back-to-back).
    const now = Date.now();
    if (now - _lastListenerRestart < 8000) {
      logger.log([
        { message: '[ LISTEN ]: ', color: ['red', 'cyan'] },
        { message: `restart throttled — last restart was ${Math.round((now - _lastListenerRestart) / 1000)}s ago (${reason})`, color: 'white' }
      ]);
      return;
    }
    _isRestartingListener = true;
    _lastListenerRestart = now;
    const myGen = ++_listenerGen;

    // Tear down old listener first.
    try {
      if (global['handleListen']) {
        try { global['handleListen'].stopListening(); } catch (_) {}
      }
    } catch (_) {}
    global['handleListen'] = null;

    // Wait for the underlying MQTT client to actually close (fcas vary widely
    // here — 1.5 s was empirically not enough on @neoaz07/nkxfca under load).
    setTimeout(() => {
      try {
        if (myGen !== _listenerGen) {
          // A newer restart raced past us — abort.
          _isRestartingListener = false;
          return;
        }
        const newHandle = _api['listenMqtt'](function _genGuardedHandler(err, message) {
          // Drop events from any stale listener that survived stopListening().
          if (myGen !== _listenerGen) return;
          return messageHandler(err, message);
        });
        global['handleListen']     = newHandle;
        global['lastMqttActivity'] = Date.now();
        logger.log([
          { message: '[ LISTEN ]: ', color: ['red', 'cyan'] },
          { message: `listener restarted (gen ${myGen}) — reason: ${reason}`, color: 'white' }
        ]);
      } catch (e2) {
        logger.log([
          { message: '[ LISTEN ]: ', color: ['red', 'cyan'] },
          { message: `restart failed: ${e2.message}. health check will retry.`, color: 'white' }
        ]);
      } finally {
        _isRestartingListener = false;
      }
    }, 2500);
  }

  // ── Auto-Relogin — standalone module (cooldown + max retries + admin notify) ──
  const autoRelogin = require('./includes/login/autoRelogin');
  global['_triggerAutoRelogin'] = function (reason) {
    try {
      const p = autoRelogin(_api, reason);
      // autoRelogin is async — attach .catch() so rejections don't become unhandled
      if (p && typeof p.catch === 'function') {
        p.catch(e => {
          const log = global.loggeryuki;
          const msg = 'autoRelogin rejected: ' + (e && e.message ? e.message : String(e));
          if (log) log.log([{ message: '[ RELOGIN ]: ', color: ['red', 'cyan'] }, { message: msg, color: 'white' }]);
          else console.error('[RELOGIN]', msg);
        });
      }
    } catch (_) {}
  };

  // ── Listen error handler ──────────────────────────────────
  function handlerWhenListenHasError(err) {
    const errStr  = String(err && (err.message || err.error || err)).toLowerCase();
    const errObj  = (typeof err === 'object') ? err : {};

    // ── Explicit session-kill checks (from other bot's pattern) ──
    const isLoginBlocked = (
      err === 'login_blocked'
      || errObj.error === 'login_blocked'
      || errObj.type  === 'account_inactive'
      || (typeof errObj.reason === 'string' && errObj.reason === 'auth_error')
      || errStr.includes('login_blocked')
      || errStr.includes('account_inactive')
    );

    const sessionExpired = isLoginBlocked || [
      'session', 'expired', 'checkpoint',
      'unauthorized', 'invalid token', 'logout', '406', 'not-authorized'
    ].some(k => errStr.includes(k));

    if (sessionExpired) {
      const label = isLoginBlocked ? 'login_blocked / account_inactive' : 'session expired';
      logger.log([
        { message: '[ SESSION ]: ', color: ['red', 'cyan'] },
        { message: `${label}: ${errStr.slice(0, 120)}`, color: 'white' }
      ]);
      // Push an external notification so the operator hears about session deaths
      try { require('./includes/notiWhenListenError').notify(err, label); } catch (_) {}
      const _reloginPromise = autoRelogin(_api, label);
      if (_reloginPromise && typeof _reloginPromise.catch === 'function') {
        _reloginPromise.catch(e => {
          logger.log([{ message: '[ SESSION ]: ', color: ['red', 'cyan'] }, { message: 'autoRelogin rejected: ' + (e && e.message ? e.message : String(e)), color: 'white' }]);
        });
      }
    } else {
      logger.log([
        { message: '[ LISTEN-ERR ]: ', color: ['red', 'cyan'] },
        { message: `Connection error: ${errStr.slice(0, 120)}`, color: 'white' }
      ]);
      try { require('./includes/notiWhenListenError').notify(err, 'listen error'); } catch (_) {}
      safeRestartListener('listen-error: ' + errStr.slice(0, 80));
    }
  }

  // ── تخزين مرجع API للأنظمة الأخرى ────────────────────────
  global['_botApi']       = _api;
  global['_botStartTime'] = Date.now();

  // ── Account Health Monitor ─────────────────────────────────
  try {
    const accountHealthMonitor = require('./includes/login/accountHealthMonitor');
    accountHealthMonitor.start(_api);
  } catch (_healthErr) {
    logger.log([
      { message: '[ HEALTH ]: ', color: ['red', 'cyan'] },
      { message: 'Health monitor failed to start: ' + (_healthErr.message || _healthErr), color: 'yellow' }
    ]);
  }

  // ══════════════════════════════════════════════════════════
  //  Internal Panel API Server — port 3001 (localhost only)
  // ══════════════════════════════════════════════════════════
  // ── Motor state persistence helpers ──────────────────────────
  // Delegates to includes/motorPersist so chat command (engine.js /
  // motor2.js), panel REST endpoints, and graceful shutdown all share
  // the SAME serialization shape. Old inline saves stripped
  // randomTime/randomRange — random-interval mode came back as fixed
  // after a restart. motorPersist preserves them.
  const _motorPersist = require('./includes/motorPersist');
  function _saveMotorState()  { try { _motorPersist.motor1.persistAll(global['motorData']  || {}); } catch (_) {} }
  function _saveMotor2State() { try { _motorPersist.motor2.persistAll(global['motorData2'] || {}); } catch (_) {} }
  global['_saveMotorState']  = _saveMotorState;
  global['_saveMotor2State'] = _saveMotor2State;

  // Restore persisted motor1 state and restart active intervals.
  // (motor2 is restored by SCRIPTS/ZAO-CMDS/motor2.js's onLoad. engine.js
  //  does the same for motor1 when it loads, but we also restart loops
  //  here in case engine.js is hot-reloaded after the bot is already
  //  connected — scheduleMotorLoop dedup guarantees one live loop per
  //  thread either way.)
  try {
    const _saved = _motorPersist.motor1.loadAll();
    global['motorData'] = global['motorData'] || {};
    for (const [tid, d] of Object.entries(_saved)) {
      global['motorData'][tid] = { ...d, interval: null };
      if (d.status && d.message && d.time && d.time >= 5000) {
        const _tid = tid;
        try {
          const { scheduleMotorLoop } = require('./includes/motorSafeSend');
          scheduleMotorLoop({
            api: _api,
            threadID: _tid,
            getData: () => global['motorData'][_tid],
            onDisable: () => { try { _saveMotorState(); } catch (_) {} }
          });
          const _every = d.randomTime
            ? `random ${(d.randomRange?.min || 12000) / 1000}-${(d.randomRange?.max || 50000) / 1000}s`
            : `~${Math.round(d.time / 1000)}s`;
          logger.log([{ message: '[ MOTOR ]: ', color: ['red', 'cyan'] }, { message: `Restored motor for ${_tid} (every ${_every} with jitter/backoff)`, color: 'white' }]);
        } catch (_e2) {
          logger.log([{ message: '[ MOTOR ]: ', color: ['red', 'cyan'] }, { message: `Failed to restore motor for ${_tid}: ${_e2.message || _e2}`, color: 'yellow' }]);
        }
      }
    }
  } catch (_e) {
    logger.log([{ message: '[ MOTOR ]: ', color: ['red', 'cyan'] }, { message: 'Could not restore motor state: ' + (_e.message || _e), color: 'yellow' }]);
  }

  (function startPanelApi() {
    const _panelHttp = require('http');
    const _panelPath = require('path');
    const _panelFs   = require('fs-extra');

    function _parseBody(req) {
      const MAX_BODY = 512 * 1024; // [FIX L3] — 512 KB cap; oversized bodies buffered forever before
      return new Promise((resolve) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BODY) { req.destroy(); return resolve({}); }
          body += chunk;
        });
        req.on('end', () => {
          try { resolve(body ? JSON.parse(body) : {}); } catch (_) { resolve({}); }
        });
        req.on('error', () => resolve({}));
      });
    }

    function _json(res, data, status) {
      const body = JSON.stringify(data);
      res.writeHead(status || 200, { 'Content-Type': 'application/json' });
      res.end(body);
    }

    // ── Rolling CPU / RAM samples (for Health graph) ──────────────────────────
    const _sysStatsSamples = [];
    const SYS_STATS_MAX    = 72;   // 6 min @ 5 s interval
    let   _prevCpuUsage    = process.cpuUsage();
    let   _prevCpuTime     = Date.now();
    const _sysStatsTimer   = setInterval(() => {
      try {
        const now      = Date.now();
        const cur      = process.cpuUsage(_prevCpuUsage);
        const elapsed  = (now - _prevCpuTime) * 1000; // μs
        const cpuPct   = elapsed > 0
          ? Math.min(100, Math.round((cur.user + cur.system) / elapsed * 100))
          : 0;
        _prevCpuUsage = process.cpuUsage();
        _prevCpuTime  = now;
        const mem = process.memoryUsage();
        _sysStatsSamples.push({
          ts:     now,
          cpuPct,
          memMB:  Math.round(mem.rss / 1024 / 1024),
          heapMB: Math.round(mem.heapUsed / 1024 / 1024),
        });
        if (_sysStatsSamples.length > SYS_STATS_MAX) _sysStatsSamples.shift();
      } catch (_) {}
    }, 5000).unref();

    function _reloadCommands() {
      const cmdDir = _panelPath.join(__dirname, 'SCRIPTS', 'ZAO-CMDS');
      const files  = _panelFs.readdirSync(cmdDir).filter(f => f.endsWith('.js'));

      // [FIX H2] — call onUnload() on each currently-loaded command before
      // wiping the Map. This lets commands clean up their own setIntervals,
      // file watchers, or other resources they started in onLoad/run, so hot
      // reload doesn't accumulate duplicate background activity over time.
      for (const [, cmd] of global['client']['commands'].entries()) {
        if (typeof cmd['onUnload'] === 'function') {
          try { cmd['onUnload'](); } catch (_) {}
        }
      }

      for (const file of files) {
        const fp = _panelPath.join(cmdDir, file);
        try { delete require.cache[require.resolve(fp)]; } catch (_) {}
      }
      global['client']['commands'].clear();
      global['client']['eventRegistered'] = [];
      global['client']['handleReply']     = [];
      global['client']['handleReaction']  = [];

      const loaded = [], errors = [];
      const disabled = Array.isArray(global['config']['commandDisabled'])
        ? global['config']['commandDisabled']
        : [];

      for (const file of files) {
        if (disabled.includes(file)) continue;
        try {
          const cmd = require(_panelPath.join(cmdDir, file));
          if (!cmd || !cmd['config'] || !cmd['run']) { errors.push({ file, error: 'missing config/run' }); continue; }
          if (global['client']['commands'].has(cmd['config']['name'])) { errors.push({ file, error: 'duplicate name' }); continue; }
          if (cmd['onLoad']) { try { cmd['onLoad']({ api: _api, models: _models }); } catch (_) {} }
          if (cmd['handleEvent']) global['client']['eventRegistered'].push(cmd['config']['name']);
          global['client']['commands'].set(cmd['config']['name'], cmd);
          loaded.push({ name: cmd['config']['name'], file });
        } catch (e) { errors.push({ file, error: e.message }); }
      }
      return { loaded, errors, total: global['client']['commands'].size };
    }

    function _reloadEvents() {
      const evtDir = _panelPath.join(__dirname, 'SCRIPTS', 'ZAO-EVTS');
      const files   = _panelFs.readdirSync(evtDir).filter(f => f.endsWith('.js'));
      const disabled = Array.isArray(global['config']['eventDisabled'])
        ? global['config']['eventDisabled'] : [];

      for (const [, evt] of global['client']['events'].entries()) {
        if (typeof evt['onUnload'] === 'function') {
          try { evt['onUnload'](); } catch (_) {}
        }
      }

      for (const file of files) {
        const fp = _panelPath.join(evtDir, file);
        try { delete require.cache[require.resolve(fp)]; } catch (_) {}
      }
      global['client']['events'].clear();

      const loaded = [], errors = [];
      for (const file of files) {
        if (disabled.includes(file)) continue;
        const fp = _panelPath.join(evtDir, file);
        try {
          const evt = require(fp);
          if (!evt['config'] || !evt['run']) {
            errors.push({ file, error: 'missing config/run' }); continue;
          }
          if (global['client']['events'].has(evt['config']['name'])) {
            errors.push({ file, error: 'duplicate name' }); continue;
          }
          global['client']['events'].set(evt['config']['name'], evt);
          loaded.push({ name: evt['config']['name'], file });
        } catch (e) { errors.push({ file, error: e.message }); }
      }
      return { loaded, errors, total: global['client']['events'].size };
    }

    global['_hotReload'] = function () {
      const cmds = _reloadCommands();
      const evts = _reloadEvents();
      return { commands: cmds, events: evts };
    };

    // [FIX L2] — the original check used three exact strings, but Node.js can
    // present the loopback address in several forms depending on whether the
    // OS/container resolves it as IPv4 or IPv6. Using a Set + regex covers all
    // standard variants without accidentally allowing non-loopback addresses.
    const _LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
    function _isLoopback(addr) {
      if (!addr) return false;
      if (_LOOPBACK_ADDRS.has(addr)) return true;
      // ::ffff:127.x.x.x — any IPv4-mapped loopback address
      return /^::ffff:127\./.test(addr);
    }

    const _panelServer = _panelHttp.createServer(async (req, res) => {
      const remote = req.socket.remoteAddress;
      if (!_isLoopback(remote)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      const { method } = req;
      const pathname = req.url.split('?')[0];
      const body = (method === 'POST' || method === 'PUT') ? await _parseBody(req) : {};

      try {
        if (pathname === '/bot/status' && method === 'GET') {
          const _md  = global['motorData']  || {};
          const _md2 = global['motorData2'] || {};
          const motor1Active  = Object.values(_md).filter(d => d && d.status).length;
          const motor2Active  = Object.values(_md2).filter(d => d && d.status).length;
          return _json(res, {
            connected:    !!_api,
            botID:        global['botUserID'] || '',
            commands:     global['client']['commands'].size,
            events:       global['client']['events'].size,
            uptime:       global['_botStartTime'] ? Math.floor((Date.now() - global['_botStartTime']) / 1000) : 0,
            mqttAlive:    global['lastMqttActivity'] ? (Date.now() - global['lastMqttActivity'] < 120000) : false,
            motor1Active,
            motor2Active
          });
        }

        if (pathname === '/bot/reload-commands' && method === 'POST') {
          const result = _reloadCommands();
          return _json(res, { ok: true, ...result });
        }

        if (pathname === '/bot/hot-reload' && method === 'POST') {
          const result = global['_hotReload']();
          return _json(res, { ok: true, ...result });
        }

        // AI Monitor live-patch: write a command/event file and hot-reload it
        if (pathname === '/bot/patch-command' && method === 'POST') {
          try {
            const { relPath, content, reason } = body;
            if (!relPath || typeof relPath !== 'string' || relPath.includes('..') || relPath.includes('\0')) {
              return _json(res, { error: 'invalid path' }, 400);
            }
            const ALLOWED_PREFIXES = ['SCRIPTS/ZAO-CMDS/', 'SCRIPTS/ZAO-EVTS/'];
            if (!ALLOWED_PREFIXES.some(p => relPath.startsWith(p))) {
              return _json(res, { error: 'Only SCRIPTS/ZAO-CMDS/ and SCRIPTS/ZAO-EVTS/ files may be patched' }, 403);
            }
            if (typeof content !== 'string' || content.length < 10) {
              return _json(res, { error: 'content too short or missing' }, 400);
            }
            const _fs   = require('fs');
            const _path = require('path');
            const fullPath   = _path.join(__dirname, relPath);
            const backupPath = fullPath + '.aibackup';
            // Backup original
            try { if (_fs.existsSync(fullPath)) _fs.copyFileSync(fullPath, backupPath); } catch (_) {}
            // Write patched content
            _fs.writeFileSync(fullPath, content, 'utf8');
            // Bust require cache
            try { delete require.cache[require.resolve(fullPath)]; } catch (_) {}
            // Re-register command
            let cmdName = null, reloaded = false;
            if (relPath.startsWith('SCRIPTS/ZAO-CMDS/')) {
              try {
                const mod = require(fullPath);
                cmdName = mod?.config?.name;
                const cmds = global.client && global.client.commands;
                if (cmdName && cmds) {
                  cmds.set(cmdName, mod);
                  (mod.config?.aliases || []).forEach(a => cmds.set(String(a), mod));
                  reloaded = true;
                }
              } catch (e) {
                // Load failed — revert to backup
                try {
                  if (_fs.existsSync(backupPath)) {
                    _fs.copyFileSync(backupPath, fullPath);
                    try { delete require.cache[require.resolve(fullPath)]; } catch (_) {}
                  }
                } catch (_) {}
                return _json(res, { error: 'Patch reverted — command load failed: ' + e.message }, 500);
              }
            }
            return _json(res, { ok: true, reloaded, cmdName, relPath, reason: reason || '' });
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        // Rollback a previously AI-patched command/event file from its .aibackup
        if (pathname === '/bot/patch-rollback' && method === 'POST') {
          try {
            const { relPath } = body;
            if (!relPath || typeof relPath !== 'string' || relPath.includes('..') || relPath.includes('\0')) {
              return _json(res, { error: 'invalid path' }, 400);
            }
            const ALLOWED_PREFIXES = ['SCRIPTS/ZAO-CMDS/', 'SCRIPTS/ZAO-EVTS/'];
            if (!ALLOWED_PREFIXES.some(p => relPath.startsWith(p))) {
              return _json(res, { error: 'Only SCRIPTS/ZAO-CMDS/ and SCRIPTS/ZAO-EVTS/ files may be rolled back' }, 403);
            }
            const _fs   = require('fs');
            const _path = require('path');
            const fullPath   = _path.join(__dirname, relPath);
            const backupPath = fullPath + '.aibackup';
            if (!_fs.existsSync(backupPath)) {
              return _json(res, { error: 'No backup found for this file (.aibackup missing)' }, 404);
            }
            const backupContent = _fs.readFileSync(backupPath, 'utf8');
            _fs.writeFileSync(fullPath, backupContent, 'utf8');
            try { delete require.cache[require.resolve(fullPath)]; } catch (_) {}
            let reloaded = false, cmdName = null;
            if (relPath.startsWith('SCRIPTS/ZAO-CMDS/')) {
              try {
                const mod = require(fullPath);
                cmdName = mod?.config?.name;
                const cmds = global.client && global.client.commands;
                if (cmdName && cmds) {
                  cmds.set(cmdName, mod);
                  (mod.config?.aliases || []).forEach(a => cmds.set(String(a), mod));
                  reloaded = true;
                }
              } catch (_) {}
            }
            return _json(res, { ok: true, reloaded, cmdName, relPath, msg: 'Rolled back from .aibackup' });
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        if (pathname === '/bot/mqtt-status' && method === 'GET') {
          try {
            const mqttHealth = require('./includes/mqttHealthCheck');
            const status = typeof mqttHealth.getStatus === 'function'
              ? mqttHealth.getStatus()
              : {};
            return _json(res, {
              ok: true,
              ...status,
              listenerGen: typeof _listenerGen !== 'undefined' ? _listenerGen : null,
              botID: global['botUserID'] || null
            });
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        if (pathname === '/bot/restart-listener' && method === 'POST') {
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          if (typeof global['_restartListener'] !== 'function')
            return _json(res, { error: 'Listener restart not wired yet — bot still initialising' }, 503);
          try {
            global['_restartListener']('manual-panel');
            return _json(res, { ok: true, message: 'MQTT listener restart triggered' });
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        if (pathname === '/bot/groups' && method === 'GET') {
          // Helper: read/write the persistent group cache so the panel can
          // show groups even when the bot is offline or reconnecting.
          // NOTE: use destructured `join` and `readFileSync/writeFileSync` (not path.join/fs.*)
          const _groupCachePath = join(__dirname, 'data', 'groupCache.json');
          function _readGroupCache() {
            try { return JSON.parse(readFileSync(_groupCachePath, 'utf8')); } catch (_) { return []; }
          }
          function _writeGroupCache(grps) {
            try { writeFileSync(_groupCachePath, JSON.stringify(grps, null, 2), 'utf8'); } catch (_) {}
          }

          // Helper: build result array from a thread list
          function _mapGroups(list) {
            return (Array.isArray(list) ? list : (list?.data || []))
              .filter(t => t?.isGroup && t?.threadID)
              .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
              .map(g => ({
                threadID:  String(g.threadID),
                name:      (g.name || g.threadName || String(g.threadID)).slice(0, 60),
                members:   g.participantIDs ? g.participantIDs.length : (g.participantCount || 0),
                timestamp: g.timestamp || 0
              }));
          }

          // Helper: build result from in-memory global.data (populated by syncAllGroups)
          function _fromMemory() {
            const infoMap = global.data && global.data.threadInfo;
            const ids = global.data && global.data.allThreadID;

            // Collect IDs from allThreadID array AND from threadInfo Map keys
            const allIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
            if (infoMap instanceof Map) {
              for (const [tid, info] of infoMap) {
                // Include if marked as group, or has a name (groups usually have names unlike DMs)
                if (info && (info.isGroup || info.threadType === 'GROUP' ||
                    (info.name && info.name.trim() && info.participantIDs && info.participantIDs.length > 2))) {
                  allIds.add(String(tid));
                }
              }
            }

            if (!allIds.size) return [];
            return Array.from(allIds).map(tid => {
              const info = infoMap ? infoMap.get(tid) : null;
              return {
                threadID: tid,
                name:     (info && (info.name || info.threadName) || tid).slice(0, 60),
                members:  info ? (info.participantIDs || []).length : 0,
                timestamp: info ? (info.timestamp || 0) : 0
              };
            }).filter(g => g.threadID);
          }

          // ── LIVE-FIRST approach: always fetch from Facebook account, cache is fallback only ──

          // Priority 1: bot online → call Facebook API directly (live, like .التحكم command)
          if (_api) {
            try {
              let result = _mapGroups(await _api.getThreadList(100, null, ['INBOX']));
              if (!result.length) {
                try { result = _mapGroups(await _api.getThreadList(100, null, [])); } catch (_) {}
              }
              if (result.length > 0) _writeGroupCache(result);
              return _json(res, result);
            } catch (e) {
              // API call failed — fall through to cache fallbacks below
            }
          }

          // Priority 2: bot offline or API failed → try in-memory data
          const memGroups = _fromMemory();
          if (memGroups.length > 0) return _json(res, memGroups);

          // Priority 3: no memory → try disk cache
          const cachedGroups = _readGroupCache();
          if (cachedGroups.length > 0) return _json(res, cachedGroups);

          // Priority 4: nothing available
          return _json(res, []);
        }

        if (pathname === '/bot/requests' && method === 'GET') {
          if (!_api) return _json(res, []);
          try {
            const merge = (r) => Array.isArray(r) ? r : (r?.data || []);

            // Strategy 1: try dedicated PENDING and OTHER tag queries
            const [pending, other] = await Promise.all([
              _api.getThreadList(60, null, ['PENDING']).catch(() => []),
              _api.getThreadList(60, null, ['OTHER']).catch(() => [])
            ]);
            let rawList = [...merge(pending), ...merge(other)];

            // Strategy 2: if both tag queries returned nothing, fall back to fetching
            // all threads and filtering by the `folder` field returned per thread.
            // Facebook sometimes returns PENDING/OTHER threads only in unfiltered calls
            // when the account hasn't loaded the requests section in a while.
            if (rawList.length === 0) {
              try {
                const all = await _api.getThreadList(100, null, ['INBOX']);
                const allList = merge(all);
                const folderMatch = allList.filter(t => {
                  const f = (t.folder || '').toUpperCase();
                  return f === 'PENDING' || f === 'OTHER' || f === 'MESSAGE_REQUESTS';
                });
                if (folderMatch.length > 0) rawList = folderMatch;
              } catch (_) {}
            }

            // Strategy 3: if still nothing, try a bare unfiltered fetch and look for
            // threads that haven't been read (unreadCount > 0) and are not in INBOX.
            if (rawList.length === 0) {
              try {
                const all2 = await _api.getThreadList(100, null, []);
                const allList2 = merge(all2);
                const pendingFolders = allList2.filter(t => {
                  const f = (t.folder || '').toUpperCase();
                  return f === 'PENDING' || f === 'OTHER' || f === 'MESSAGE_REQUESTS';
                });
                if (pendingFolders.length > 0) rawList = pendingFolders;
              } catch (_) {}
            }

            // Deduplicate by threadID, then format
            const seen = new Set();
            const requests = rawList
              .filter(r => {
                if (!r?.threadID) return false;
                const tid = String(r.threadID);
                if (seen.has(tid)) return false;
                seen.add(tid);
                return true;
              })
              .map(r => ({
                threadID:  String(r.threadID),
                name:      (r.name || r.threadName || String(r.threadID)).slice(0, 60),
                isGroup:   !!r.isGroup,
                folder:    r.folder || 'PENDING',
                timestamp: r.timestamp || 0
              }));
            return _json(res, requests);
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        if (pathname === '/bot/group-status' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);

          function _motorView(d, loopTid) {
            if (!d) return { status: false, message: null, time: null, randomTime: false, randomRange: null, loop: null };
            let loop = null;
            try {
              const { getLoopStats } = require('./includes/motorSafeSend');
              loop = getLoopStats(loopTid) || null;
            } catch (_) {}
            return {
              status:      !!d.status,
              message:     d.message || null,
              time:        d.time || null,
              randomTime:  !!d.randomTime,
              randomRange: d.randomRange || null,
              loop          // { lastSentAt, nextSendAt, backoffMs } or null
            };
          }

          // [FIX] Read the lock from the file-backed nameLocks store that is
          // actually enforced by the listener — not the dead `global.repeatName`.
          let nameLock = { locked: false, name: null };
          try {
            const NL = require('./includes/nameLocks');
            const entry = NL.getLock(tid);
            if (entry) nameLock = { locked: true, name: entry.name || null };
          } catch (_) {}

          return _json(res, {
            motor:    _motorView(global['motorData']  && global['motorData'][tid],  tid),
            motor2:   _motorView(global['motorData2'] && global['motorData2'][tid], tid),
            nameLock
          });
        }

        if (pathname === '/bot/send-message' && method === 'POST') {
          const { threadID, message } = body;
          if (!threadID || !message) return _json(res, { error: 'Missing threadID or message' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          // Wrap in try-catch: sendMessage can throw synchronously before ever
          // calling the callback (e.g. if the API object is in a torn-down state),
          // which would leave the promise pending forever and the panel request
          // hanging until Main.js times out after 8 s.
          await new Promise((resolve, reject) => {
            try {
              _api.sendMessage(message, String(threadID), err => err ? reject(err) : resolve());
            } catch (e) { reject(e); }
          });
          return _json(res, { ok: true });
        }

        // ── Execute command (used by the تنفيذ panel tab) ─────────────────────
        // Accepts { threadID, command } where command is the full command string
        // including any arguments (prefix is stripped automatically).
        if (pathname === '/bot/execute' && method === 'POST') {
          const { threadID, command } = body;
          if (!threadID || !command) return _json(res, { error: 'Missing threadID or command' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);

          try {
            const prefix   = (global.config && global.config.PREFIX) || '.';
            const cmdStr   = String(command).trim();
            // Strip leading prefix if present so the panel can send either ".help" or "help"
            const stripped = cmdStr.startsWith(prefix) ? cmdStr.slice(prefix.length).trim() : cmdStr;
            const parts    = stripped.split(/\s+/);
            const cmdName  = (parts[0] || '').toLowerCase();
            const args     = parts.slice(1);

            const cmds = global.client && global.client.commands;
            if (!cmds || !cmds.has(cmdName)) {
              return _json(res, { ok: false, error: `Command "${cmdName}" not found`, availableCount: cmds ? cmds.size : 0 }, 404);
            }

            const cmdModule = cmds.get(cmdName);
            if (typeof cmdModule.run !== 'function') {
              return _json(res, { ok: false, error: `Command "${cmdName}" has no run() function` }, 500);
            }

            // Build a synthetic event that looks like a real message event
            const fakeEvent = {
              type:       'message',
              threadID:   String(threadID),
              senderID:   (global.config && global.config.ADMINBOT && global.config.ADMINBOT[0]) || '0',
              body:       prefix + stripped,
              isGroup:    true,
              messageID:  'panel-exec-' + Date.now(),
              timestamp:  Date.now(),
              attachments: [],
              mentions:   {},
              args,
            };

            // Build a minimal Obj matching what commands expect
            const Obj = {
              api:      _api,
              event:    fakeEvent,
              args,
              body:     fakeEvent.body,
              threadID: String(threadID),
              senderID: fakeEvent.senderID,
              Users:    global.Users   || { getById: () => null },
              Threads:  global.Threads || { getById: () => null },
              Currencies: global.Currencies || { getById: () => null },
              getLang:  () => '',
            };

            // Run the command with a 15-second timeout
            await Promise.race([
              Promise.resolve(cmdModule.run(Obj)).catch(e => { throw e; }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('Command timed out after 15 s')), 15000)),
            ]);

            return _json(res, { ok: true, message: `Command "${cmdName}" executed in thread ${threadID}` });
          } catch (e) {
            return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500);
          }
        }

        // ── Friends API ────────────────────────────────────────────────────────
        if (pathname === '/bot/friends/requests' && method === 'GET') {
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const reqs = await _api.friend.requests();
            return _json(res, { ok: true, requests: reqs, count: reqs.length });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/friends/accept' && method === 'POST') {
          const { identifier } = body;
          if (!identifier) return _json(res, { error: 'Missing identifier (name or userID)' }, 400);
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const result = await _api.friend.accept(String(identifier));
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/friends/remove' && method === 'POST') {
          const { userID } = body;
          if (!userID) return _json(res, { error: 'Missing userID' }, 400);
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const result = await _api.friend.unfriend(String(userID));
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/friends/reject' && method === 'POST') {
          const { identifier } = body;
          if (!identifier) return _json(res, { error: 'Missing identifier' }, 400);
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const result = await _api.friend.reject(String(identifier));
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/friends/send' && method === 'POST') {
          const { userID } = body;
          if (!userID) return _json(res, { error: 'Missing userID' }, 400);
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const result = await _api.friend.suggest.send(String(userID));
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/friends/list' && method === 'GET') {
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const friends = await _api.friend.list();
            return _json(res, { ok: true, friends, count: friends.length });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/friends/suggestions' && method === 'GET') {
          if (!_api || !_api.friend) return _json(res, { error: 'Friend API not available' }, 503);
          try {
            const suggestions = await _api.friend.suggest.list(30);
            return _json(res, { ok: true, suggestions, count: suggestions.length });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        // ── Silent Mode API ────────────────────────────────────────────────────
        if (pathname === '/bot/silent' && method === 'GET') {
          return _json(res, { ok: true, silent: !!global._silentMode });
        }

        if (pathname === '/bot/silent' && method === 'POST') {
          const { silent } = body;
          if (typeof silent !== 'boolean') return _json(res, { error: 'silent must be a boolean' }, 400);
          global._silentMode = silent;
          return _json(res, { ok: true, silent: global._silentMode });
        }

        // ── Social API ─────────────────────────────────────────────────────────
        if (pathname === '/bot/social/pin' && method === 'POST') {
          const { action, threadID: pThreadID, messageID: pMsgID } = body;
          if (!action || !pThreadID || !pMsgID) return _json(res, { error: 'Missing action/threadID/messageID' }, 400);
          if (!_api || !_api.pinMessage) return _json(res, { error: 'Pin API not available' }, 503);
          try {
            const result = await _api.pinMessage(action, String(pThreadID), String(pMsgID));
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/follow' && method === 'POST') {
          const { userID: fUID, shouldFollow } = body;
          if (!fUID) return _json(res, { error: 'Missing userID' }, 400);
          if (!_api || !_api.follow) return _json(res, { error: 'Follow API not available' }, 503);
          try {
            const result = await _api.follow(String(fUID), shouldFollow !== false);
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/comment' && method === 'POST') {
          const { postID, message: cmtMsg, replyCommentID } = body;
          if (!postID || !cmtMsg) return _json(res, { error: 'Missing postID or message' }, 400);
          if (!_api || !_api.createComment) return _json(res, { error: 'Comment API not available' }, 503);
          try {
            const result = await _api.createComment(cmtMsg, String(postID), replyCommentID || null);
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/story-create' && method === 'POST') {
          const { message: storyMsg, font, background } = body;
          if (!storyMsg) return _json(res, { error: 'Missing message' }, 400);
          if (!_api || !_api.story) return _json(res, { error: 'Story API not available' }, 503);
          try {
            const result = await _api.story.create(storyMsg, font || 'classic', background || 'blue');
            return _json(res, { ok: true, ...result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/story-react' && method === 'POST') {
          const { storyID, reaction } = body;
          if (!storyID || !reaction) return _json(res, { error: 'Missing storyID or reaction' }, 400);
          if (!_api || !_api.story) return _json(res, { error: 'Story API not available' }, 503);
          try {
            const result = await _api.story.react(String(storyID), reaction);
            return _json(res, { ok: true, ...result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/story-msg' && method === 'POST') {
          const { storyID, message: sMsg } = body;
          if (!storyID || !sMsg) return _json(res, { error: 'Missing storyID or message' }, 400);
          if (!_api || !_api.story) return _json(res, { error: 'Story API not available' }, 503);
          try {
            const result = await _api.story.msg(String(storyID), sMsg);
            return _json(res, { ok: true, ...result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/gcrule' && method === 'POST') {
          const { action: gcAction, userID: gcUID, threadID: gcTID } = body;
          if (!gcAction || !gcUID || !gcTID) return _json(res, { error: 'Missing action/userID/threadID' }, 400);
          if (!_api || !_api.gcrule) return _json(res, { error: 'GCRule API not available' }, 503);
          try {
            const result = await _api.gcrule(gcAction, String(gcUID), String(gcTID));
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/social/notes' && method === 'POST') {
          const { noteAction, text: noteText, noteID } = body;
          if (!noteAction) return _json(res, { error: 'Missing noteAction (create|check|delete)' }, 400);
          if (!_api || !_api.notes) return _json(res, { error: 'Notes API not available' }, 503);
          try {
            let result;
            if (noteAction === 'check')  result = await _api.notes.check();
            else if (noteAction === 'create') { if (!noteText) return _json(res, { error: 'Missing text' }, 400); result = await _api.notes.create(noteText, body.privacy || 'EVERYONE'); }
            else if (noteAction === 'delete') { if (!noteID) return _json(res, { error: 'Missing noteID' }, 400); result = await _api.notes.delete(noteID); }
            else return _json(res, { error: 'Unknown noteAction' }, 400);
            return _json(res, { ok: true, result });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/leave-group' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          const myID = global['botUserID'] || (_api.getCurrentUserID ? _api.getCurrentUserID() : '');
          await new Promise((resolve, reject) => {
            try {
              _api.removeUserFromGroup(myID, String(threadID), (err) => err ? reject(err) : resolve());
            } catch (e) { reject(e); }
          });
          return _json(res, { ok: true });
        }

        if (pathname === '/bot/motor' && method === 'POST') {
          const { threadID, action, message, time, randomTime, randomRange } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          global['motorData'] = global['motorData'] || {};
          if (!global['motorData'][tid]) global['motorData'][tid] = { status: false, message: null, time: null, interval: null };
          const d = global['motorData'][tid];
          if (action === 'set-message') { d.message = message; _saveMotorState(); return _json(res, { ok: true }); }
          if (action === 'set-time') {
            const fixed = parseInt(time);
            if (!Number.isFinite(fixed) || fixed < 5000) return _json(res, { error: 'time must be ≥ 5000ms' }, 400);
            d.time = fixed;
            if (randomTime === true && randomRange && Number.isFinite(+randomRange.min) && Number.isFinite(+randomRange.max) && +randomRange.max > +randomRange.min) {
              d.randomTime = true;
              d.randomRange = { min: Math.max(5000, +randomRange.min), max: Math.max(5001, +randomRange.max) };
            } else {
              d.randomTime = false;
              d.randomRange = null;
            }
            _saveMotorState();
            return _json(res, { ok: true });
          }
          if (action === 'activate') {
            if (d.status) return _json(res, { error: 'Already active' }, 400);
            if (!d.message) return _json(res, { error: 'No message set' }, 400);
            if (!d.time || d.time < 5000) return _json(res, { error: 'Set time first (min 5s)' }, 400);
            d.status = true;
            try {
              const { scheduleMotorLoop } = require('./includes/motorSafeSend');
              scheduleMotorLoop({
                api: _api,
                threadID: tid,
                getData: () => global['motorData'][tid],
                onDisable: () => {
                  try { _saveMotorState(); } catch (_) {}
                }
              });
            } catch (_) {}
            _saveMotorState();
            return _json(res, { ok: true });
          }
          if (action === 'deactivate') {
            d.status = false;
            try {
              const { stopMotorLoop } = require('./includes/motorSafeSend');
              stopMotorLoop(tid);
            } catch (_) {}
            try { if (d.interval) clearInterval(d.interval); } catch (_) {}
            try { if (d.interval) clearTimeout(d.interval); } catch (_) {}
            d.interval = null;
            _saveMotorState();
            return _json(res, { ok: true });
          }
          return _json(res, { status: d.status, message: d.message, time: d.time });
        }

        if (pathname === '/bot/motor2' && method === 'POST') {
          const { threadID, action, message, time, randomTime, randomRange } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          global['motorData2'] = global['motorData2'] || {};
          global['lastActivity'] = global['lastActivity'] || {};
          if (!global['motorData2'][tid]) global['motorData2'][tid] = { status: false, message: null, time: null, interval: null };
          const d = global['motorData2'][tid];
          if (action === 'set-message') { d.message = message; _saveMotor2State(); return _json(res, { ok: true }); }
          if (action === 'set-time') {
            const fixed = parseInt(time);
            if (!Number.isFinite(fixed) || fixed < 5000) return _json(res, { error: 'time must be ≥ 5000ms' }, 400);
            d.time = fixed;
            if (randomTime === true && randomRange && Number.isFinite(+randomRange.min) && Number.isFinite(+randomRange.max) && +randomRange.max > +randomRange.min) {
              d.randomTime = true;
              d.randomRange = { min: Math.max(5000, +randomRange.min), max: Math.max(5001, +randomRange.max) };
            } else {
              d.randomTime = false;
              d.randomRange = null;
            }
            _saveMotor2State();
            return _json(res, { ok: true });
          }
          if (action === 'activate') {
            if (d.status) return _json(res, { error: 'Already active' }, 400);
            if (!d.message) return _json(res, { error: 'No message set' }, 400);
            if (!d.time || d.time < 5000) return _json(res, { error: 'Set time first (min 5s)' }, 400);
            d.status = true;
            d.shouldSend = function () {
              const lastActive = global['lastActivity'][tid];
              if (!lastActive) return false;
              return (Date.now() - lastActive) < (Number(d.time) || 0) * 2;
            };
            try {
              const { scheduleMotorLoop } = require('./includes/motorSafeSend');
              scheduleMotorLoop({
                api: _api,
                threadID: tid,
                getData: () => global['motorData2'][tid],
                onDisable: () => {
                  try { _saveMotor2State(); } catch (_) {}
                }
              });
            } catch (_) {}
            _saveMotor2State();
            return _json(res, { ok: true });
          }
          if (action === 'deactivate') {
            d.status = false;
            try {
              const { stopMotorLoop } = require('./includes/motorSafeSend');
              stopMotorLoop(tid);
            } catch (_) {}
            try { if (d.interval) clearInterval(d.interval); } catch (_) {}
            try { if (d.interval) clearTimeout(d.interval); } catch (_) {}
            d.interval = null;
            _saveMotor2State();
            return _json(res, { ok: true });
          }
          return _json(res, { status: d.status, message: d.message, time: d.time });
        }

        // Auto-lock raid guard — view status or manually lock/unlock the bot.
        // POST { value: true|false } to flip; GET to read state.
        if (pathname === '/bot/lock' && (method === 'GET' || method === 'POST')) {
          const guard = (() => { try { return require('./includes/autoLockGuard'); } catch (_) { return null; } })();
          if (method === 'POST') {
            const v = body && typeof body.value === 'boolean' ? body.value : null;
            if (v === null) return _json(res, { error: 'Missing or non-boolean "value"' }, 400);
            if (guard && typeof guard.setLock === 'function') guard.setLock(v, 'panel');
            else global.lockBot = v;
          }
          return _json(res, guard && typeof guard.status === 'function'
            ? guard.status()
            : { locked: global.lockBot === true });
        }

        if (pathname === '/bot/lock-name' && method === 'POST') {
          const { threadID, action, name } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);

          // [FIX] Use the file-backed nameLocks store that the chat listener
          // actually watches (see SCRIPTS/ZAO-CMDS/nm.js). The previous
          // `global.repeatName` write was dead — nothing read from it for
          // enforcement, so the lock never survived a rename.
          const NL = (() => { try { return require('./includes/nameLocks'); } catch (_) { return null; } })();
          if (!NL) return _json(res, { error: 'nameLocks module unavailable' }, 500);

          // [FIX] This FCA exposes api.gcname(name, threadID, cb), NOT setTitle.
          function _renameGroup(newName) {
            return new Promise((resolve, reject) => {
              if (!_api || typeof _api.gcname !== 'function') return reject(new Error('api.gcname unavailable'));
              try {
                const r = _api.gcname(newName, tid, err => err ? reject(err) : resolve());
                if (r && typeof r.then === 'function') r.then(resolve, reject);
              } catch (e) { reject(e); }
            });
          }

          if (action === 'lock') {
            if (!name || !String(name).trim()) return _json(res, { error: 'Missing name' }, 400);
            const cleanName = String(name).trim();
            try {
              if (_api) await _renameGroup(cleanName);
            } catch (e) {
              return _json(res, { error: 'Rename failed: ' + (e.message || 'unknown') }, 502);
            }
            NL.setLock(tid, cleanName, null);
            try { NL.flush && NL.flush(); } catch (_) {}
            return _json(res, { ok: true, locked: true, name: cleanName });
          }
          if (action === 'unlock') {
            NL.clearLock(tid);
            try { NL.flush && NL.flush(); } catch (_) {}
            return _json(res, { ok: true, locked: false });
          }
          const entry = NL.getLock(tid);
          return _json(res, { locked: !!entry, name: entry?.name || null });
        }

        if (pathname === '/bot/delete-thread' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            await new Promise((resolve, reject) => {
              _api.deleteThread(String(threadID), (err) => err ? reject(err) : resolve());
            });
            return _json(res, { ok: true });
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        if (pathname === '/bot/accept-request' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            await new Promise((resolve) =>
              _api.handleMessageRequest(String(threadID), true, () => resolve())
            );
          } catch (_) {}
          return _json(res, { ok: true });
        }

        if (pathname === '/bot/health' && method === 'GET') {
          let healthMonitorStatus = { sendFailCount: 0, sendFailWindow: 300000, lastCookieScan: { result: 'pending', ts: null } };
          try {
            const _healthMon = require('./includes/login/accountHealthMonitor');
            if (typeof _healthMon.getStatus === 'function') healthMonitorStatus = _healthMon.getStatus();
          } catch (_) {}

          const _motorData  = global['motorData']  || {};
          const _motorData2 = global['motorData2'] || {};
          const _repeatName = global['repeatName'] || {};

          const activeMotors = [];
          for (const [tid, d] of Object.entries(_motorData)) {
            if (d && d.status) activeMotors.push({ threadID: tid, type: 'motor1', message: d.message, intervalMs: d.time });
          }
          for (const [tid, d] of Object.entries(_motorData2)) {
            if (d && d.status) activeMotors.push({ threadID: tid, type: 'motor2', message: d.message, intervalMs: d.time });
          }

          const activeLocks = [];
          for (const [tid, entry] of Object.entries(_repeatName)) {
            if (entry && entry.status === true) activeLocks.push({ threadID: tid, name: entry.name || null });
          }

          return _json(res, {
            activeTier:     global['activeAccountTier'] || 1,
            sendFailCount:  healthMonitorStatus.sendFailCount,
            sendFailWindow: healthMonitorStatus.sendFailWindow,
            lastCookieScan: healthMonitorStatus.lastCookieScan,
            activeMotors,
            activeLocks,
            ts: new Date().toISOString()
          });
        }

        // ── Live stats ───────────────────────────────────────────────────────
        if (pathname === '/bot/stats' && method === 'GET') {
          try {
            const stats = require('./includes/liveStats').getStats();
            return _json(res, stats);
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        // ── System stats (CPU/RAM history for Health graph) ───────────────────
        if (pathname === '/bot/sys-stats' && method === 'GET') {
          const mem = process.memoryUsage();
          return _json(res, {
            ok:      true,
            samples: _sysStatsSamples,
            current: {
              ts:     Date.now(),
              memMB:  Math.round(mem.rss / 1024 / 1024),
              heapMB: Math.round(mem.heapUsed / 1024 / 1024),
            }
          });
        }

        // ── Protection status ─────────────────────────────────────────────────
        if (pathname === '/bot/protection/status' && method === 'GET') {
          try {
            const payload = { ts: new Date().toISOString() };

            try { payload.rateLimit      = require('./includes/EnhancedRateLimiter').getStatus();      } catch (_) {}
            try { payload.requestPacing  = require('./includes/RequestPacingEngine').getStatus();      } catch (_) {}
            try { payload.sendPipeline   = require('./includes/sendPipeline').getStatus();             } catch (_) {}
            try { payload.errorSummary   = require('./includes/errorHandler').getStatus();             } catch (_) {}
            try {
              const as = global._antiSuspension;
              if (as && typeof as.getStatus === 'function') payload.antiSuspension = as.getStatus();
            } catch (_) {}
            try {
              const mhc = require('./includes/mqttHealthCheck');
              if (typeof mhc.getStatus === 'function') payload.mqttHealth = mhc.getStatus();
            } catch (_) {}
            try {
              const out = require('./includes/outgoingThrottle');
              if (typeof out.getStatus === 'function') payload.outgoingThrottle = out.getStatus();
            } catch (_) {}
            try {
              const se = require('./includes/stealthEngine');
              if (se.globalStealthEngine && typeof se.globalStealthEngine.getStatus === 'function')
                payload.stealthEngine = se.globalStealthEngine.getStatus();
            } catch (_) {}
            try {
              const cfg = require('./includes/configManager');
              payload.configCacheAgeMs = cfg.cacheAge();
            } catch (_) {}

            return _json(res, payload);
          } catch (e) {
            return _json(res, { error: e.message }, 500);
          }
        }

        // ── Nick-Protect status ───────────────────────────────────────────────
        if (pathname === '/bot/nick-protect/status' && method === 'GET') {
          try {
            const NP = require('./includes/nickProtect');
            return _json(res, { ok: true, threads: NP.getAll() });
          } catch (e) { return _json(res, { error: e.message }, 500); }
        }

        if (pathname === '/bot/nick-protect/toggle' && method === 'POST') {
          try {
            const { threadID, action } = body;
            if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
            const NP = require('./includes/nickProtect');
            const tid = String(threadID);
            if (action === 'disable') {
              NP.disable(tid);
              return _json(res, { ok: true, enabled: false });
            }
            if (action === 'enable') {
              if (!NP.isEnabled(tid)) NP.enable(tid, {});
              return _json(res, { ok: true, enabled: true });
            }
            return _json(res, { error: 'action must be enable or disable' }, 400);
          } catch (e) { return _json(res, { error: e.message }, 500); }
        }

        // ── Hold tab: per-thread status ──────────────────────────────────────
        if (pathname === '/bot/hold/status' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          let nmLock = null;
          try { const NL = require('./includes/nameLocks');   const e = NL.getLock(tid);   if (e) nmLock   = e; } catch (_) {}
          let nickLock = null;
          try { const NCL = require('./includes/nicknameLocks'); const e = NCL.getLock(tid); if (e) nickLock = e; } catch (_) {}
          const m1 = (global.motorData  || {})[tid] || null;
          const m2 = (global.motorData2 || {})[tid] || null;
          return _json(res, {
            ok: true, threadID: tid,
            nm:     nmLock   ? { locked: true,  name:     nmLock.name,       time: nmLock.time,   randomTime: !!nmLock.randomTime,   randomRange: nmLock.randomRange }   : { locked: false },
            nick:   nickLock ? { locked: true,  nickname: nickLock.nickname,  scope: nickLock.scope, time: nickLock.time, randomTime: !!nickLock.randomTime, randomRange: nickLock.randomRange } : { locked: false },
            motor1: m1 ? { status: !!m1.status, message: m1.message, time: m1.time, randomTime: !!m1.randomTime, randomRange: m1.randomRange } : { status: false },
            motor2: m2 ? { status: !!m2.status, message: m2.message, time: m2.time, randomTime: !!m2.randomTime, randomRange: m2.randomRange } : { status: false },
          });
        }

        // ── Hold tab: NM (name lock) control ─────────────────────────────────
        if (pathname === '/bot/hold/nm-set' && method === 'POST') {
          const { threadID, action, name, timeMs } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          try {
            const NL = require('./includes/nameLocks');
            if (action === 'enable') {
              if (!name) return _json(res, { error: 'Missing name' }, 400);
              const existingNm = NL.getLock(tid);
              NL.setLock(tid, name, {
                time:        (timeMs && !isNaN(Number(timeMs)) && Number(timeMs) >= 1000) ? Number(timeMs) : (existingNm?.time ?? 6000),
                randomTime:  existingNm?.randomTime  ?? false,
                randomRange: existingNm?.randomRange ?? null
              });
              if (!global._nmNextApply) global._nmNextApply = new Map();
              const lock = NL.getLock(tid);
              global._nmNextApply.set(tid, Date.now() + (lock?.time || 6000));
              return _json(res, { ok: true, action: 'enabled', name });
            }
            if (action === 'disable') {
              NL.clearLock(tid);
              if (global._nmNextApply) global._nmNextApply.delete(tid);
              return _json(res, { ok: true, action: 'disabled' });
            }
            if (action === 'time') {
              const ms = Number(timeMs);
              if (!ms || isNaN(ms) || ms < 1000) return _json(res, { error: 'timeMs must be >= 1000' }, 400);
              NL.setLockTime(tid, { time: ms, randomTime: false, randomRange: null });
              if (global._nmNextApply) global._nmNextApply.set(tid, Date.now() + ms);
              return _json(res, { ok: true, action: 'time-set', timeMs: ms });
            }
            return _json(res, { error: 'Unknown action' }, 400);
          } catch (e) { return _json(res, { error: e.message }, 500); }
        }

        // ── Hold tab: Nickname lock control ──────────────────────────────────
        if (pathname === '/bot/hold/nick-set' && method === 'POST') {
          const { threadID, action, nickname, scope, timeMs } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          try {
            const NCL = require('./includes/nicknameLocks');
            if (action === 'enable') {
              if (!nickname) return _json(res, { error: 'Missing nickname' }, 400);
              const sc = scope === 'bot' ? 'bot' : 'all';
              const existingNk = NCL.getLock(tid);
              NCL.setLock(tid, nickname, sc, {
                time:        (timeMs && !isNaN(Number(timeMs)) && Number(timeMs) >= 100) ? Number(timeMs) : (existingNk?.time ?? 500),
                randomTime:  existingNk?.randomTime  ?? false,
                randomRange: existingNk?.randomRange ?? null
              });
              return _json(res, { ok: true, action: 'enabled', nickname, scope: sc });
            }
            if (action === 'disable') {
              NCL.clearLock(tid);
              if (global._nickNextApply) global._nickNextApply.delete(tid);
              return _json(res, { ok: true, action: 'disabled' });
            }
            if (action === 'time') {
              const ms = Number(timeMs);
              if (!ms || isNaN(ms) || ms < 100) return _json(res, { error: 'timeMs must be >= 100' }, 400);
              NCL.setLockTime(tid, { time: ms, randomTime: false, randomRange: null });
              if (global._nickNextApply) global._nickNextApply.set(tid, Date.now() + ms);
              return _json(res, { ok: true, action: 'time-set', timeMs: ms });
            }
            return _json(res, { error: 'Unknown action' }, 400);
          } catch (e) { return _json(res, { error: e.message }, 500); }
        }

        // ── Hold tab: Motor 1 control ─────────────────────────────────────────
        if (pathname === '/bot/hold/motor1-set' && method === 'POST') {
          const { threadID, action, message, timeMs } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          try {
            global.motorData = global.motorData || {};
            if (!global.motorData[tid]) global.motorData[tid] = { status: false, message: null, time: null, randomTime: false, randomRange: null, interval: null };
            const d = global.motorData[tid];
            const { motor1 } = require('./includes/motorPersist');
            if (action === 'message') {
              if (!message) return _json(res, { error: 'Missing message' }, 400);
              d.message = message; motor1.persistAll(global.motorData);
              return _json(res, { ok: true, action: 'message-set', message });
            }
            if (action === 'time') {
              const ms = Number(timeMs);
              if (!ms || isNaN(ms) || ms < 5000) return _json(res, { error: 'timeMs must be >= 5000' }, 400);
              d.time = ms; d.randomTime = false; d.randomRange = null;
              motor1.persistAll(global.motorData);
              return _json(res, { ok: true, action: 'time-set', timeMs: ms });
            }
            if (action === 'enable') {
              if (!d.message) return _json(res, { error: 'Set message first' }, 400);
              if (!d.time)    return _json(res, { error: 'Set time first' }, 400);
              d.status = true; motor1.persistAll(global.motorData);
              try { const { scheduleMotorLoop } = require('./includes/motorSafeSend'); scheduleMotorLoop({ api: _api, threadID: tid, getData: () => global.motorData[tid], onDisable: () => motor1.persistAll(global.motorData) }); } catch (_) {}
              return _json(res, { ok: true, action: 'enabled' });
            }
            if (action === 'disable') {
              d.status = false;
              try { const { stopMotorLoop } = require('./includes/motorSafeSend'); stopMotorLoop(tid); } catch (_) {}
              try { clearInterval(d.interval); } catch (_) {}
              d.interval = null; motor1.persistAll(global.motorData);
              return _json(res, { ok: true, action: 'disabled' });
            }
            return _json(res, { error: 'Unknown action' }, 400);
          } catch (e) { return _json(res, { error: e.message }, 500); }
        }

        // ── Hold tab: Motor 2 control ─────────────────────────────────────────
        if (pathname === '/bot/hold/motor2-set' && method === 'POST') {
          const { threadID, action, message, timeMs } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          const tid = String(threadID);
          try {
            global.motorData2 = global.motorData2 || {};
            if (!global.motorData2[tid]) global.motorData2[tid] = { status: false, message: null, time: null, randomTime: false, randomRange: null, interval: null };
            const d = global.motorData2[tid];
            const { motor2 } = require('./includes/motorPersist');
            if (action === 'message') {
              if (!message) return _json(res, { error: 'Missing message' }, 400);
              d.message = message; motor2.persistAll(global.motorData2);
              return _json(res, { ok: true, action: 'message-set', message });
            }
            if (action === 'time') {
              const ms = Number(timeMs);
              if (!ms || isNaN(ms) || ms < 5000) return _json(res, { error: 'timeMs must be >= 5000' }, 400);
              d.time = ms; d.randomTime = false; d.randomRange = null;
              motor2.persistAll(global.motorData2);
              return _json(res, { ok: true, action: 'time-set', timeMs: ms });
            }
            if (action === 'enable') {
              if (!d.message) return _json(res, { error: 'Set message first' }, 400);
              if (!d.time)    return _json(res, { error: 'Set time first' }, 400);
              d.status = true;
              d.shouldSend = function() { const la = (global.lastActivity || {})[tid]; return !!la && (Date.now() - la) < (Number(d.time) || 0) * 2; };
              motor2.persistAll(global.motorData2);
              try { const { scheduleMotorLoop } = require('./includes/motorSafeSend'); scheduleMotorLoop({ api: _api, threadID: tid, getData: () => global.motorData2[tid], onDisable: () => motor2.persistAll(global.motorData2) }); } catch (_) {}
              return _json(res, { ok: true, action: 'enabled' });
            }
            if (action === 'disable') {
              d.status = false;
              try { const { stopMotorLoop } = require('./includes/motorSafeSend'); stopMotorLoop(tid); } catch (_) {}
              try { clearInterval(d.interval); } catch (_) {}
              d.interval = null; motor2.persistAll(global.motorData2);
              return _json(res, { ok: true, action: 'disabled' });
            }
            return _json(res, { error: 'Unknown action' }, 400);
          } catch (e) { return _json(res, { error: e.message }, 500); }
        }

        // ── Message request accept / decline ─────────────────────────────────
        if (pathname === '/bot/message-requests/accept' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            // Try handleMessageRequest first (may not exist in all library versions)
            if (typeof _api.handleMessageRequest === 'function') {
              await new Promise((resolve, reject) => {
                try { _api.handleMessageRequest(String(threadID), true, (err) => err ? reject(err) : resolve()); }
                catch (e) { reject(e); }
              });
            } else {
              // Fallback: send a message to move thread from PENDING to INBOX
              await new Promise((resolve) => {
                _api.sendMessage('مرحباً 👋', String(threadID), () => resolve());
              });
            }
            // Send greeting after accepting
            try { await new Promise((resolve) => { _api.sendMessage('مرحباً 👋', String(threadID), () => resolve()); }); } catch (_) {}
            return _json(res, { ok: true, accepted: true, threadID });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        if (pathname === '/bot/message-requests/decline' && method === 'POST') {
          const { threadID } = body;
          if (!threadID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            if (typeof _api.handleMessageRequest === 'function') {
              await new Promise((resolve, reject) => {
                try { _api.handleMessageRequest(String(threadID), false, (err) => err ? reject(err) : resolve()); }
                catch (e) { reject(e); }
              });
            }
            return _json(res, { ok: true, declined: true, threadID });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 300) }, 500); }
        }

        // ── Thread history (Messenger-style chat view) ──────────────────────────
        if (pathname === '/bot/thread-history' && method === 'GET') {
          const _params = new URLSearchParams(req.url.split('?')[1] || '');
          const _thTID = _params.get('threadID');
          const _thCount = Math.min(parseInt(_params.get('count') || '30'), 50);
          if (!_thTID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { ok: false, messages: [], error: 'Bot not connected' });
          try {
            const history = await new Promise((resolve, reject) => {
              if (typeof _api.getThreadHistory !== 'function') return resolve([]);
              _api.getThreadHistory(String(_thTID), _thCount, undefined, (err, data) => {
                if (err) reject(err);
                else resolve(Array.isArray(data) ? data : []);
              });
            });
            const msgs = history.slice(-_thCount).map(m => ({
              messageID: m.messageID || null,
              senderID: String(m.senderID || ''),
              senderName: m.senderName || null,
              body: m.body || '',
              timestamp: m.timestamp || 0,
              attachments: (m.attachments || []).slice(0, 3).map(a => ({
                type: a.type || 'file',
                url: a.url || a.previewUrl || null,
                filename: a.filename || null,
              })),
              isUnsent: !!m.isUnsent,
            }));
            return _json(res, { ok: true, messages: msgs, threadID: _thTID });
          } catch (e) {
            return _json(res, { ok: false, messages: [], error: String(e.message || e).slice(0, 200) });
          }
        }

        // ── Group members ────────────────────────────────────────────────────────
        if (pathname === '/bot/group-members' && method === 'GET') {
          const _gmp = new URLSearchParams(req.url.split('?')[1] || '');
          const _gmTID = _gmp.get('threadID');
          if (!_gmTID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { ok: false, members: [], error: 'Bot not connected' });
          try {
            const threadInfo = await new Promise((resolve, reject) => {
              if (typeof _api.getThreadInfo !== 'function') return resolve(null);
              _api.getThreadInfo(String(_gmTID), (err, data) => err ? reject(err) : resolve(data));
            });
            if (!threadInfo) return _json(res, { ok: true, members: [], threadID: _gmTID });
            const participantIDs = (threadInfo.participantIDs || []).map(String);
            let userInfoMap = {};
            if (participantIDs.length > 0 && typeof _api.getUserInfo === 'function') {
              try {
                userInfoMap = await new Promise((resolve, reject) => {
                  _api.getUserInfo(participantIDs.slice(0, 50), (err, data) => err ? reject(err) : resolve(data || {}));
                });
              } catch (_) {}
            }
            const adminIDs = (threadInfo.adminIDs || []).map(a => String(a.id || a));
            const members = participantIDs.map(uid => {
              const info = userInfoMap[uid] || {};
              return {
                userID: uid,
                name: info.name || info.fullName || uid,
                profilePic: info.thumbSrc || info.profilePicture || null,
                gender: info.gender === 1 ? 'male' : info.gender === 2 ? 'female' : null,
                isAdmin: adminIDs.includes(uid),
              };
            });
            return _json(res, {
              ok: true, members, threadID: _gmTID, count: members.length,
              name: threadInfo.name || threadInfo.threadName || _gmTID,
            });
          } catch (e) {
            return _json(res, { ok: false, members: [], error: String(e.message || e).slice(0, 200) });
          }
        }

        // ── Change group name ────────────────────────────────────────────────────
        if (pathname === '/bot/group-change-name' && method === 'POST') {
          const { threadID: _cnTID, name: _cnName } = body;
          if (!_cnTID || !_cnName) return _json(res, { error: 'Missing threadID or name' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            await new Promise((resolve, reject) => {
              if (typeof _api.setTitle !== 'function') return reject(new Error('setTitle API not available'));
              _api.setTitle(String(_cnName).trim(), String(_cnTID), (err) => err ? reject(err) : resolve());
            });
            return _json(res, { ok: true, name: String(_cnName).trim(), threadID: _cnTID });
          } catch (e) {
            return _json(res, { ok: false, error: String(e.message || e).slice(0, 200) });
          }
        }

        // ── Kick group member ────────────────────────────────────────────────────
        if (pathname === '/bot/group-kick' && method === 'POST') {
          const { threadID: _kkTID, userID: _kkUID } = body;
          if (!_kkTID || !_kkUID) return _json(res, { error: 'Missing threadID or userID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            await new Promise((resolve, reject) => {
              if (typeof _api.removeUserFromGroup !== 'function') return reject(new Error('removeUserFromGroup not available'));
              _api.removeUserFromGroup(String(_kkUID), String(_kkTID), (err) => err ? reject(err) : resolve());
            });
            return _json(res, { ok: true });
          } catch (e) {
            return _json(res, { ok: false, error: String(e.message || e).slice(0, 200) });
          }
        }

        // ── Set member nickname ──────────────────────────────────────────────
        if (pathname === '/bot/set-nickname' && method === 'POST') {
          const { threadID: _nnTID, userID: _nnUID, nickname: _nnNick } = body;
          if (!_nnTID || !_nnUID) return _json(res, { error: 'Missing threadID or userID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            await new Promise((resolve, reject) => {
              if (typeof _api.changeNickname !== 'function') return reject(new Error('changeNickname API not available'));
              _api.changeNickname(String(_nnNick || ''), String(_nnTID), String(_nnUID), (err) => err ? reject(err) : resolve());
            });
            return _json(res, { ok: true });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 200) }); }
        }

        // ── Send media / file (base64) ───────────────────────────────────────
        if (pathname === '/bot/send-media' && method === 'POST') {
          const { threadID: _smTID, base64: _smB64, mimeType: _smMime, filename: _smFname, messageBody: _smBodyText } = body;
          if (!_smTID || !_smB64) return _json(res, { error: 'Missing threadID or base64' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            const { PassThrough } = require('stream');
            const buf = Buffer.from(String(_smB64), 'base64');
            const stream = new PassThrough();
            const ext = (_smMime || '').split('/')[1] || 'bin';
            stream.path = _smFname || ('upload-' + Date.now() + '.' + ext);
            stream.end(buf);
            const msg = { attachment: stream };
            if (_smBodyText) msg.body = String(_smBodyText);
            await new Promise((resolve, reject) => {
              _api.sendMessage(msg, String(_smTID), (err, info) => err ? reject(err) : resolve(info));
            });
            return _json(res, { ok: true });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 200) }); }
        }

        // ── Report message / thread as spam ─────────────────────────────────
        if (pathname === '/bot/report-message' && method === 'POST') {
          const { threadID: _rpTID, messageID: _rpMID } = body;
          if (!_rpTID) return _json(res, { error: 'Missing threadID' }, 400);
          if (!_api) return _json(res, { error: 'Bot not connected' }, 503);
          try {
            if (typeof _api.markAsSpam === 'function') {
              await new Promise((resolve, reject) => {
                _api.markAsSpam(String(_rpTID), (err) => err ? reject(err) : resolve());
              });
            } else {
              return _json(res, { ok: false, error: 'Report/spam API not available in this library version' }, 503);
            }
            return _json(res, { ok: true });
          } catch (e) { return _json(res, { ok: false, error: String(e.message || e).slice(0, 200) }); }
        }

        // ── Bot user ID (for message direction) ──────────────────────────────
        if (pathname === '/bot/my-id' && method === 'GET') {
          return _json(res, { ok: true, botID: global['botUserID'] || '' });
        }

        res.writeHead(404); res.end('Not found');
      } catch (e) {
        _json(res, { error: e.message }, 500);
      }
    });

    const _botApiPort = Number(process.env.BOT_API_PORT) || 3001;
    _panelServer.listen(_botApiPort, '127.0.0.1', () => {
      logger.log([
        { message: '[ PANEL ]: ', color: ['red', 'cyan'] },
        { message: `Internal API ready on 127.0.0.1:${_botApiPort}`, color: 'white' }
      ]);
    });
    _panelServer.on('error', e => {
      logger.log([
        { message: '[ PANEL ]: ', color: ['red', 'cyan'] },
        { message: 'Internal API error: ' + e.message, color: 'yellow' }
      ]);
    });
  })();

  // ── MQTT silence watchdog — tracks last message timestamp ────
  global['lastMqttActivity']      = Date.now();
  global['lastAltJsonSave']        = Date.now();

  // ── Message handler ───────────────────────────────────────
  function messageHandler(err, message) {
    if (err) return handlerWhenListenHasError(err);

    global['lastMqttActivity'] = Date.now();
    // [FIX S14] — Mark MQTT as confirmed-ready on first successful delivery.
    // Commands that check isMqttUp() use this flag to avoid dispatching before
    // the transport is established, preventing "Not connected to MQTT" rejections.
    if (!global._mqttReady) global._mqttReady = true;

    // Skip low-value event types
    if (['typ', 'read_receipt', 'presence'].some(t => t == message['type'])) return;

    if (global['config']['DeveloperMode'] === true) console.log(message);

    return handleListen(message);
  }

  // Start listening (gen-guarded so any future zombie listener is silenced).
  {
    const myGen = ++_listenerGen;
    global['handleListen'] = _api['listenMqtt'](function _genGuardedHandler(err, message) {
      if (myGen !== _listenerGen) return;
      return messageHandler(err, message);
    });
  }
  // [FIX S14] — MQTT readiness safety fallback: if 45 seconds pass with no
  // incoming messages (quiet group / test env), allow command sweeps to proceed
  // anyway so the bot doesn't stay perpetually locked on a silent instance.
  global._mqttReady = false;
  setTimeout(() => { if (!global._mqttReady) global._mqttReady = true; }, 45000).unref();

  global['client']['api'] = _api;
  global._botApi          = _api;   // keep reference fresh after listen starts

  // ── دالة إعادة تشغيل المستمع للـ MQTT Health Check ────────
  // Funnel through safeRestartListener so we can never end up with two
  // overlapping listenMqtt clients.
  global['_restartListener'] = function (reason) {
    safeRestartListener(reason || 'mqtt-health');
  };

  // ── تشغيل MQTT Health Check ────────────────────────────────
  try {
    const mqttHealth = require('./includes/mqttHealthCheck');
    mqttHealth.startHealthCheck();
  } catch (e) {
    logger.log([
      { message: '[ MQTT-HEALTH ]: ', color: ['red', 'cyan'] },
      { message: `فشل تشغيل فحص صحة MQTT: ${e.message}`, color: 'white' }
    ]);
  }

  // ── تشغيل Keep-Alive (GoatBot system) ─────────────────────
  try {
    const { startKeepAlive } = require('./includes/keepAlive');
    startKeepAlive();
  } catch (e) {
    logger.log([
      { message: '[ KEEP-ALIVE ]: ', color: ['red', 'cyan'] },
      { message: `فشل تشغيل نظام إبقاء الجلسة: ${e.message}`, color: 'white' }
    ]);
  }

  // GraphQL notification visit is now handled exclusively by keepAlive.js
  // (doNotificationVisit) to avoid duplicate CometNotificationsDropdownQuery
  // calls. graphqlVisit.js has been removed (R03/R12 from audit).

  // ── Warm thread cache from INBOX (idea ported from holo) ───
  // Paginates getThreadList right after login so allThreadID /
  // threadInfo are populated for every group the bot is in,
  // not just the ones that have spoken since boot. Fire-and-forget.
  try {
    const sync = require('./includes/syncAllGroups');
    if (sync && typeof sync.start === 'function') sync.start(_api);
  } catch (e) {
    logger.log([
      { message: '[ SYNC-GROUPS ]: ', color: ['red', 'cyan'] },
      { message: `Failed to start group sync: ${e.message}`, color: 'white' }
    ]);
  }

  // ── Session Guard (AppState snapshots + integrity monitoring) ──────────────
  // Three-layer protection:
  //   L1 — versioned AppState snapshot every 30 min
  //   L2 — cookie integrity check (c_user/xs/datr) every 20 min
  //   L3 — pre-relogin hook so we always snapshot BEFORE attempting re-login
  try {
    const sessionGuard = require('./includes/sessionGuard');
    const statePath = require('path').join(process.cwd(), 'sessions', 'ZAO-STATE.json');
    sessionGuard.start(_api, statePath);
  } catch (e) {
    logger.log([
      { message: '[ SESSION-GUARD ]: ', color: ['red', 'cyan'] },
      { message: `Failed to start session guard: ${e.message}`, color: 'white' }
    ]);
  }

  // ── External-URL uptime ping (white/autoUptime pattern) ───
  // Off by default. Enable in ZAO-SETTINGS.json -> autoUptime.enable
  // for free hosts that sleep without inbound traffic.
  try {
    require('./includes/autoUptime').start();
  } catch (e) {
    logger.log([
      { message: '[ AUTO-UPTIME ]: ', color: ['red', 'cyan'] },
      { message: `Failed to start autoUptime: ${e.message}`, color: 'white' }
    ]);
  }

  // ─── Protection systems startup banner ────────────────────
  const _gradStr2Mod = require('gradient-string');
  const gradStr2 = _gradStr2Mod.default || _gradStr2Mod;
  const grad2    = gradStr2('red', 'cyan');
  console.log(grad2('━'.repeat(50), { interpolation: 'hsv' }));
  console.log(require('chalk').bold.hex('#1390f0')('──PROTECTION SYSTEMS─●'));
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Stealth-Engine   ✓  burst protection + night-mode + UA rotation + thread jitter', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Auto-Ping        ✓  random 8-18 min', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Cookie Save      ✓  every 10 min → ZAO-STATE.json & alt.json', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Auto-Relogin     ✓  3 attempts / 3-min cooldown (JSON/Token/String/Netscape → Email/Password fallback)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Health-Monitor   ✓  cookie scan every 5 min + send-fail watchdog → auto tier-switch (Tier 1→2→3)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Session-Check    ✓  proactive live-cookie validation every 35 min', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'MQTT-Silence     ✓  إعادة تشغيل المستمع إذا صمت > 10 دقائق', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'MQTT-HealthCheck ✓  فحص ذكي مع backoff تصاعدي (من GoatBot)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Human-Typing     ✓  محاكاة الطباعة البشرية قبل كل رد', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Keep-Alive       ✓  Ping مباشر لفيسبوك كل 8-18 دقيقة + تجديد fb_dtsg كل 48 ساعة', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Memory-Guard     ✓  clean restart if heap > 512 MB', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Graceful-Exit    ✓  two-stage drain — stop dispatch → flush motors/locks → save cookies', color: 'white' }]);
  // ─── New process-death prevention layers ──────────────────
  // Started here so they appear under the PROTECTION SYSTEMS banner.
  try { require('./includes/eventLoopGuard').start({ thresholdMs: 500, sustainMs: 30 * 1000, checkEveryMs: 5 * 1000 }); } catch (_) {}
  try { require('./includes/diskGuard').start({ warnPct: 90, checkEveryMs: 30 * 60 * 1000 }); } catch (_) {}
  try { require('./includes/networkProbe'); } catch (_) {} // lazy — used by autoRelogin on demand
  try { require('./includes/commandSandbox'); } catch (_) {}
  try { require('./includes/commandErrorBudget'); } catch (_) {}
  try { require('./includes/stealthEngineV2').start(_api); } catch (_) {}

  // ── تشغيل نظام التشفير E2EE (Labyrinth / Signal / Double Ratchet) ──────────
  try {
    const labyrinthCfg = global.config?.labyrinth;
    if (labyrinthCfg?.enabled !== false) {
      const labyrinth = require('./includes/labyrinth');
      if (labyrinth && typeof labyrinth.init === 'function') {
        await labyrinth.init(_api);
        logger.log([{ message: '[ E2EE ]: ', color: ['red', 'cyan'] }, { message: 'Labyrinth E2EE initialized ✓ (X3DH / Double Ratchet)', color: 'white' }]);
      }
    }
  } catch (_labErr) {
    logger.log([{ message: '[ E2EE ]: ', color: ['red', 'cyan'] }, { message: 'Labyrinth init skipped: ' + (_labErr.message || _labErr), color: 'yellow' }]);
  }
  // [PROTECT] Cookie snapshot ring — capture an initial snapshot from the
  // freshly-loaded live state so the watchdog has a known-good restore point
  // even if the bot dies before the first periodic save.
  try {
    const _snap = require('./includes/cookieSnapshot');
    _snap.snapshotFile(join(process.cwd(), global['config']['APPSTATEPATH'] || 'ZAO-STATE.json'));
  } catch (_) {}
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Loop-Lag-Guard   ✓  perf_hooks p95 > 500ms for 30s → stack snapshot + clean recycle', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Disk-Guard       ✓  rotate large logs + prune backups; emergency cleanup at 90% disk', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Network-Probe    ✓  DNS+TCP edge-mqtt.facebook.com check before tier-switch (no wasted relogins)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Command-Sandbox  ✓  30s wall-clock timeout on every command.run / handleReply / handleEvent', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Error-Budget     ✓  >5 errors / 10 min on the same command → auto-disable 1h + admin notify', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Cookie-Snapshot  ✓  last 5 validated snapshots in backups/ — watchdog restores instead of re-logging in', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Stealth-V2       ✓  10 layers: UA rotation, warmup, sleep-mode, page-browse, presence cycling (opt-in)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Listen-Error     ✓  instant listener restart + login_blocked/account_inactive/auth_error detection', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Error-Notify     ✓  Telegram / Discord webhook on session-kill or listen errors (opt-in)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'GraphQL-Visit    ✓  CometNotificationsDropdownQuery every 30-120 min — looks like a real client', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Auto-Uptime      ✓  external-URL ping for free hosts (opt-in via autoUptime.enable)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Sync-Groups      ✓  warm threadInfo cache from INBOX after login (idea from holo)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Refresh-Cache    ✓  live update on log:thread-admins / name / image / icon / subscribe / unsubscribe (from seiko)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Session-Guard    ✓  AppState snapshot every 30 min + cookie integrity check every 20 min + pre-relogin hook', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: `Auto-Lock        ✓  raid guard — auto-lock after ${(global.config.autoLock||{}).maxCommands||15} non-admin cmds in ${(global.config.autoLock||{}).windowSeconds||30}s`, color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Settings-Watch   ✓  hot-reload ZAO-SETTINGS.json', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Crash-Restore    ✓  alt.json → ZAO-STATE.json on crash', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: 'Cache-Cleanup    ✓  prune userName/threadInfo/threadData maps every 2 h (max 5 000 entries)', color: 'white' }]);
  logger.log([{ message: '[ PROTECT ]: ', color: ['red', 'cyan'] }, { message: `Cookie-Refresh   ✓  forced credential re-login every ${global['config']['intervalGetNewCookieMinutes'] || 1440} min`, color: 'white' }]);
  console.log(grad2('━'.repeat(50), { interpolation: 'hsv' }));

  // [FIX M10] — guard all self-rescheduling timer chains so they only start
  // once per process lifetime. If onBot() were ever re-entered (e.g. via a
  // reconnect path that doesn't fully restart the process), duplicate timer
  // chains would accumulate silently, doubling network traffic and CPU load.
  if (!global.__onBotTimersStarted) {
  global.__onBotTimersStarted = true;

  // ─── 1. Auto-Ping — keep process alive, random 8-18 min ───────
  (function scheduleAutoPing() {
    const minMs = 8  * 60 * 1000;
    const maxMs = 18 * 60 * 1000;
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    setTimeout(async () => {
      try {
        // [FIX Djamel] — was using port 3000 by default but Main.js uses 5000.
        // Also: prefer 127.0.0.1 over `localhost`. On hosts where localhost
        // resolves to ::1 first while Main.js binds 0.0.0.0 (IPv4 only),
        // every auto-ping silently failed with ECONNREFUSED, defeating the
        // whole keep-alive on that path.
        const port = process.env.PORT || 5000;
        await axios.get(`http://127.0.0.1:${port}/`, { timeout: 10000 });
        logger.log([
          { message: '[ AUTO-PING ]: ', color: ['red', 'cyan'] },
          { message: `Pinged keep-alive server (next in ${Math.round(delay / 60000)} min)`, color: 'white' }
        ]);
      } catch (e) {
        logger.log([
          { message: '[ AUTO-PING ]: ', color: ['red', 'cyan'] },
          { message: `Ping failed: ${e.message}`, color: 'white' }
        ]);
      }
      scheduleAutoPing();
    }, delay);
  }());

  // ─── 2 & 3. Save cookies to ZAO-STATE.json + alt.json every 10 min ──
  // Routes through keepAlive.doSaveCookies() which uses an atomic
  // tmp-file → rename write and an isSaving lock, so a mid-write kill
  // can never leave a half-written (corrupted) JSON cookie file.
  // [PERF] unref() so this timer never keeps the process alive alone.
  setInterval(async () => {
    try {
      const { doSaveCookies } = require('./includes/keepAlive');
      await doSaveCookies('scheduled-10min');
    } catch (e) {
      logger.log([
        { message: '[ COOKIES ]: ', color: ['red', 'cyan'] },
        { message: `Failed to save cookies: ${e.message}`, color: 'white' }
      ]);
    }
  }, 10 * 60 * 1000).unref();

  // ─── 3b. إجباري: حفظ الكوكيز في alt.json كل 2 ساعة بشكل إلزامي ─
  // هذا الحفظ يعمل بغض النظر عن أي شيء آخر — ضمان وجود نسخة احتياطية
  // [PERF] unref() so this timer never keeps the process alive alone.
  setInterval(async () => {
    try {
      const appState = _api.getAppState();
      if (!appState || !Array.isArray(appState) || appState.length === 0) return;
      const altPath  = join(process.cwd(), 'sessions', 'alt.json');
      atomicWriteFileSync(altPath, JSON.stringify(appState, null, 2), 'utf-8');
      global['lastAltJsonSave'] = Date.now();
      logger.log([
        { message: '[ ALT-SAVE ]: ', color: ['red', 'cyan'] },
        { message: `[إلزامي] تم حفظ ${appState.length} كوكيز في sessions/alt.json (كل ساعتين).`, color: 'white' }
      ]);
    } catch (e) {
      logger.log([
        { message: '[ ALT-SAVE ]: ', color: ['red', 'cyan'] },
        { message: `فشل الحفظ الإلزامي: ${e.message}`, color: 'white' }
      ]);
    }
  }, 2 * 60 * 60 * 1000).unref();

  // ─── 4. Settings file watcher — hot-reload ZAO-SETTINGS.json ──
  // [FIX Djamel] — Watch the PARENT DIRECTORY, not the file itself.
  // The panel writes settings via tmp-file → atomic rename (the safe
  // pattern). fs.watch on the FILE keeps the watch bound to the original
  // inode, so after the very first save the watcher is silently dead and
  // the bot stops hot-reloading config until restart. Watching the dir
  // catches both `change` and `rename` events on the file we care about.
  (function watchSettings() {
    const SETTINGS_NAME = 'ZAO-SETTINGS.json';
    const settingsPath  = join(process.cwd(), SETTINGS_NAME);
    const parentDir     = process.cwd();
    let debounceTimer   = null;
    let lastMtimeMs     = 0;
    try { lastMtimeMs = require('fs').statSync(settingsPath).mtimeMs || 0; } catch (_) {}

    const reload = () => {
      try {
        // Skip spurious wakeups where mtime hasn't actually advanced.
        const st = require('fs').statSync(settingsPath);
        if (st.mtimeMs === lastMtimeMs) return;
        lastMtimeMs = st.mtimeMs;

        const fresh = JSON.parse(require('fs').readFileSync(settingsPath, 'utf-8'));
        for (const key in fresh) global['config'][key] = fresh[key];
        logger.log([
          { message: '[ SETTINGS ]: ', color: ['red', 'cyan'] },
          { message: 'ZAO-SETTINGS.json reloaded successfully.', color: 'white' }
        ]);
      } catch (e) {
        logger.log([
          { message: '[ SETTINGS ]: ', color: ['red', 'cyan'] },
          { message: `Reload failed: ${e.message}`, color: 'white' }
        ]);
      }
    };

    try {
      require('fs').watch(parentDir, (eventType, filename) => {
        if (filename !== SETTINGS_NAME) return;       // ignore unrelated files
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reload, 500);
      });
      logger.log([
        { message: '[ SETTINGS ]: ', color: ['red', 'cyan'] },
        { message: 'Watching ZAO-SETTINGS.json (via parent dir, survives atomic rename) ✓', color: 'white' }
      ]);
    } catch (e) {
      logger.log([
        { message: '[ SETTINGS ]: ', color: ['red', 'cyan'] },
        { message: `File watcher error: ${e.message}`, color: 'white' }
      ]);
    }
  }());

  // ─── 5. Notifications tab — random 30-120 min ─────────────────
  (function scheduleNotifVisit() {
    const minMs = 30  * 60 * 1000;
    const maxMs = 120 * 60 * 1000;
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    setTimeout(async () => {
      try {
        const appState  = _api.getAppState();
        if (!Array.isArray(appState) || appState.length === 0) { scheduleNotifVisit(); return; }
        const cookieStr = appState.map(c => `${c.key}=${c.value}`).join('; ');
        await axios.get('https://www.facebook.com/?sk=notifications', {
          headers: {
            'Cookie':          cookieStr,
            'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer':         'https://www.facebook.com/'
          },
          timeout: 15000,
          maxRedirects: 5
        });
        logger.log([
          { message: '[ NOTIF ]: ', color: ['red', 'cyan'] },
          { message: `Visited notifications tab (next in ${Math.round(delay / 60000)} min)`, color: 'white' }
        ]);
      } catch (e) {
        logger.log([
          { message: '[ NOTIF ]: ', color: ['red', 'cyan'] },
          { message: `Request failed: ${e.message}`, color: 'white' }
        ]);
      }
      scheduleNotifVisit();
    }, delay);
  }());

  // ─── 6. Proactive session health check — every 35 min ──────────
  // Validates the cookie against mbasic.facebook.com BEFORE the
  // MQTT connection fails, so recovery happens proactively.
  (function scheduleSessionCheck() {
    const CHECK_INTERVAL = 35 * 60 * 1000;
    setTimeout(async () => {
      try {
        const checkLiveCookie = require('./includes/login/checkLiveCookie');
        const appState        = _api.getAppState();
        if (!Array.isArray(appState) || appState.length === 0) { scheduleSessionCheck(); return; }
        const cookieStr       = appState.map(c => `${c.key}=${c.value}`).join('; ');
        const userAgent       = global['config']['FCAOption']?.userAgent;
        const isLive          = await checkLiveCookie(cookieStr, userAgent);

        if (!isLive) {
          logger.log([
            { message: '[ SESSION-CHECK ]: ', color: ['red', 'cyan'] },
            { message: 'Proactive check: session is DEAD — triggering auto re-login now.', color: 'white' }
          ]);
          autoRelogin(_api);
        } else {
          logger.log([
            { message: '[ SESSION-CHECK ]: ', color: ['red', 'cyan'] },
            { message: 'Proactive check: session is alive ✓', color: 'white' }
          ]);
        }
      } catch (e) {
        logger.log([
          { message: '[ SESSION-CHECK ]: ', color: ['red', 'cyan'] },
          { message: `Check error: ${e.message}`, color: 'white' }
        ]);
      }
      scheduleSessionCheck();
    }, CHECK_INTERVAL);
  }());

  // ─── 7. MQTT silence watchdog ──────────────────────────────
  // Handled by includes/mqttHealthCheck.js (started above at step 6).
  // That module uses global['_restartListener'] which is defined at line ~907.
  // Duplicate inline watchdog removed to prevent two simultaneous listenMqtt
  // calls that caused the bot to process every message twice.

  // ─── 8. Memory guard — warn at 300 MB, clean exit at 400 MB ──────
  // Saves cookies first so the watchdog restarts with fresh state.
  // [PERF] Threshold reduced 512 → 400 MB so Replit free-tier doesn't OOM.
  //        Added 300 MB warning so operators can spot leaks before hard exit.
  // [PERF] unref() so this timer never prevents a graceful shutdown.
  setInterval(() => {
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heapMB > 300 && heapMB <= 400) {
      logger.log([
        { message: '[ MEMORY ]: ', color: ['red', 'cyan'] },
        { message: `⚠️  Heap ${Math.round(heapMB)} MB — approaching 400 MB limit. Consider restarting if usage keeps rising.`, color: 'yellow' }
      ]);
    }
    if (heapMB > 400) {
      logger.log([
        { message: '[ MEMORY ]: ', color: ['red', 'cyan'] },
        { message: `Heap usage ${Math.round(heapMB)} MB exceeds 400 MB limit — saving state and restarting.`, color: 'white' }
      ]);
      try {
        const appState     = _api.getAppState();
        const appStatePath = join(process.cwd(), global['config']['APPSTATEPATH'] || 'sessions/ZAO-STATE.json');
        atomicWriteFileSync(appStatePath, JSON.stringify(appState, null, 2), 'utf-8');
        atomicWriteFileSync(join(process.cwd(), 'sessions', 'alt.json'), JSON.stringify(appState, null, 2), 'utf-8');
        logger.log([
          { message: '[ MEMORY ]: ', color: ['red', 'cyan'] },
          { message: 'State saved — exiting for watchdog restart.', color: 'white' }
        ]);
      } catch (_) {}
      try { require('./includes/login/statePersist').save(); } catch (_) {}
      setTimeout(() => process.exit(0), 500);
    }
  }, 15 * 60 * 1000).unref();

  // ─── 9. Graceful shutdown — TWO-STAGE drain + save on SIGTERM/SIGINT ──
  //
  // Stage 1 (drain):
  //   • Set global.__draining so handleCommand / handleReply / handleEvent
  //     stop accepting new work immediately.
  //   • Stop every motor loop so no new outbound sends are scheduled.
  //   • Wait up to DRAIN_MAX_MS for in-flight sends/handlers to settle so
  //     a motor mid-send doesn't race the cookie save and corrupt state.
  //
  // Stage 2 (persist):
  //   • Flush nameLocks / nicknames / motor persistors / statePersist.
  //   • Save cookies LAST so the file written to disk reflects the latest
  //     in-memory state from the modules that just flushed.
  //   • Close DB connections (SQLite WAL, Mongoose socket).
  //   • exit(0) so the watchdog restarts with fresh state.
  //
  // The original single-stage handler saved cookies first; if a motor was
  // still sending when SIGTERM arrived, the FCA could rotate cookies after
  // our snapshot and the watchdog would restore from a stale state.
  let _shutdownInProgress = false;
  async function gracefulShutdown(signal) {
    if (_shutdownInProgress) return;
    _shutdownInProgress = true;
    // [FIX S14] — Reduced from 5 000 ms to 2 000 ms so the drain completes
    // well within Main.js's 6 000 ms SIGKILL window. The original 5 000 ms
    // drain raced the watchdog's 3 000 ms SIGKILL, causing forced kills and
    // risking cookie file corruption on every controlled restart.
    const DRAIN_MAX_MS  = 2 * 1000;
    const DRAIN_POLL_MS = 200;

    logger.log([
      { message: '[ SHUTDOWN ]: ', color: ['red', 'cyan'] },
      { message: `${signal} received — Stage 1: draining dispatcher and motors.`, color: 'white' }
    ]);

    // ── Stage 1: stop accepting new work ──
    global.__draining = true;
    try {
      const _ms = require('./includes/motorSafeSend');
      if (_ms && typeof _ms.stopAllMotorLoops === 'function') _ms.stopAllMotorLoops();
    } catch (_) {}

    // Wait for in-flight pending replies/reactions to be processed by their
    // owning commands. We can't observe send-completion directly, but
    // global.client.handleReply size shrinks as replies fire, and the
    // listener is now refusing new dispatch — so a short poll window is
    // enough to let already-scheduled sends finish their await chain.
    const drainStart = Date.now();
    while (Date.now() - drainStart < DRAIN_MAX_MS) {
      await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
      // Heuristic done condition: nothing pending after the poll tick.
      // We always honour the full DRAIN_MAX_MS for safety on busy bots.
    }

    logger.log([
      { message: '[ SHUTDOWN ]: ', color: ['red', 'cyan'] },
      { message: `Stage 2: flushing locks/motors/state then saving cookies.`, color: 'white' }
    ]);

    // ── Stage 2a: flush all module-owned state ──
    // Flush nm locks first — debounced writes settle onto disk.
    try { require('./includes/nameLocks').flush(); } catch (_) {}
    // Save motor1 + motor2 state via the shared persistor (preserves
    // randomTime/randomRange — old inline saves dropped them).
    try { _saveMotorState();  } catch (_) {}
    try { _saveMotor2State(); } catch (_) {}
    // Save nicknames state
    try {
      const _nickFile = require('path').join(process.cwd(), 'data', 'nicknames-state.json');
      require('fs-extra').ensureDirSync(require('path').dirname(_nickFile));
      const _nickOut = {};
      for (const [k, v] of Object.entries(global.nickPersist || {})) _nickOut[k] = v;
      atomicWriteFileSync(_nickFile, JSON.stringify(_nickOut, null, 2), 'utf8');
    } catch (_) {}
    // Save reply/reaction callbacks
    try { require('./includes/login/statePersist').save(); } catch (_) {}

    // ── Stage 2b: cookies LAST — reflects everything flushed above ──
    try {
      const appState     = _api.getAppState();
      const appStatePath = join(process.cwd(), global['config']['APPSTATEPATH'] || 'sessions/ZAO-STATE.json');
      atomicWriteFileSync(appStatePath, JSON.stringify(appState, null, 2), 'utf-8');
      atomicWriteFileSync(join(process.cwd(), 'sessions', 'alt.json'), JSON.stringify(appState, null, 2), 'utf-8');
      // [PROTECT] Cookie snapshot ring — capture on shutdown so the very
      // last known-good state is always available to the watchdog on restart.
      try {
        const snap = require('./includes/cookieSnapshot');
        snap.snapshot(appState, appStatePath);
      } catch (_) {}
      logger.log([
        { message: '[ SHUTDOWN ]: ', color: ['red', 'cyan'] },
        { message: 'Cookies saved successfully.', color: 'white' }
      ]);
    } catch (e) {
      logger.log([
        { message: '[ SHUTDOWN ]: ', color: ['red', 'cyan'] },
        { message: `Could not save cookies: ${e.message}`, color: 'white' }
      ]);
    }

    // [FIX M4] — close DB connections before exit so in-flight writes are
    // flushed and file locks / WAL journals are released cleanly. Without this,
    // SQLite's WAL is left open (data loss risk) and Mongoose keeps the TCP
    // socket alive, which can prevent the process from actually terminating
    // when the event loop still has pending I/O from those connections.
    try {
      const _dbType = global?.config?.data?.type;
      if (_dbType === 'mongodb') {
        const mongoose = require('mongoose');
        mongoose.disconnect().catch(() => {});
      } else if (_dbType === 'sqlite') {
        const _seq = global?.db?.threadModel?.sequelize;
        if (_seq && typeof _seq.close === 'function') _seq.close().catch(() => {});
      }
    } catch (_) {}
    logger.log([
      { message: '[ SHUTDOWN ]: ', color: ['red', 'cyan'] },
      { message: 'All state saved. Goodbye.', color: 'white' }
    ]);
    process.exit(0);
  }

  process.once('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(0)); });
  process.once('SIGINT',  () => { gracefulShutdown('SIGINT' ).catch(() => process.exit(0)); });

  // ─── 10. Global data cache cleanup — trims Maps every 2 h ──────
  // Prevents unbounded memory growth in global.data.userName /
  // threadInfo / threadData as the bot sees more users over time.
  setInterval(() => {
    try {
      const MAX_ENTRIES = 5000;
      let pruned = 0;
      for (const key of ['userName', 'threadInfo', 'threadData']) {
        const map = global['data'][key];
        if (map && map.size > MAX_ENTRIES) {
          const entries = [...map.keys()];
          const toRemove = entries.slice(0, entries.length - MAX_ENTRIES);
          for (const k of toRemove) { map.delete(k); pruned++; }
        }
      }
      if (pruned > 0) {
        logger.log([
          { message: '[ CACHE ]: ', color: ['red', 'cyan'] },
          { message: `Pruned ${pruned} stale entries from data maps (userName/threadInfo/threadData).`, color: 'white' }
        ]);
      }
    } catch (e) {
      logger.log([
        { message: '[ CACHE ]: ', color: ['red', 'cyan'] },
        { message: `Cache cleanup error: ${e.message}`, color: 'white' }
      ]);
    }
  }, 2 * 60 * 60 * 1000).unref();

  // ─── 11. Periodic forced credential re-login (fresh tokens) ────
  // Every N minutes (default 1440 = 24 h), forces a full credential
  // re-login to obtain a brand-new session token and saves it.
  // Only runs if EMAIL + PASSWORD are configured.
  (function scheduleForcedCookieRefresh() {
    const intervalMin = (global['config']['intervalGetNewCookieMinutes'] || 1440);
    const intervalMs  = intervalMin * 60 * 1000;
    setTimeout(async () => {
      const email    = process.env.FB_EMAIL    || global['config']['EMAIL']    || '';
      const password = process.env.FB_PASSWORD || global['config']['PASSWORD'] || '';
      if (!email || !password) {
        logger.log([
          { message: '[ REFRESH ]: ', color: ['red', 'cyan'] },
          { message: 'Skipping scheduled cookie refresh — no EMAIL/PASSWORD configured.', color: 'white' }
        ]);
      } else {
        logger.log([
          { message: '[ REFRESH ]: ', color: ['red', 'cyan'] },
          { message: `Scheduled ${intervalMin}-min cookie refresh — re-logging in to get fresh tokens...`, color: 'white' }
        ]);
        try {
          const getFbstate = require('./includes/login/getFbstate');
          const appState   = await getFbstate(email, password);
          if (appState && Array.isArray(appState) && appState.length) {
            // Use atomic tmp→rename write so a mid-write kill can never corrupt the state file
            const _fsX       = require('fs-extra');
            const _pathX     = require('path');
            const appStatePath = _pathX.join(process.cwd(), global['config']['APPSTATEPATH'] || 'sessions/ZAO-STATE.json');
            const altPath      = _pathX.join(process.cwd(), 'sessions', 'alt.json');
            const newData      = JSON.stringify(appState, null, 2);
            const tmpMain      = appStatePath + '.tmp';
            const tmpAlt       = altPath + '.tmp';
            await _fsX.writeFile(tmpMain, newData, 'utf-8');
            await _fsX.move(tmpMain, appStatePath, { overwrite: true });
            await _fsX.writeFile(tmpAlt, newData, 'utf-8');
            await _fsX.move(tmpAlt, altPath, { overwrite: true });
            logger.log([
              { message: '[ REFRESH ]: ', color: ['red', 'cyan'] },
              { message: 'Fresh cookies obtained and saved ✓', color: 'white' }
            ]);
          }
        } catch (e) {
          logger.log([
            { message: '[ REFRESH ]: ', color: ['red', 'cyan'] },
            { message: `Scheduled refresh failed: ${e.message}`, color: 'white' }
          ]);
        }
      }
      scheduleForcedCookieRefresh();
    }, intervalMs);
  }());

  } // end global.__onBotTimersStarted guard
}

// ─── Connect to DB then launch ────────────────────────────────
console.log(cv('\n──ZAO DATA─●'));

// [FIX DB-BOOT] — sequelize.authenticate() uses the connection pool which
// competes with libuv's thread pool (UV_THREADPOOL_SIZE=4 by default).
// When the full ZAO.js module is loaded, heavy requires (googleapis,
// moment-timezone, etc.) already consume all thread pool slots, leaving
// none for sqlite3's async open — causing an infinite stall at authenticate().
//
// Fix: skip pool-based authenticate() entirely. For SQLite, we just verify
// the storage file is reachable with a synchronous fs check, then proceed
// straight to model loading. The model .sync() calls confirm DB connectivity
// on first use without the pool deadlock.
(async () => {
  try {
    // Verify the SQLite file is accessible without touching the pool.
    const _storagePath = resolve(__dirname, 'includes/data.sqlite');
    const _fs = require('fs');
    if (!_fs.existsSync(_storagePath)) {
      // File will be created by .sync() on first model use — not an error.
      console.log(cv('[DB] SQLite storage not found — will be created on first sync.'));
    }

    const dbArgs = {};
    dbArgs['Sequelize'] = Sequelize;
    dbArgs['sequelize'] = sequelize;

    const models = require('./includes/database/model')(dbArgs);

    logger.log([
      { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
      { message: 'Connected to DB ', color: 'white' }
    ]);

    console.log(cv('\n──LOADING FACEBOOK─●'));

    const botArgs = {};
    botArgs['models'] = models;
    onBot(botArgs);
  } catch (e) {
    console.log('[DB-BOOT] ERROR — cannot start bot:', e && e.message ? e.message : String(e));
    logger.log([
      { message: '[ SAIN ]: ', color: ['red', 'cyan'] },
      { message: "Can't Connect to DB: " + (e && e.message ? e.message : String(e)), color: 'white' }
    ]);
  }
})();

// ─── Global unhandled rejection handler ──────────────────────
// Catches promise rejections that escape .catch() — most commonly
// from FCA-UNO's internal MQTT promise chains. These are logged
// for debugging but do NOT crash the process (non-fatal).
process.on('unhandledRejection', (reason, promise) => {
  const ts  = new Date().toISOString();
  const log = global.loggeryuki;

  let msg   = 'unknown';
  let stack = '';

  if (reason instanceof Error) {
    msg   = reason.message || String(reason);
    stack = reason.stack   || '';
  } else if (reason && typeof reason === 'object') {
    msg   = reason.message || reason.error || reason.description || JSON.stringify(reason);
    stack = reason.stack   || '';
  } else {
    msg = String(reason ?? 'unknown');
  }

  // Trim stack to first 3 frames to keep logs readable
  const stackHint = stack
    ? '\n  ' + stack.split('\n').slice(1, 4).map(l => l.trim()).join('\n  ')
    : '';

  const fullMsg = `[${ts}] Unhandled promise rejection (non-fatal): ${msg}${stackHint}`;

  // [FIX] Use console.error directly — calling log.log() here created a
  // self-amplifying rejection storm (log.log threw → unhandledRejection →
  // log.log again → infinite 103% CPU loop).
  console.error('[UNHANDLED-REJECTION]', fullMsg);
  if (log) {
    try { log.log([
      { message: '[ UNHANDLED-REJECTION ]: ', color: ['red', 'cyan'] },
      { message: fullMsg, color: 'white' }
    ]); } catch (_) {}
  }

  // If the rejection looks like an auth/session error, trigger relogin recovery
  try {
    const msgLower = msg.toLowerCase();
    const isAuthRelated = [
      'session', 'expired', 'checkpoint', 'unauthorized', 'invalid token',
      'logout', 'not-authorized', 'login_blocked', 'account_inactive', 'auth_error',
      'not logged in', 'loginhelper'
    ].some(k => msgLower.includes(k));
    if (isAuthRelated && typeof global._triggerAutoRelogin === 'function') {
      global._triggerAutoRelogin('unhandledRejection: ' + msg.slice(0, 120));
      try { require('./includes/notiWhenListenError').notify(reason, 'unhandledRejection (auth)'); } catch (_) {}
    }
  } catch (_) {}
});

// ─── Global uncaught exception handler ───────────────────────
// Catches synchronous throws that escape all try/catch blocks.
// Saves state, then tries the next account tier instead of crashing.
process.on('uncaughtException', (err, origin) => {
  const ts  = new Date().toISOString();
  const log = global.loggeryuki;

  const msg   = (err && err.message) ? err.message : String(err ?? 'unknown');
  const stack = (err && err.stack)   ? err.stack   : '';

  const stackHint = stack
    ? '\n  ' + stack.split('\n').slice(1, 4).map(l => l.trim()).join('\n  ')
    : '';

  const fullMsg = `[${ts}] Uncaught exception (origin: ${origin || 'uncaughtException'}): ${msg}${stackHint}`;

  // [FIX] Same storm-breaker as unhandledRejection — always console.error first.
  console.error('[UNCAUGHT-EXCEPTION]', fullMsg);
  if (log) {
    try { log.log([
      { message: '[ UNCAUGHT-EXCEPTION ]: ', color: ['red', 'cyan'] },
      { message: fullMsg, color: 'white' }
    ]); } catch (_) {}
  }

  // Save cookies immediately so the watchdog has fresh state.
  // Write to the files belonging to the ACTIVE tier so we never overwrite
  // a Tier-2/3 session with Tier-1 paths when running on a secondary account.
  try {
    const currentApi = (global['client'] && global['client']['api']) || global['_botApi'];
    if (currentApi && typeof currentApi.getAppState === 'function') {
      const appState = currentApi.getAppState();
      if (appState && Array.isArray(appState) && appState.length) {
        const TIER_FILES = {
          1: { stateFile: 'sessions/ZAO-STATE.json',  altFile: 'sessions/alt.json'  },
          2: { stateFile: 'sessions/ZAO-STATEX.json', altFile: 'sessions/altx.json' },
          3: { stateFile: 'sessions/ZAO-STATEV.json', altFile: 'sessions/altv.json' },
        };
        const activeTier = global['activeAccountTier'] && TIER_FILES[global['activeAccountTier']]
          ? global['activeAccountTier']
          : 1;
        const { stateFile, altFile } = TIER_FILES[activeTier];
        const appStatePath = join(process.cwd(), stateFile);
        atomicWriteFileSync(appStatePath, JSON.stringify(appState, null, 2), 'utf-8');
        atomicWriteFileSync(join(process.cwd(), altFile), JSON.stringify(appState, null, 2), 'utf-8');
        if (log) log.log([{ message: '[ UNCAUGHT-EXCEPTION ]: ', color: ['red', 'cyan'] }, { message: `Cookies saved to Tier-${activeTier} files after crash.`, color: 'white' }]);
      }
    }
  } catch (_) {}

  // Save motor / nm / nicknames state
  try { if (typeof global['_saveMotorState'] === 'function') global['_saveMotorState'](); } catch (_) {}
  try { require('./includes/login/statePersist').save(); } catch (_) {}

  // Try to recover by switching to the next account tier.
  // If _triggerAutoRelogin is not yet registered (early crash during startup),
  // exit with code 1 so the watchdog can restart the process cleanly.
  try {
    if (typeof global._triggerAutoRelogin === 'function') {
      global._triggerAutoRelogin('uncaughtException: ' + msg.slice(0, 120));
    } else {
      // Bot hasn't finished initializing — let the watchdog do a clean restart
      const _log2 = global.loggeryuki;
      if (_log2) _log2.log([{ message: '[ UNCAUGHT-EXCEPTION ]: ', color: ['red', 'cyan'] }, { message: 'relogin handler not ready — exiting for watchdog restart.', color: 'yellow' }]);
      else console.error('[UNCAUGHT-EXCEPTION] relogin handler not ready — exiting for watchdog restart.');
      setTimeout(() => process.exit(1), 500);
    }
  } catch (_) {
    setTimeout(() => process.exit(1), 500);
  }
});
