const { existsSync, writeJsonSync, readJSONSync } = require("fs-extra");
const moment = require("moment-timezone");
const path = require("path");
const _ = require("lodash");
const { CustomError } = global.utils;
// [FIX Djamel] — atomic JSON writes (see usersData.js for rationale).
const { atomicWriteJsonSync } = (() => {
        try { return require("../../utils/atomicWrite"); }
        catch (_) { return { atomicWriteJsonSync: writeJsonSync }; }
})();
const optionsWriteJSON = {
        spaces: 2,
        EOL: "\n"
};

const messageQueue = global.utils.createQueue(async (task, callback) => {
        try {
                const result = await task();
                callback(null, result);
        }
        catch (err) {
                callback(err);
        }
});

const { creatingThreadData } = global.DBYUKI.database;

module.exports = async function (databaseType, threadModel, api, fakeGraphql) {
        let Threads = [];
        const pathThreadsData = path.join(__dirname, "..", "data/threadsData.json");

        switch (databaseType) {
                case "mongodb": {
                        // delete keys '_id' and '__v' in all threads
                        Threads = (await threadModel.find({}).lean()).map(thread => _.omit(thread, ["_id", "__v"]));
                        break;
                }
                case "sqlite": {
                        Threads = (await threadModel.findAll()).map(thread => thread.get({ plain: true }));
                        break;
                }
                case "json": {
                        if (!existsSync(pathThreadsData))
                                atomicWriteJsonSync(pathThreadsData, [], optionsWriteJSON);
                        Threads = readJSONSync(pathThreadsData);
                        break;
                }
        }

        global.db.allThreadData = Threads;

        async function save(threadID, threadData, mode, path) {
                try {
                        let index = _.findIndex(global.db.allThreadData, { threadID });
                        if (index === -1 && mode === "update") {
                                try {
                                        await create_(threadID);
                                        index = _.findIndex(global.db.allThreadData, { threadID });
                                }
                                catch (err) {
                                        throw new CustomError({
                                                name: "THREAD_NOT_EXIST",
                                                message: `Can't find thread with threadID: ${threadID} in database`
                                        });
                                }
                        }

                        switch (mode) {
                                case "create": {
                                        switch (databaseType) {
                                                case "mongodb":
                                                case "sqlite": {
                                                        let dataCreated = await threadModel.create(threadData);
                                                        dataCreated = databaseType == "mongodb" ?
                                                                _.omit(dataCreated._doc, ["_id", "__v"]) :
                                                                dataCreated.get({ plain: true });
                                                        global.db.allThreadData.push(dataCreated);
                                                        return _.cloneDeep(dataCreated);
                                                }
                                                case "json": {
                                                        const timeCreate = moment.tz().format();
                                                        threadData.createdAt = timeCreate;
                                                        threadData.updatedAt = timeCreate;
                                                        global.db.allThreadData.push(threadData);
                                                        atomicWriteJsonSync(pathThreadsData, global.db.allThreadData, optionsWriteJSON);
                                                        return _.cloneDeep(threadData);
                                                }
                                                default: {
                                                        break;
                                                }
                                        }
                                        break;
                                }
                                case "update": {
                                        const oldThreadData = global.db.allThreadData[index];
                                        const dataWillChange = {};

                                        if (Array.isArray(path) && Array.isArray(threadData)) {
                                                path.forEach((p, index) => {
                                                        const key = p.split(".")[0];
                                                        dataWillChange[key] = oldThreadData[key];
                                                        _.set(dataWillChange, p, threadData[index]);
                                                });
                                        }
                                        else
                                                if (path && typeof path === "string" || Array.isArray(path)) {
                                                        const key = Array.isArray(path) ? path[0] : path.split(".")[0];
                                                        dataWillChange[key] = oldThreadData[key];
                                                        _.set(dataWillChange, path, threadData);
                                                }
                                                else
                                                        for (const key in threadData)
                                                                dataWillChange[key] = threadData[key];

                                        switch (databaseType) {
                                                case "mongodb": {
                                                        // [FIX H5] — `returnDocument: 'after'` is a MongoDB driver option;
                                                        // Mongoose uses `{ new: true }` for the same semantics. Using the
                                                        // wrong key could silently return the pre-update document or null,
                                                        // then crash on `dataUpdated._doc`. Added null guard to be safe.
                                                        let dataUpdated = await threadModel.findOneAndUpdate({ threadID }, dataWillChange, { new: true });
                                                        if (!dataUpdated) throw new Error(`Thread ${threadID} not found during update`);
                                                        dataUpdated = _.omit(dataUpdated._doc || dataUpdated.toObject?.() || dataUpdated, ["_id", "__v"]);
                                                        global.db.allThreadData[index] = dataUpdated;
                                                        return _.cloneDeep(dataUpdated);
                                                }
                                                case "sqlite": {
                                                        // [FIX M3] — wrap findOne + update in a Sequelize transaction so a
                                                        // mid-sequence crash cannot leave the DB and in-memory state diverged.
                                                        const dataUpdated = await threadModel.sequelize.transaction(async (t) => {
                                                                const thread = await threadModel.findOne({ where: { threadID }, transaction: t });
                                                                return (await thread.update(dataWillChange, { transaction: t })).get({ plain: true });
                                                        });
                                                        global.db.allThreadData[index] = dataUpdated;
                                                        return _.cloneDeep(dataUpdated);
                                                }
                                                case "json": {
                                                        dataWillChange.updatedAt = moment.tz().format();
                                                        global.db.allThreadData[index] = {
                                                                ...oldThreadData,
                                                                ...dataWillChange
                                                        };
                                                        atomicWriteJsonSync(pathThreadsData, global.db.allThreadData, optionsWriteJSON);
                                                        return _.cloneDeep(global.db.allThreadData[index]);
                                                }
                                                default:
                                                        break;
                                        }
                                        break;
                                }
                                case "delete": {
                                        if (index != -1) {
                                                global.db.allThreadData.splice(index, 1);
                                                switch (databaseType) {
                                                        case "mongodb":
                                                                await threadModel.deleteOne({ threadID });
                                                                break;
                                                        case "sqlite":
                                                                await threadModel.destroy({ where: { threadID } });
                                                                break;
                                                        case "json":
                                                                atomicWriteJsonSync(pathThreadsData, global.db.allThreadData, optionsWriteJSON);
                                                                break;
                                                        default:
                                                                break;
                                                }
                                        }
                                        break;
                                }
                                default: {
                                        break;
                                }
                        }
                        return null;
                }
                catch (err) {
                        throw err;
                }
        }

        async function create_(threadID, threadInfo) {
                return new Promise(async function (resolve, reject) {
                        const findInCreatingData = creatingThreadData.find(t => t.threadID == threadID);
                        if (findInCreatingData)
                                return resolve(findInCreatingData.promise);

                        const queue = new Promise(async function (resolve_, reject_) {
                                try {
                                        if (global.db.allThreadData.some(t => t.threadID == threadID)) {
                                                throw new CustomError({
                                                        name: "DATA_ALREADY_EXISTS",
                                                        message: `Thread with id "${threadID}" already exists in the data`
                                                });
                                        }
                                        if (isNaN(threadID)) {
                                                throw new CustomError({
                                                        name: "INVALID_THREAD_ID",
                                                        message: `The first argument (threadID) must be a number, not a ${typeof threadID}`
                                                });
                                        }
                                        // [FIX Djamel] — was: fallback to a hardcoded thread JSON when
                                        // getThreadInfo returned null. That hardcoded blob has
                                        // threadID "6540332652744904", static members and admins, so
                                        // EVERY new thread that failed lookup got saved with that wrong
                                        // data, permanently poisoning the DB. Throw a typed error instead
                                        // so the caller can retry — handleCreateDatabase already removes
                                        // the threadID from allThreadID on throw, so the next message
                                        // will retry cleanly.
                                        threadInfo = threadInfo || await api.getThreadInfo(threadID);
                                        if (!threadInfo || typeof threadInfo !== "object" || !threadInfo.threadID) {
                                                throw new CustomError({
                                                        name: "THREAD_INFO_UNAVAILABLE",
                                                        message: `Could not fetch thread info for "${threadID}" from Facebook (will retry on next event)`
                                                });
                                        }
                                        // Defensive defaults for fields we touch below — Facebook
                                        // sometimes omits adminIDs / nicknames on rare thread types.
                                        threadInfo.adminIDs    = Array.isArray(threadInfo.adminIDs) ? threadInfo.adminIDs : [];
                                        threadInfo.userInfo    = Array.isArray(threadInfo.userInfo) ? threadInfo.userInfo : [];
                                        threadInfo.nicknames   = (threadInfo.nicknames && typeof threadInfo.nicknames === "object") ? threadInfo.nicknames : {};

                                        // [Removed Djamel] — Hardcoded fallback blob deleted.
                                        const { threadName, userInfo, adminIDs } = threadInfo;
                                        const newAdminsIDs = adminIDs.reduce(function (_, b) {
                                                _.push(b.id);
                                                return _;
                                        }, []);

                                        const newMembers = userInfo.reduce(function (arr, user) {
                                                const userID = user.id;
                                                arr.push({
                                                        userID,
                                                        name: user.name,
                                                        gender: user.gender,
                                                        nickname: threadInfo.nicknames[userID] || null,
                                                        inGroup: true,
                                                        count: 0,
                                                        permissionConfigDashboard: false
                                                });
                                                return arr;
                                        }, []);

                                        let threadData = {
                                                threadID,
                                                threadName,
                                                threadThemeID: threadInfo.threadTheme?.id || null,
                                                emoji: threadInfo.emoji,
                                                adminIDs: newAdminsIDs,
                                                imageSrc: threadInfo.imageSrc,
                                                approvalMode: threadInfo.approvalMode,
                                                members: newMembers,
                                                banned: {},
                                                settings: {
                                                        sendWelcomeMessage: true,
                                                        sendLeaveMessage: true,
                                                        sendRankupMessage: false,
                                                        customCommand: true
                                                },
                                                data: {},
                                                isGroup: threadInfo.threadType == 2
                                        };
                                        threadData = await save(threadID, threadData, "create");
                                        resolve_(_.cloneDeep(threadData));
                                }
                                catch (err) {
                                        reject_(err);
                                }
                                // [FIX Djamel] — guard splice: findIndex returns -1 if not found,
                                // and splice(-1, 1) wrongly removes the LAST element of the queue.
                                const _idx = creatingThreadData.findIndex(t => t.threadID == threadID);
                                if (_idx !== -1) creatingThreadData.splice(_idx, 1);
                        });
                        creatingThreadData.push({
                                threadID,
                                promise: queue
                        });
                        return resolve(queue);
                });
        }

        async function create(threadID, threadInfo) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        return resolve(await create_(threadID, threadInfo));
                                }
                                catch (err) {
                                        return reject(err);
                                }
                        });
                });
        }

        async function refreshInfo(threadID, newThreadInfo) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(threadID)) {
                                                reject(new CustomError({
                                                        name: "INVALID_THREAD_ID",
                                                        message: `The first argument (threadID) must be a number, not a ${typeof threadID}`
                                                }));
                                        }
                                        const threadInfo = await get_(threadID);
                                        newThreadInfo = newThreadInfo || await api.getThreadInfo(threadID);
                                        if (!newThreadInfo || typeof newThreadInfo !== "object") {
                                                throw new Error(`getThreadInfo returned null/undefined for threadID=${threadID}`);
                                        }
                                        const { userInfo, adminIDs, nicknames } = newThreadInfo;
                                        let oldMembers = threadInfo.members;
                                        const newMembers = [];
                                        for (const user of userInfo) {
                                                const userID = user.id;
                                                const indexUser = _.findIndex(oldMembers, { userID });
                                                const oldDataUser = oldMembers[indexUser] || {};
                                                const data = {
                                                        userID,
                                                        ...oldDataUser,
                                                        name: user.name,
                                                        gender: user.gender,
                                                        nickname: nicknames[userID] || null,
                                                        inGroup: true,
                                                        count: oldDataUser.count || 0,
                                                        permissionConfigDashboard: oldDataUser.permissionConfigDashboard || false
                                                };
                                                indexUser != -1 ? oldMembers[indexUser] = data : oldMembers.push(data);
                                                newMembers.push(oldMembers.splice(indexUser != -1 ? indexUser : oldMembers.length - 1, 1)[0]);
                                        }
                                        oldMembers = oldMembers.map(user => {
                                                user.inGroup = false;
                                                return user;
                                        });
                                        const newAdminsIDs = adminIDs.reduce(function (acc, cur) {
                                                acc.push(cur.id);
                                                return acc;
                                        }, []);
                                        let threadData = {
                                                ...threadInfo,
                                                threadName: newThreadInfo.threadName,
                                                threadThemeID: newThreadInfo.threadTheme?.id || null,
                                                emoji: newThreadInfo.emoji,
                                                adminIDs: newAdminsIDs,
                                                imageSrc: newThreadInfo.imageSrc,
                                                members: [
                                                        ...oldMembers,
                                                        ...newMembers
                                                ]
                                        };

                                        threadData = await save(threadID, threadData, "update");
                                        return resolve(_.cloneDeep(threadData));
                                }
                                catch (err) {
                                        return reject(err);
                                }
                        });
                });
        }

        function getAll(path, defaultValue, query) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        let dataReturn = _.cloneDeep(global.db.allThreadData);

                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The third argument (query) must be a string, not a ${typeof query}`);
                                                else
                                                        dataReturn = dataReturn.map(tData => fakeGraphql(query, tData));

                                        if (path)
                                                if (!["string", "object"].includes(typeof path))
                                                        throw new Error(`The first argument (path) must be a string or an object, not a ${typeof path}`);
                                                else
                                                        if (typeof path === "string")
                                                                return resolve(dataReturn.map(tData => _.get(tData, path, defaultValue)));
                                                        else
                                                                return resolve(dataReturn.map(tData => _.times(path.length, i => _.get(tData, path[i], defaultValue[i]))));

                                        return resolve(dataReturn);
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function get_(threadID, path, defaultValue, query) {
                return new Promise(async function (resolve, reject) {
                        try {
                                if (isNaN(threadID)) {
                                        throw new CustomError({
                                                name: "INVALID_THREAD_ID",
                                                message: `The first argument (threadID) must be a number, not a ${typeof threadID}`
                                        });
                                }
                                let threadData;

                                const index = global.db.allThreadData.findIndex(t => t.threadID == threadID);
                                if (index === -1)
                                        threadData = await create_(threadID);
                                else
                                        threadData = global.db.allThreadData[index];

                                if (query)
                                        if (typeof query != "string")
                                                throw new Error(`The fourth argument (query) must be a string, not a ${typeof query}`);
                                        else
                                                threadData = fakeGraphql(query, threadData);

                                if (path)
                                        if (!["string", "object"].includes(typeof path))
                                                throw new Error(`The second argument (path) must be a string or an object, not a ${typeof path}`);
                                        else
                                                if (typeof path === "string")
                                                        return resolve(_.cloneDeep(_.get(threadData, path, defaultValue)));
                                                else
                                                        return resolve(_.cloneDeep(_.times(path.length, i => _.get(threadData, path[i], defaultValue[i]))));

                                return resolve(_.cloneDeep(threadData));
                        }
                        catch (err) {
                                reject(err);
                        }
                });
        }

        async function get(threadID, path, defaultValue, query) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        return resolve(await get_(threadID, path, defaultValue, query));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function set(threadID, updateData, path, query) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(threadID)) {
                                                throw new CustomError({
                                                        name: "INVALID_THREAD_ID",
                                                        message: `The first argument (threadID) must be a number, not a ${typeof threadID}`
                                                });
                                        }
                                        if (!path && (typeof updateData != "object" || Array.isArray(updateData)))
                                                throw new Error(`The second argument (updateData) must be an object, not a ${typeof updateData}`);
                                        const threadData = await save(threadID, updateData, "update", path);
                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The fourth argument (query) must be a string, not a ${typeof query}`);
                                                else
                                                        return resolve(_.cloneDeep(fakeGraphql(query, threadData)));
                                        return resolve(_.cloneDeep(threadData));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function deleteKey(threadID, path, query) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(threadID)) {
                                                throw new CustomError({
                                                        name: "INVALID_THREAD_ID",
                                                        message: `The first argument (threadID) must be a number, not a ${typeof threadID}`
                                                });
                                        }
                                        if (typeof path !== "string")
                                                throw new Error(`The second argument (path) must be a string, not a ${typeof path}`);
                                        const spitPath = path.split(".");
                                        if (spitPath.length == 1)
                                                throw new Error(`Can't delete key "${path}" because it's a root key`);
                                        const parent = spitPath.slice(0, spitPath.length - 1).join(".");
                                        const parentData = await get_(threadID, parent);
                                        if (!parentData)
                                                throw new Error(`Can't find key "${parent}" in thread with threadID: ${threadID}`);

                                        _.unset(parentData, spitPath[spitPath.length - 1]);
                                        const setData = await save(threadID, parentData, "update", parent);
                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The fourth argument (query) must be a string, not a ${typeof query}`);
                                                else
                                                        return resolve(_.cloneDeep(fakeGraphql(query, setData)));
                                        return resolve(_.cloneDeep(setData));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function remove(threadID) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(threadID)) {
                                                throw new CustomError({
                                                        name: "INVALID_THREAD_ID",
                                                        message: `The first argument (threadID) must be a number, not a ${typeof threadID}`
                                                });
                                        }
                                        await save(threadID, { threadID }, "delete");
                                        return resolve(true);
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

  async function getName(ID) {
    const i = global.db.allThreadData.find(t => t.threadID == ID);
    if (!i) return;
    return i.threadName;
  }

        return {
                existsSync: function existsSync(threadID) {
                        return global.db.allThreadData.some(t => t.threadID == threadID);
                },
                create,
                refreshInfo,
                getAll,
                get,
                set,
                deleteKey,
                remove,
    getName
        };
};