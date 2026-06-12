module.exports = function ({ models }) {
	const Currencies = models.use('Currencies');

	async function getAll(...data) {
		var where, attributes;
		for (const i of data) {
			if (typeof i != 'object') throw global.getText("currencies", "needObjectOrArray");
			if (Array.isArray(i)) attributes = i;
			else where = i;
		}
		try { return (await Currencies.findAll({ where, attributes })).map(e => e.get({ plain: true })) }
		catch (error) {
			console.error(error);
			throw new Error(error);
		};
	}

	async function getData(userID) {
		try {
			const data = await Currencies.findOne({ where: { userID }});
			if (data) return data.get({ plain: true });
			else return false;
		} 
		catch (error) {
			console.error(error);
			throw new Error(error);
		};
	}

	async function setData(userID, options = {}) {
		if (typeof options != 'object' && !Array.isArray(options)) throw global.getText("currencies", "needObject");
		try {
			const record = await Currencies.findOne({ where: { userID } });
			if (record) {
				await record.update(options);
			} else {
				await createData(userID, options);
			}
			return true;
		} 
		catch (error) {
			console.error(error);
			throw new Error(error);
		}
	}

	async function delData(userID) {
		try {
			const record = await Currencies.findOne({ where: { userID } });
			if (record) await record.destroy();
			return true;
		}
		catch (error) {
			console.error(error);
			throw new Error(error);
		}
	}

	async function createData(userID, defaults = {}) {
		if (typeof defaults != 'object' && !Array.isArray(defaults)) throw global.getText("currencies", "needObject");
		try {
			await Currencies.findOrCreate({ where: { userID }, defaults });
			return true;
		}
		catch (error) {
			console.error(error);
			throw new Error(error);
		}
	}

	async function increaseMoney(userID, money) {
		if (typeof money != 'number') throw global.getText("currencies", "needNumber");
		try {
			const data = await getData(userID);
			const balance = (data && typeof data.money === 'number') ? data.money : 0;
			if (!data) await createData(userID, { data: {} });
			await setData(userID, { money: balance + money });
			return true;
		}
		catch (error) {
			console.error(error);
			throw new Error(error);
		}
	}

	async function decreaseMoney(userID, money) {
		if (typeof money != 'number') throw global.getText("currencies", "needNumber");
		try {
			const data = await getData(userID);
			if (!data) return false;
			const balance = typeof data.money === 'number' ? data.money : 0;
			if (balance < money) return false;
			await setData(userID, { money: balance - money });
			return true;
		} catch (error) {
			console.error(error);
			throw new Error(error);
		}
	}

	return {
		getAll,
		getData,
		setData,
		delData,
		createData,
		increaseMoney,
		decreaseMoney
	};
};
