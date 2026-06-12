module.exports = function (input) {
        const force = false;

        const Users = require("./models/users")(input);
        const Threads = require("./models/threads")(input);
        const Currencies = require("./models/currencies")(input);

        // [FIX DB-BOOT] — The original fire-and-forget .sync() calls ran immediately
        // at module load time, competing with the login flow for thread-pool slots.
        // SQLite serializes writers, so all three syncs retry on SQLITE_BUSY — each
        // retry generates Promise microtasks that starve timers (setTimeout) and DNS
        // callbacks, causing the entire login flow to stall indefinitely.
        //
        // Fix: defer the sync calls by 15 seconds so the login flow (DNS + Facebook
        // HTTP) can complete before any DB thread-pool work begins.
        // The tables already exist (data.sqlite is present) so the sync is a no-op
        // on every run after the first — the 15 s delay has no practical cost.
        setTimeout(() => {
                Users.sync({ force }).catch(() => {});
                Threads.sync({ force }).catch(() => {});
                Currencies.sync({ force }).catch(() => {});
        }, 15000);

        return {
                model: {
                        Users,
                        Threads,
                        Currencies
                },
                use: function (modelName) {
                        return this.model[`${modelName}`];
                }
        }
}
