module.exports = async function () {
        const { Sequelize } = require("sequelize");
        const fs = require("fs");
        // [FIX DB-BOOT] — "host:" is wrong for SQLite; the correct key is "storage:".
        // Using "host:" caused Sequelize to ignore the file path and default to
        // an in-memory database, so all thread and user data was lost on restart.
        const storagePath = __dirname + "/../data/data.sqlite";
        const sequelize = new Sequelize({
                dialect: "sqlite",
                storage: storagePath,
                logging: false
        });

        const threadModel = require("../models/sqlite/thread.js")(sequelize);
        const userModel = require("../models/sqlite/user.js")(sequelize);
        const globalModel = require("../models/sqlite/global.js")(sequelize);

        // [FIX DB-BOOT] — await sequelize.sync() uses the libuv thread pool to open
        // the SQLite file. When other heavy modules (googleapis, sqlite3 model syncs)
        // have already queued thread pool work, this await stalls indefinitely.
        //
        // Fix: if the file already exists the tables are present — skip sync.
        // If the file is brand-new, run sync() fire-and-forget; the models will
        // be ready by the time the first real query arrives (milliseconds later).
        if (!fs.existsSync(storagePath)) {
                console.log("[DB] DB/data/data.sqlite not found — running initial sync (fire-and-forget).");
                sequelize.sync({ force: false }).catch(err => {
                        console.error("[DB] connectSqlite initial sync error:", err && err.message);
                });
        }
        // File exists — tables are already there, no sync needed.

        return {
                threadModel,
                userModel,
                globalModel
        };
};
