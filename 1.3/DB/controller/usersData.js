const { existsSync, writeJsonSync, readJSONSync } = require("fs-extra");
const moment = require("moment-timezone");
const path = require("path");
const axios = require("axios");
const _ = require("lodash");
const { CustomError } = global.utils;
// [FIX Djamel] — atomic JSON writes so a crash mid-write can't corrupt
// the entire users database. Falls back to writeJsonSync if helper missing.
const { atomicWriteJsonSync } = (() => {
        try { return require("../../utils/atomicWrite"); }
        catch (_) { return { atomicWriteJsonSync: writeJsonSync }; }
})();

const optionsWriteJSON = {
        spaces: 2,
        EOL: "\n"
};

const messageQueue = global.utils.createQueue(async function (task, callback) {
        try {
                const result = await task();
                callback(null, result);
        }
        catch (err) {
                callback(err);
        }
});

const { creatingUserData } = global.DBYUKI.database;

module.exports = async function (databaseType, userModel, api, fakeGraphql) {
        let Users = [];
        const pathUsersData = path.join(__dirname, "..", "data/usersData.json");

        switch (databaseType) {
                case "mongodb": {
                        // delete keys '_id' and '__v' in all users
                        Users = (await userModel.find({}).lean()).map(user => _.omit(user, ["_id", "__v"]));
                        break;
                }
                case "sqlite": {
                        Users = (await userModel.findAll()).map(user => user.get({ plain: true }));
                        break;
                }
                case "json": {
                        if (!existsSync(pathUsersData))
                                atomicWriteJsonSync(pathUsersData, [], optionsWriteJSON);
                        Users = readJSONSync(pathUsersData);
                        break;
                }
        }
        global.db.allUserData = Users;

        async function save(userID, userData, mode, path) {
                try {
                        let index = _.findIndex(global.db.allUserData, { userID });
                        if (index === -1 && mode === "update") {
                                try {
                                        await create_(userID);
                                        index = _.findIndex(global.db.allUserData, { userID });
                                }
                                catch (err) {
                                        throw new CustomError({
                                                name: "USER_NOT_FOUND",
                                                message: `Can't find user with userID: ${userID} in database`
                                        });
                                }
                        }

                        switch (mode) {
                                case "create": {
                                        switch (databaseType) {
                                                case "mongodb":
                                                case "sqlite": {
                                                        let dataCreated = await userModel.create(userData);
                                                        dataCreated = databaseType === "mongodb" ?
                                                                _.omit(dataCreated._doc, ["_id", "__v"]) :
                                                                dataCreated.get({ plain: true });
                                                        global.db.allUserData.push(dataCreated);
                                                        return _.cloneDeep(dataCreated);
                                                }
                                                case "json": {
                                                        const timeCreate = moment.tz().format();
                                                        userData.createdAt = timeCreate;
                                                        userData.updatedAt = timeCreate;
                                                        global.db.allUserData.push(userData);
                                                        atomicWriteJsonSync(pathUsersData, global.db.allUserData, optionsWriteJSON);
                                                        return _.cloneDeep(userData);
                                                }
                                                default: {
                                                        break;
                                                }
                                        }
                                        break;
                                }
                                case "update": {
                                        const oldUserData = global.db.allUserData[index];
                                        const dataWillChange = {};

                                        if (Array.isArray(path) && Array.isArray(userData)) {
                                                path.forEach((p, index) => {
                                                        const key = p.split(".")[0];
                                                        dataWillChange[key] = oldUserData[key];
                                                        _.set(dataWillChange, p, userData[index]);
                                                });
                                        }
                                        else
                                                if (path && typeof path === "string" || Array.isArray(path)) {
                                                        const key = Array.isArray(path) ? path[0] : path.split(".")[0];
                                                        dataWillChange[key] = oldUserData[key];
                                                        _.set(dataWillChange, path, userData);
                                                }
                                                else
                                                        for (const key in userData)
                                                                dataWillChange[key] = userData[key];

                                        switch (databaseType) {
                                                case "mongodb": {
                                                        // [FIX H5] — use Mongoose's `{ new: true }` + null guard (see threadsData.js)
                                                        let dataUpdated = await userModel.findOneAndUpdate({ userID }, dataWillChange, { new: true });
                                                        if (!dataUpdated) throw new Error(`User ${userID} not found during update`);
                                                        dataUpdated = _.omit(dataUpdated._doc || dataUpdated.toObject?.() || dataUpdated, ["_id", "__v"]);
                                                        global.db.allUserData[index] = dataUpdated;
                                                        return _.cloneDeep(dataUpdated);
                                                }
                                                case "sqlite": {
                                                        // [FIX M3] — Sequelize transaction (see threadsData.js)
                                                        const dataUpdated = await userModel.sequelize.transaction(async (t) => {
                                                                const user = await userModel.findOne({ where: { userID }, transaction: t });
                                                                return (await user.update(dataWillChange, { transaction: t })).get({ plain: true });
                                                        });
                                                        global.db.allUserData[index] = dataUpdated;
                                                        return _.cloneDeep(dataUpdated);
                                                }
                                                case "json": {
                                                        dataWillChange.updatedAt = moment.tz().format();
                                                        global.db.allUserData[index] = {
                                                                ...oldUserData,
                                                                ...dataWillChange
                                                        };
                                                        atomicWriteJsonSync(pathUsersData, global.db.allUserData, optionsWriteJSON);
                                                        return _.cloneDeep(global.db.allUserData[index]);
                                                }
                                        }
                                        break;
                                }
                                case "remove": {
                                        if (index != -1) {
                                                global.db.allUserData.splice(index, 1);
                                                switch (databaseType) {
                                                        case "mongodb":
                                                                await userModel.deleteOne({ userID });
                                                                break;
                                                        case "sqlite":
                                                                await userModel.destroy({ where: { userID } });
                                                                break;
                                                        case "json":
                                                                atomicWriteJsonSync(pathUsersData, global.db.allUserData, optionsWriteJSON);
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

        async function getName(userID, checkData = true) {
                if (isNaN(userID)) {
                        throw new CustomError({
                                name: "INVALID_USER_ID",
                                message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                }
                if (checkData) {
                        const userData = global.db.allUserData.find(u => u.userID == userID);
                        if (userData)
                                return userData.name;
                }
                try {
                        const user = await axios.post(`https://www.facebook.com/api/graphql/?q=${`node(${userID}){name}`}`);
                        return user.data[userID].name;
                }
                catch (error) {
                        return null;
                }
        }

        async function getAvatarUrl(userID) {
                if (isNaN(userID)) {
                        throw new CustomError({
                                name: "INVALID_USER_ID",
                                message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                }
                try {
                        const user = await axios.post(`https://www.facebook.com/api/graphql/`, null, {
                                params: {
                                        doc_id: "5341536295888250",
                                        variables: JSON.stringify({ height: 500, scale: 1, userID, width: 500 })
                                }
                        });
                        return user.data.data.profile.profile_picture.uri;
                }
                catch (err) {
                        return "https://i.ibb.co/bBSpr5v/143086968-2856368904622192-1959732218791162458-n.png";
                }
        }

        async function create_(userID, userInfo) {
                return new Promise(async function (resolve, reject) {
                        const findInCreatingData = creatingUserData.find(u => u.userID == userID);
                        if (findInCreatingData)
                                // [FIX Djamel] — was `return findInCreatingData.promise` which
                                // returned a value to the async Promise executor without ever
                                // calling resolve(), so concurrent create() calls hung forever.
                                // Mirror the threadsData.js pattern: resolve with the queued promise.
                                return resolve(findInCreatingData.promise);

                        const queue = new Promise(async function (resolve_, reject_) {
                                try {
                                        if (global.db.allUserData.some(u => u.userID == userID)) {
                                                throw new CustomError({
                                                        name: "DATA_ALREADY_EXISTS",
                                                        message: `User with id "${userID}" already exists in the data`
                                                });
                                        }
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                                                });
                                        }
                                        // [FIX Djamel] — guard against null userInfo and missing userID key.
                                        // Previously crashed with "Cannot read property 'name' of undefined"
                                        // when getUserInfo returned null or didn't include the requested userID.
                                        if (!userInfo) {
                                                const fetched = await api.getUserInfo(userID);
                                                userInfo = (fetched && fetched[userID]) || null;
                                        }
                                        if (!userInfo || typeof userInfo !== "object") {
                                                throw new CustomError({
                                                        name: "USER_INFO_UNAVAILABLE",
                                                        message: `Could not fetch user info for "${userID}" from Facebook (will retry on next event)`
                                                });
                                        }
                                        let userData = {
                                                userID,
                                                name: userInfo.name || "",
                                                gender: userInfo.gender,
                                                vanity: userInfo.vanity,
                                                exp: 0,
                                                money: 0,
                                                banned: {},
                                                settings: {},
                                                data: {}
                                        };
                                        userData = await save(userID, userData, "create");
                                        resolve_(_.cloneDeep(userData));
                                }
                                catch (err) {
                                        reject_(err);
                                }
                                // [FIX Djamel] — guard splice: findIndex returns -1 if not found,
                                // and splice(-1, 1) wrongly removes the LAST element of the queue.
                                const _idx = creatingUserData.findIndex(u => u.userID == userID);
                                if (_idx !== -1) creatingUserData.splice(_idx, 1);
                        });
                        creatingUserData.push({
                                userID,
                                promise: queue
                        });
                        return resolve(queue);
                });
        }

        async function create(userID, userInfo) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        resolve(await create_(userID, userInfo));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function refreshInfo(userID, updateInfoUser) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                                                });
                                        }
                                        const infoUser = await get_(userID);
                                        // [FIX Djamel] — same null-guard as create_: getUserInfo
                                        // can return null (suspended account, network blip) and
                                        // the [userID] index can be undefined.
                                        if (!updateInfoUser) {
                                                const fetched = await api.getUserInfo(userID);
                                                updateInfoUser = (fetched && fetched[userID]) || null;
                                        }
                                        if (!updateInfoUser || typeof updateInfoUser !== "object") {
                                                throw new CustomError({
                                                        name: "USER_INFO_UNAVAILABLE",
                                                        message: `Could not refresh user info for "${userID}" from Facebook`
                                                });
                                        }

                                        const newData = {
                                                name: updateInfoUser.name,
                                                vanity: updateInfoUser.vanity,
                                                gender: updateInfoUser.gender
                                        };
                                        let userData = {
                                                ...infoUser,
                                                ...newData
                                        };

                                        userData = await save(userID, userData, "update");
                                        resolve(_.cloneDeep(userData));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        function getAll(path, defaultValue, query) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(function () {
                                try {
                                        let dataReturn = _.cloneDeep(global.db.allUserData);

                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The third argument (query) must be a string, not ${typeof query}`);
                                                else
                                                        dataReturn = dataReturn.map(uData => fakeGraphql(query, uData));

                                        if (path)
                                                if (!["string", "object"].includes(typeof path))
                                                        throw new Error(`The first argument (path) must be a string or object, not ${typeof path}`);
                                                else
                                                        if (typeof path === "string")
                                                                return resolve(dataReturn.map(uData => _.get(uData, path, defaultValue)));
                                                        else
                                                                return resolve(dataReturn.map(uData => _.times(path.length, i => _.get(uData, path[i], defaultValue[i]))));

                                        return resolve(dataReturn);
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function get_(userID, path, defaultValue, query) {
                return new Promise(async (resolve, reject) => {
                        try {
                                if (isNaN(userID)) {
                                        throw new CustomError({
                                                name: "INVALID_USER_ID",
                                                message: `The first argument (userID) must be a number, not ${typeof userID}`
                                        });
                                }
                                let userData;

                                const index = global.db.allUserData.findIndex(u => u.userID == userID);
                                if (index === -1)
                                        userData = await create_(userID);
                                else
                                        userData = global.db.allUserData[index];

                                if (query)
                                        if (typeof query !== "string")
                                                throw new Error(`The fourth argument (query) must be a string, not ${typeof query}`);
                                        else
                                                userData = fakeGraphql(query, userData);

                                if (path)
                                        if (!["string", "object"].includes(typeof path))
                                                throw new Error(`The second argument (path) must be a string or array, not ${typeof path}`);
                                        else
                                                if (typeof path === "string")
                                                        return resolve(_.cloneDeep(_.get(userData, path, defaultValue)));
                                                else
                                                        return resolve(_.cloneDeep(_.times(path.length, i => _.get(userData, path[i], defaultValue[i]))));

                                return resolve(_.cloneDeep(userData));
                        }
                        catch (err) {
                                reject(err);
                        }
                });
        }

        async function get(userID, path, defaultValue, query) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(async function () {
                                try {
                                        resolve(await get_(userID, path, defaultValue, query));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function set(userID, updateData, path, query) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                                                });
                                        }

                                        if (!path && (typeof updateData != "object" || typeof updateData == "object" && Array.isArray(updateData)))
                                                throw new Error(`The second argument (updateData) must be an object, not ${typeof updateData}`);

                                        const userData = await save(userID, updateData, "update", path);
                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The fourth argument (query) must be a string, not ${typeof query}`);
                                                else
                                                        return resolve(_.cloneDeep(fakeGraphql(query, userData)));

                                        return resolve(_.cloneDeep(userData));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function deleteKey(userID, path, query) {
                return new Promise(async function (resolve, reject) {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not a ${typeof userID}`
                                                });
                                        }
                                        if (typeof path !== "string")
                                                throw new Error(`The second argument (path) must be a string, not a ${typeof path}`);
                                        const spitPath = path.split(".");
                                        if (spitPath.length == 1)
                                                throw new Error(`Can't delete key "${path}" because it's a root key`);
                                        const parent = spitPath.slice(0, spitPath.length - 1).join(".");
                                        const parentData = await get_(userID, parent);
                                        if (!parentData)
                                                throw new Error(`Can't find key "${parent}" in user with userID: ${userID}`);

                                        _.unset(parentData, spitPath[spitPath.length - 1]);
                                        const setData = await save(userID, parentData, "update", parent);
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

        async function getMoney(userID) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                                                });
                                        }
                                        const money = await get_(userID, "money");
                                        resolve(money);
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function addMoney(userID, money, query) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                                                });
                                        }
                                        if (isNaN(money)) {
                                                throw new CustomError({
                                                        name: "INVALID_MONEY",
                                                        message: `The second argument (money) must be a number, not ${typeof money}`
                                                });
                                        }
                                        if (!global.db.allUserData.some(u => u.userID == userID))
                                                await create_(userID);
                                        const currentMoney = await get_(userID, "money");
                                        const newMoney = currentMoney + money;
                                        const userData = await save(userID, newMoney, "update", "money");
                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The third argument (query) must be a string, not ${typeof query}`);
                                                else
                                                        return resolve(_.cloneDeep(fakeGraphql(query, userData)));

                                        return resolve(_.cloneDeep(userData));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function subtractMoney(userID, money, query) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                throw new CustomError({
                                                        name: "INVALID_USER_ID",
                                                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                                                });
                                        }
                                        if (isNaN(money)) {
                                                throw new CustomError({
                                                        name: "INVALID_MONEY",
                                                        message: `The second argument (money) must be a number, not ${typeof money}`
                                                });
                                        }
                                        if (!global.db.allUserData.some(u => u.userID == userID))
                                                await create_(userID);
                                        const currentMoney = await get_(userID, "money");
                                        const newMoney = currentMoney - money;
                                        const userData = await save(userID, newMoney, "update", "money");
                                        if (query)
                                                if (typeof query !== "string")
                                                        throw new Error(`The third argument (query) must be a string, not ${typeof query}`);
                                                else
                                                        return resolve(_.cloneDeep(fakeGraphql(query, userData)));
                                        return resolve(_.cloneDeep(userData));
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        async function remove(userID) {
                return new Promise((resolve, reject) => {
                        messageQueue.push(async function () {
                                try {
                                        if (isNaN(userID)) {
                                                const error = new Error(`The first argument (userID) must be a number, not ${typeof userID}`);
                                                error.name = "INVALID_USER_ID";
                                                reject(error);
                                        }
                                        await save(userID, { userID }, "remove");
                                        return resolve(true);
                                }
                                catch (err) {
                                        reject(err);
                                }
                        });
                });
        }

        return {
                existsSync: function existsSync(userID) {
                        return global.db.allUserData.some(u => u.userID == userID);
                },
                getName,
                getAvatarUrl,
                create,
                refreshInfo,
                getAll,
                get,
                set,
                deleteKey,
                getMoney,
                addMoney,
                subtractMoney,
                remove
        };
};