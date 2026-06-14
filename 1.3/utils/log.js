const chalk = require('chalk');
const _gradientMod = require("gradient-string");

const _gradientFn = typeof _gradientMod === 'function'
  ? _gradientMod
  : (typeof _gradientMod.default === 'function' ? _gradientMod.default : null);

module.exports = (data, option) => {
	switch (option) {
		case "warn":
			console.log(chalk.bold.hex("#FF00FF").bold('[ Error ] » ') + data);
			break;
		case "error":
			console.log(chalk.bold.hex("#FF00FF").bold('[ Error ] »') + data);
			break;
		default:
			console.log(chalk.bold.hex("#00BFFF").bold(`${option} » `) + data);
			break;
	}
}

module.exports.loader = (data, option) => {
	switch (option) {
		case "warn":
			console.log(chalk.bold.hex("#00FFFF").bold('[ DRIDI ] » ') + data);
			break;
		case "error":
			console.log(chalk.bold.hex("#00FFFF").bold('[ OMAR ] » ') + data);
			break;
		default:
			console.log(chalk.bold.hex("#00FFFF").bold(` [ DRIDI ] » `) + data);
			break;
	}
}

const colors = {
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  white: "#ffffff",
  gray: "#808080",
  ocean: "#00bfff",
};

module.exports.log = (messages) => {
  try {
    const logMessage = messages
      .map(({ message, color }) => {
        try {
          if (Array.isArray(color)) {
            if (_gradientFn) {
              return _gradientFn(...color)(String(message));
            }
            return chalk.hex(colors[color[0]] || '#00bfff')(String(message));
          } else {
            return chalk.hex(colors[color] || '#ffffff')(String(message));
          }
        } catch (_) {
          return String(message);
        }
      })
      .join("");
    console.log(logMessage, "");
  } catch (_) {
    try {
      console.log(messages.map(m => m.message).join(""), "");
    } catch (__) {}
  }
};
