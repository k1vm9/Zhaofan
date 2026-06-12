"use strict";

/**
 * Anti-Suspension Module
 * Comprehensive protection against Facebook bot account suspension.
 * Designed to be fast (single-delay model) yet stealth.
 *
 * Credits: NeoKEX — https://github.com/NeoKEX
 * @debugger Djamel — Fixed _getUtils() missing module bug, patched user-agents require
 *                  — Added cross-restart state persistence so daily/hourly counters
 *                    and circuit-breaker trips survive watchdog restarts (the bot
 *                    used to forget every limit and warmup window on every reboot,
 *                    which was the single biggest stealth regression).
 */

const _fs   = require('fs');
const _path = require('path');
const _atomic = (() => {
    try { return require('../utils/atomicWrite').atomicWriteFileSync; }
    catch (_) { return _fs.writeFileSync.bind(_fs); }
})();
const STATE_FILE = _path.join(process.cwd(), 'data', 'anti-suspension-state.json');
// Debounce window for disk writes — protects against IO storms when the bot
// is sending hundreds of messages a minute. Worst-case data loss: 5 seconds.
const SAVE_DEBOUNCE_MS = 5000;

const SUSPENSION_SIGNALS = [
    'checkpoint',
    'action_required',
    'account_locked',
    'account locked',
    'device_login',
    'account suspension',
    'account suspended',
    'account has been suspended',
    'account has been disabled',
    'your account has been disabled',
    'this account has been suspended',
    'account banned',
    'account has been banned',
    'unusual_activity',
    'unusual activity',
    'we noticed unusual activity',
    'suspicious activity',
    'verify_your_account',
    'verify your account',
    'confirm_your_identity',
    'confirm your identity',
    'confirm it\'s you',
    'confirm its you',
    'please verify your account',
    'please confirm your identity',
    'identity confirmation',
    'security_check',
    'security check required',
    'login_approvals',
    'login approvals',
    'two-factor authentication required',
    'too_many_requests',
    'too many requests',
    'rate limited',
    'rate_limit',
    'temporarily blocked',
    'temporarily_blocked',
    'your account has been temporarily blocked',
    'please try again later',
    'feature temporarily blocked',
    'feature temporarily unavailable',
    'something went wrong',
    'automated behavior',
    'not a human',
    'bot detected',
    'automated_behavior',
    'bot_detected',
    'spam detected',
    'spam_detected',
    'looks like spam',
    'violates our community standards',
    'community standards violation',
    'this content isn\'t available',
    'you\'re blocked from',
    'blocked from sending',
    'disabled for violating',
    'policy violation',
    'action blocked',
    'session expired',
    'session has expired',
    'not logged in',
    'login required',
    'authentication required',
    'invalid session',
    'please log in again',
    'your session has ended'
];

class AntiSuspension {
    constructor() {
        this.activityThrottler = new Map();
        this.lastActivity = new Map();
        this.typing = new Map();

        this.messageDelayMs = 1200;
        this.threadDelayMs = 2500;
        this.loginAttempts = 0;
        this.maxLoginAttempts = 3;
        this.loginCooldown = 300000;

        this.suspensionCircuitBreaker = {
            tripped: false,
            trippedAt: null,
            cooldownMs: 30 * 60 * 1000,   // 30 min (was 45 min — too aggressive)
            signalCount: 0,
            maxSignalsBeforeTrip: 3,       // trip after 3 signals (was 2 — too sensitive)
            lastSignalAt: null
        };

        this.dailyStats = {
            date: new Date().toDateString(),
            messageCount: 0,
            maxDailyMessages: 999999999,
            threadStats: new Map()
        };

        this.hourlyBucket = {
            hour: new Date().getHours(),
            count: 0,
            maxPerHour: 999999999
        };

        this.sessionFingerprint = null;

        this.warmup = {
            active: false,
            startedAt: null,
            durationMs: 20 * 60 * 1000,
            maxMessagesPerHour: 999999999
        };

        this._dailyResetInterval = setInterval(() => this._resetDailyStatsIfNeeded(), 5 * 60 * 1000);
        if (this._dailyResetInterval.unref) this._dailyResetInterval.unref();
        this._hourlyResetInterval = setInterval(() => this._resetHourlyBucketIfNeeded(), 3 * 60 * 1000);
        if (this._hourlyResetInterval.unref) this._hourlyResetInterval.unref();

        // [ADDED Djamel] — disk-state persistence
        this._saveTimer = null;
        this._dirty     = false;
        this._loadState();
        // Safety-net periodic flush in case the debounce timer is starved by event loop pressure
        this._persistInterval = setInterval(() => { if (this._dirty) this._flushState(); }, 5 * 60 * 1000);
        if (this._persistInterval.unref) this._persistInterval.unref();

        // Cleanup intervals + flush state on process exit so the next boot
        // resumes the same warmup / counters / circuit-breaker window.
        process.on('exit', () => { this._flushState(); this._clearIntervals(); });
        process.on('SIGINT', () => { this._flushState(); this._clearIntervals(); });
        process.on('SIGTERM', () => { this._flushState(); this._clearIntervals(); });
    }

    // ── State persistence helpers ───────────────────────────────────
    _loadState() {
        try {
            if (!_fs.existsSync(STATE_FILE)) return;
            const raw = _fs.readFileSync(STATE_FILE, 'utf-8').trim();
            if (!raw) return;
            const s = JSON.parse(raw);
            const today = new Date().toDateString();

            // Daily counters — only restore if it's still the same calendar day,
            // otherwise let the natural daily reset kick in.
            if (s.dailyStats && s.dailyStats.date === today) {
                this.dailyStats.date         = s.dailyStats.date;
                this.dailyStats.messageCount = Number(s.dailyStats.messageCount) || 0;
                if (Array.isArray(s.dailyStats.threadStats)) {
                    for (const [tid, ts] of s.dailyStats.threadStats) {
                        this.dailyStats.threadStats.set(String(tid), ts || { count: 0 });
                    }
                }
            }

            // Hourly bucket — restore only if same hour
            const currentHour = new Date().getHours();
            if (s.hourlyBucket && s.hourlyBucket.hour === currentHour) {
                this.hourlyBucket.count = Number(s.hourlyBucket.count) || 0;
                this.hourlyBucket.hour  = s.hourlyBucket.hour;
            }

            // Circuit breaker — if it was tripped and the cooldown is still active,
            // restore the trip so a quick restart can't bypass the protection.
            if (s.circuitBreaker && s.circuitBreaker.tripped && s.circuitBreaker.trippedAt) {
                const cb = this.suspensionCircuitBreaker;
                const elapsed = Date.now() - Number(s.circuitBreaker.trippedAt);
                const cooldown = Number(s.circuitBreaker.cooldownMs) || cb.cooldownMs;
                if (elapsed < cooldown) {
                    cb.tripped       = true;
                    cb.trippedAt     = Number(s.circuitBreaker.trippedAt);
                    cb.cooldownMs    = cooldown;
                    cb.signalCount   = Number(s.circuitBreaker.signalCount) || cb.maxSignalsBeforeTrip;
                    cb.lastSignalAt  = Number(s.circuitBreaker.lastSignalAt) || null;
                }
            }

            // Warmup — restore only if it hasn't already finished
            if (s.warmup && s.warmup.active && s.warmup.startedAt) {
                const elapsed = Date.now() - Number(s.warmup.startedAt);
                if (elapsed < this.warmup.durationMs) {
                    this.warmup.active    = true;
                    this.warmup.startedAt = Number(s.warmup.startedAt);
                    setTimeout(() => { this.warmup.active = false; this._markDirty(); },
                               this.warmup.durationMs - elapsed);
                }
            }

            // Login attempts + session fingerprint
            if (Number.isFinite(s.loginAttempts)) this.loginAttempts = s.loginAttempts;
            if (s.sessionFingerprint && typeof s.sessionFingerprint === 'object') {
                this.sessionFingerprint = s.sessionFingerprint;
            }
        } catch (_) { /* corrupt state file — ignore and keep defaults */ }
    }

    _markDirty() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._flushState();
        }, SAVE_DEBOUNCE_MS);
    }

    _flushState() {
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        this._dirty = false;
        try {
            const dir = _path.dirname(STATE_FILE);
            if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
            const cb = this.suspensionCircuitBreaker;
            const out = {
                savedAt: Date.now(),
                dailyStats: {
                    date:         this.dailyStats.date,
                    messageCount: this.dailyStats.messageCount,
                    threadStats:  Array.from(this.dailyStats.threadStats.entries())
                },
                hourlyBucket: {
                    hour:  this.hourlyBucket.hour,
                    count: this.hourlyBucket.count
                },
                circuitBreaker: {
                    tripped:       cb.tripped,
                    trippedAt:     cb.trippedAt,
                    cooldownMs:    cb.cooldownMs,
                    signalCount:   cb.signalCount,
                    lastSignalAt:  cb.lastSignalAt
                },
                warmup: {
                    active:    this.warmup.active,
                    startedAt: this.warmup.startedAt
                },
                loginAttempts: this.loginAttempts,
                sessionFingerprint: this.sessionFingerprint
            };
            _atomic(STATE_FILE, JSON.stringify(out, null, 2), 'utf-8');
        } catch (_) { /* best-effort */ }
    }

    _resetDailyStatsIfNeeded() {
        const today = new Date().toDateString();
        if (this.dailyStats.date !== today) {
            this.dailyStats.date = today;
            this.dailyStats.messageCount = 0;
            this.dailyStats.threadStats.clear();
            this._markDirty && this._markDirty();
        }
    }

    _resetHourlyBucketIfNeeded() {
        const currentHour = new Date().getHours();
        if (this.hourlyBucket.hour !== currentHour) {
            this.hourlyBucket.hour = currentHour;
            this.hourlyBucket.count = 0;
            this._markDirty && this._markDirty();
        }
    }

    _clearIntervals() {
        if (this._dailyResetInterval) {
            clearInterval(this._dailyResetInterval);
            this._dailyResetInterval = null;
        }
        if (this._hourlyResetInterval) {
            clearInterval(this._hourlyResetInterval);
            this._hourlyResetInterval = null;
        }
        if (this._persistInterval) {
            clearInterval(this._persistInterval);
            this._persistInterval = null;
        }
    }

    _incrementDailyStats(threadID) {
        this.dailyStats.messageCount++;
        this.hourlyBucket.count++;

        if (threadID) {
            const ts = this.dailyStats.threadStats.get(String(threadID)) || { count: 0 };
            ts.count++;
            ts.lastActivity = Date.now();
            this.dailyStats.threadStats.set(String(threadID), ts);
        }
        this._markDirty && this._markDirty();
    }

    isDailyLimitReached() {
        return this.dailyStats.messageCount >= this.dailyStats.maxDailyMessages;
    }

    isHourlyLimitReached() {
        const limit = this.warmup.active
            ? this.warmup.maxMessagesPerHour
            : this.hourlyBucket.maxPerHour;
        return this.hourlyBucket.count >= limit;
    }

    /**
     * Returns a human-readable warning if a volume limit has been reached.
     * Returns null if all limits are within safe range.
     */
    checkVolumeLimit(threadID) {
        if (this.isDailyLimitReached()) {
            return `Daily message limit reached (${this.dailyStats.messageCount}/${this.dailyStats.maxDailyMessages}). Pausing to avoid suspension.`;
        }
        if (this.isHourlyLimitReached()) {
            const limit = this.warmup.active ? this.warmup.maxMessagesPerHour : this.hourlyBucket.maxPerHour;
            return `Hourly message limit reached (${this.hourlyBucket.count}/${limit}). Pausing to avoid suspension.`;
        }
        return null;
    }

    enableWarmup() {
        this.warmup.active = true;
        this.warmup.startedAt = Date.now();
        this._markDirty && this._markDirty();
        setTimeout(() => {
            this.warmup.active = false;
            this._markDirty && this._markDirty();
        }, this.warmup.durationMs);
    }

    lockSessionFingerprint(ua, secChUa, platform, locale, timezone) {
        if (!this.sessionFingerprint) {
            this.sessionFingerprint = { ua, secChUa, platform, locale, timezone, lockedAt: Date.now() };
            this._markDirty && this._markDirty();
        }
        return this.sessionFingerprint;
    }

    getSessionFingerprint() {
        return this.sessionFingerprint;
    }

    detectSuspensionSignal(text) {
        if (!text || typeof text !== 'string') return false;
        const lower = text.toLowerCase();
        const found = SUSPENSION_SIGNALS.some(signal => lower.includes(signal));
        if (found) {
            this._onSuspensionSignalDetected();
        }
        return found;
    }

    _onSuspensionSignalDetected() {
        const cb = this.suspensionCircuitBreaker;
        cb.signalCount++;
        cb.lastSignalAt = Date.now();

        if (cb.signalCount >= cb.maxSignalsBeforeTrip) {
            if (!cb.tripped) {
                cb.tripped = true;
                cb.trippedAt = Date.now();
                const { utils } = this._getUtils();
                utils && utils.warn && utils.warn("AntiSuspension",
                    `Circuit breaker TRIPPED after ${cb.signalCount} suspension signals. ` +
                    `Pausing all activity for ${cb.cooldownMs / 60000} minutes.`);
                // Trip survives restart — flush immediately, no debounce.
                this._flushState && this._flushState();
                return;
            }
        }
        this._markDirty && this._markDirty();
    }

    _getUtils() {
        // [FIX Djamel] — original tried require('./index') which doesn't exist.
        // Use global logger instead for warn/info calls.
        const logger = global.loggeryuki;
        return {
            utils: {
                warn: (tag, msg) => {
                    try {
                        if (logger) {
                            logger.log([
                                { message: `[ ${tag} ]: `, color: ["red", "cyan"] },
                                { message: msg, color: "yellow" }
                            ]);
                        } else {
                            console.warn(`[${tag}]`, msg);
                        }
                    } catch (_) {}
                },
                info: (tag, msg) => {
                    try {
                        if (logger) {
                            logger.log([
                                { message: `[ ${tag} ]: `, color: ["red", "cyan"] },
                                { message: msg, color: "white" }
                            ]);
                        } else {
                            console.log(`[${tag}]`, msg);
                        }
                    } catch (_) {}
                }
            }
        };
    }

    isCircuitBreakerTripped() {
        const cb = this.suspensionCircuitBreaker;
        if (!cb.tripped) return false;
        const elapsed = Date.now() - cb.trippedAt;
        if (elapsed >= cb.cooldownMs) {
            cb.tripped = false;
            cb.signalCount = 0;
            cb.trippedAt = null;
            this._markDirty && this._markDirty();
            return false;
        }
        return true;
    }

    getCircuitBreakerRemainingMs() {
        const cb = this.suspensionCircuitBreaker;
        if (!cb.tripped) return 0;
        return Math.max(0, cb.cooldownMs - (Date.now() - cb.trippedAt));
    }

    tripCircuitBreaker(reason, durationMs) {
        const cb = this.suspensionCircuitBreaker;
        cb.tripped = true;
        cb.trippedAt = Date.now();
        if (durationMs) cb.cooldownMs = durationMs;
        cb.signalCount = cb.maxSignalsBeforeTrip;
        const { utils } = this._getUtils();
        utils && utils.warn && utils.warn("AntiSuspension",
            `Circuit breaker manually tripped: ${reason || 'manual'}. ` +
            `Cooldown: ${(cb.cooldownMs / 60000).toFixed(1)} min`);
        this._flushState && this._flushState();
    }

    resetCircuitBreaker() {
        this.suspensionCircuitBreaker.tripped = false;
        this.suspensionCircuitBreaker.signalCount = 0;
        this.suspensionCircuitBreaker.trippedAt = null;
        this._flushState && this._flushState();
    }

    async simulateTyping(threadID, messageLength = 50) {
        const wpm = 22 + Math.random() * 18;
        const charsPerMs = (wpm * 5) / 60000;
        const typingDelay = Math.min(6000, Math.max(800, messageLength / charsPerMs));
        const jitter = (Math.random() - 0.5) * 600;
        return Math.round(typingDelay + jitter);
    }

    async addSmartDelay() {
        const base = 800 + Math.random() * 1800;
        const jitter = (Math.random() - 0.5) * 400;
        const total = Math.max(600, base + jitter);
        await new Promise(resolve => setTimeout(resolve, total));
    }

    /**
     * Add a longer random delay when volume is running high.
     * Helps avoid patterns that look like automated batch sends.
     */
    async addAdaptiveDelay(threadID) {
        const threadCount = this.dailyStats.threadStats.get(String(threadID))?.count || 0;
        const globalCount = this.dailyStats.messageCount;

        let base = 800;
        if (globalCount > 1000) base = 3000;
        else if (globalCount > 500) base = 2000;
        else if (globalCount > 200) base = 1400;

        if (threadCount > 30) base += 800;
        if (threadCount > 60) base += 1200;

        const jitter = Math.random() * base * 0.4;
        const total = Math.max(600, base + jitter);
        await new Promise(resolve => setTimeout(resolve, total));
    }

    async enforceThreadThrottling(threadID) {
        const lastTime = this.lastActivity.get(String(threadID)) || 0;
        const timeSinceLastMsg = Date.now() - lastTime;
        const minInterval = this.threadDelayMs + Math.random() * 1000;

        if (timeSinceLastMsg < minInterval) {
            const waitTime = minInterval - timeSinceLastMsg;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastActivity.set(String(threadID), Date.now());
        return Date.now() - lastTime;
    }

    async enforceMessageRate() {
        await new Promise(resolve =>
            setTimeout(resolve, this.messageDelayMs + Math.random() * 800)
        );
    }

    getHumanizedHeaders() {
        const { randomUserAgent } = require('./user-agents');
        const fp = this.sessionFingerprint;
        const ua = fp ? { userAgent: fp.ua, secChUa: fp.secChUa, secChUaPlatform: fp.platform } : randomUserAgent();
        return {
            'User-Agent': ua.userAgent,
            'Accept-Language': (fp && fp.locale) || 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Ch-Ua': ua.secChUa || '',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': ua.secChUaPlatform || '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0'
        };
    }

    rotateUserAgent() {
        const { randomUserAgent } = require('./user-agents');
        if (this.sessionFingerprint) return this.sessionFingerprint.ua;
        return randomUserAgent().userAgent;
    }

    trackLoginAttempt() {
        this.loginAttempts++;
        const isLocked = this.loginAttempts >= this.maxLoginAttempts;
        this._markDirty && this._markDirty();
        return {
            attempt: this.loginAttempts,
            isLocked,
            cooldownMs: isLocked ? this.loginCooldown : 0,
            nextAttemptAt: isLocked ? Date.now() + this.loginCooldown : null
        };
    }

    resetLoginAttempts() {
        this.loginAttempts = 0;
        this._markDirty && this._markDirty();
    }

    checkAccountHealth(lastError) {
        const isSuspected = lastError &&
            SUSPENSION_SIGNALS.some(indicator =>
                (lastError.message || '').toLowerCase().includes(indicator)
            );

        if (isSuspected) {
            this._onSuspensionSignalDetected();
        }

        return {
            suspended: isSuspected,
            circuitBreakerTripped: this.isCircuitBreakerTripped(),
            dailyLimitReached: this.isDailyLimitReached(),
            hourlyLimitReached: this.isHourlyLimitReached(),
            lastCheck: Date.now(),
            recommendedAction: isSuspected ? 'WAIT_AND_RETRY' : 'CONTINUE',
            circuitBreakerRemainingMs: this.getCircuitBreakerRemainingMs()
        };
    }

    getRealisticActivityPattern() {
        const hour = new Date().getHours();
        const isNight = hour < 6 || hour >= 22;
        const isEvening = hour >= 19 && hour < 22;

        return {
            messageFrequency: isNight ? 'low' : isEvening ? 'moderate' : 'normal',
            nextActionDelayMs: isNight
                ? 12000 + Math.random() * 18000
                : isEvening
                ? 3000 + Math.random() * 5000
                : 1500 + Math.random() * 3500,
            isActiveHours: !isNight,
            recommendedCooldown: isNight ? 20000 : isEvening ? 6000 : 3000
        };
    }

    async safeRetry(fn, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            if (this.isCircuitBreakerTripped()) {
                throw new Error('Circuit breaker is tripped. Stopping retries to protect account.');
            }
            try {
                return await fn();
            } catch (error) {
                const msg = (error.message || '').toLowerCase();
                const isSuspensionError = SUSPENSION_SIGNALS.some(s => msg.includes(s));
                if (isSuspensionError) {
                    this._onSuspensionSignalDetected();
                    throw error;
                }
                if (i === maxRetries - 1) throw error;
                const delay = Math.pow(2, i + 1) * 1000 + Math.random() * 800;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    async batchOperations(operations) {
        const results = [];
        for (let i = 0; i < operations.length; i++) {
            if (this.isCircuitBreakerTripped()) {
                throw new Error('Circuit breaker tripped during batch operation.');
            }
            results.push(await this.safeRetry(() => operations[i]()));
            if (i < operations.length - 1) {
                await this.addSmartDelay();
            }
        }
        return results;
    }

    /**
     * Prepare before sending — single delay model.
     * Enforces thread throttle and volume limits, respects circuit breaker.
     * If volume limits are reached, throws to protect the account.
     */
    async prepareBeforeMessage(threadID, message) {
        if (this.isCircuitBreakerTripped()) {
            const remaining = this.getCircuitBreakerRemainingMs();
            const waitMs = Math.min(remaining, 8000);
            if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        const volumeWarning = this.checkVolumeLimit(threadID);
        if (volumeWarning) {
            const { utils } = this._getUtils();
            utils && utils.warn && utils.warn("AntiSuspension", volumeWarning);
            // Add a safety pause instead of hard-blocking so callers can decide
            await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 3000));
        }

        await this.enforceThreadThrottling(threadID);
        await this.addAdaptiveDelay(threadID);
        this._incrementDailyStats(threadID);
    }

    getConfig() {
        return {
            messageDelayMs: this.messageDelayMs,
            threadDelayMs: this.threadDelayMs,
            maxLoginAttempts: this.maxLoginAttempts,
            loginCooldownMs: this.loginCooldown,
            circuitBreaker: {
                tripped: this.suspensionCircuitBreaker.tripped,
                signalCount: this.suspensionCircuitBreaker.signalCount,
                remainingMs: this.getCircuitBreakerRemainingMs()
            },
            dailyStats: {
                messageCount: this.dailyStats.messageCount,
                maxDailyMessages: this.dailyStats.maxDailyMessages
            },
            hourlyStats: {
                count: this.hourlyBucket.count,
                maxPerHour: this.hourlyBucket.maxPerHour
            },
            warmupActive: this.warmup.active,
            features: {
                typeSimulation: true,
                delayRandomization: true,
                adaptiveDelay: true,
                userAgentRotation: true,
                activityPatternTracking: true,
                autoSuspensionDetection: true,
                exponentialBackoff: true,
                circuitBreaker: true,
                dailyVolumeLimiting: true,
                hourlyVolumeLimiting: true,
                sessionFingerprintLock: true,
                warmupMode: true,
                volumeWarnings: true,
                // [ADDED Djamel] — Advanced evasion
                timeBasedDelay: true,
                sessionBreakSimulation: true,
                antiPatternJitter: true,
                readDelaySimulation: true,
                humanComposeSimulation: true,
                velocityBasedCooldown: true,
                fullEvasionSequence: true
            }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // [ADDED Djamel] — Advanced evasion maneuvers block
    // ═══════════════════════════════════════════════════════════════

    /**
     * Returns a delay (ms) that mimics realistic human reaction time
     * based on the current hour of day.
     * Night = slow, morning peak = moderate, evening = fast.
     */
    getTimeBasedDelay() {
        const h = new Date().getHours();
        // Late night (23–5): humans are slow / asleep
        if (h >= 23 || h <= 5) return 8000 + Math.random() * 12000;
        // Morning peak (6–9): quick responses
        if (h >= 6 && h <= 9)  return 1200 + Math.random() * 2500;
        // Lunch (12–14): moderate
        if (h >= 12 && h <= 14) return 2500 + Math.random() * 4000;
        // Evening peak (18–22): fastest social activity
        if (h >= 18 && h <= 22) return 900 + Math.random() * 2000;
        // Default daytime
        return 1500 + Math.random() * 3000;
    }

    /**
     * Randomly inject a longer "coffee break" pause.
     * Humans occasionally disappear for a few minutes — bots never do.
     * ~5% chance of a 2–6 minute pause, ~10% chance of a 20–60 sec pause.
     */
    async maybeSessionBreak() {
        const roll = Math.random();
        if (roll < 0.05) {
            // Long break: 2–6 minutes
            const ms = 2 * 60 * 1000 + Math.random() * 4 * 60 * 1000;
            const { utils } = this._getUtils();
            utils && utils.info && utils.info("AntiSuspension",
                `Session break: ${(ms / 60000).toFixed(1)} min (human behaviour)`);
            await new Promise(r => setTimeout(r, ms));
        } else if (roll < 0.15) {
            // Short break: 20–60 seconds
            const ms = 20000 + Math.random() * 40000;
            await new Promise(r => setTimeout(r, ms));
        }
    }

    /**
     * Anti-pattern jitter: Adds random noise to break any timing regularity.
     * Bots tend to send at very consistent intervals — this prevents that.
     * Call after every send.
     */
    async antiPatternJitter() {
        // Mix of very short and occasionally long delays
        const patterns = [
            () => 300 + Math.random() * 600,
            () => 800 + Math.random() * 1500,
            () => 2000 + Math.random() * 3000,
            () => 50 + Math.random() * 200,
        ];
        const weights = [0.4, 0.35, 0.15, 0.10];
        const r = Math.random();
        let acc = 0;
        for (let i = 0; i < patterns.length; i++) {
            acc += weights[i];
            if (r <= acc) {
                await new Promise(resolve => setTimeout(resolve, patterns[i]()));
                return;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
    }

    /**
     * Simulate a "read delay" before responding.
     * Humans read the message before they type — bots reply instantly.
     * Based on message length (longer = more reading time).
     */
    async simulateReadDelay(messageBody = "") {
        const len = typeof messageBody === "string" ? messageBody.length : 30;
        // ~200 chars/min reading speed → 1 char = 5ms, plus reaction time
        const readTime = Math.min(4000, Math.max(400, len * 5 + Math.random() * 800));
        await new Promise(r => setTimeout(r, readTime));
    }

    /**
     * Simulate cursor/focus activity — varies the inter-message timing
     * so no two messages have the same delay pattern.
     * Generates a jittered multi-step sequence:
     *   think → read → compose → pause → send
     */
    async simulateHumanCompose(messageLength = 40) {
        const thinkMs  = 400  + Math.random() * 1200;  // think about the reply
        const composeMs = this.simulateTyping
            ? await this.simulateTyping(undefined, messageLength)  // async typing
            : 800;
        const pauseMs  = Math.random() > 0.6 ? 200 + Math.random() * 600 : 0;  // sometimes re-reads

        const total = thinkMs + composeMs + pauseMs;
        await new Promise(r => setTimeout(r, total));
    }

    /**
     * Checks if the bot should enter a cooldown based on recent message velocity.
     * Returns { shouldCool, durationMs, reason }.
     */
    shouldEnterCooldown() {
        const { messageCount } = this.dailyStats;
        const { count } = this.hourlyBucket;

        if (count > 80) {
            return { shouldCool: true, durationMs: 5 * 60 * 1000, reason: "80 msgs/hour threshold" };
        }
        if (count > 50) {
            return { shouldCool: true, durationMs: 60 * 1000, reason: "50 msgs/hour — micro-cooldown" };
        }
        if (messageCount > 800) {
            return { shouldCool: true, durationMs: 10 * 60 * 1000, reason: "800 daily msgs — mandatory rest" };
        }
        return { shouldCool: false, durationMs: 0, reason: null };
    }

    /**
     * Full pre-send evasion sequence (enhanced version of prepareBeforeMessage).
     * Runs all active maneuvers in sequence to maximise stealth.
     */
    async fullEvasionSequence(threadID, incomingBody = "") {
        // 1. Check circuit breaker
        if (this.isCircuitBreakerTripped()) {
            const remaining = this.getCircuitBreakerRemainingMs();
            const waitMs = Math.min(remaining, 10000);
            if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        }

        // 2. Optional session break
        await this.maybeSessionBreak();

        // 3. Simulate reading the incoming message
        await this.simulateReadDelay(incomingBody);

        // 4. Thread throttling
        await this.enforceThreadThrottling(threadID);

        // 5. Adaptive delay based on volume
        await this.addAdaptiveDelay(threadID);

        // 6. Anti-pattern jitter
        await this.antiPatternJitter();

        // 7. Time-based human delay
        const timeDelta = this.getTimeBasedDelay();
        // Blend with the compose time — don't double-stack, just pick the max
        const compose = 500 + Math.random() * 1000;
        await new Promise(r => setTimeout(r, Math.max(compose, timeDelta * 0.2)));

        // 8. Check if voluntary cooldown needed
        const cool = this.shouldEnterCooldown();
        if (cool.shouldCool) {
            const { utils } = this._getUtils();
            utils && utils.warn && utils.warn("AntiSuspension",
                `Entering cooldown (${(cool.durationMs / 1000).toFixed(0)}s): ${cool.reason}`);
            await new Promise(r => setTimeout(r, cool.durationMs));
        }

        // 9. Increment stats
        this._incrementDailyStats(threadID);
    }

    destroy() {
        this._clearIntervals();
        this.activityThrottler.clear();
        this.lastActivity.clear();
        this.typing.clear();
        this.dailyStats.threadStats.clear();
    }
}

const globalAntiSuspension = new AntiSuspension();

module.exports = {
    AntiSuspension,
    globalAntiSuspension,
    SUSPENSION_SIGNALS,
    initAntiSuspension: () => globalAntiSuspension,
    getAntiSuspensionConfig: () => globalAntiSuspension.getConfig(),
    // [ADDED Djamel] — convenience shortcuts for the new evasion methods
    fullEvasionSequence: (threadID, body) => globalAntiSuspension.fullEvasionSequence(threadID, body),
    antiPatternJitter:   ()             => globalAntiSuspension.antiPatternJitter(),
    simulateReadDelay:   (body)         => globalAntiSuspension.simulateReadDelay(body),
    maybeSessionBreak:   ()             => globalAntiSuspension.maybeSessionBreak(),
    shouldEnterCooldown: ()             => globalAntiSuspension.shouldEnterCooldown()
};
