// Patched for static compilation with scriptc: the upstream factory/closure
// design (createColors returning a record of formatters) is restated as plain
// exported function declarations. Output is byte-identical to upstream.
let argv = process.argv, env = process.env
export let isColorSupported =
	!(!!env.NO_COLOR || argv.includes("--no-color")) &&
	(!!env.FORCE_COLOR || argv.includes("--color") || process.platform === "win32" || (!!process.stdout.isTTY && env.TERM !== "dumb") || !!env.CI)

/**
 * @param {string} string
 * @param {string} close
 * @param {string} replace
 * @param {number} index
 * @return {string}
 */
let replaceClose = (string, close, replace, index) => {
	let result = "", cursor = 0
	do {
		result += string.substring(cursor, index) + replace
		cursor = index + close.length
		index = string.indexOf(close, cursor)
	} while (~index)
	return result + string.substring(cursor)
}

/**
 * @param {string} open
 * @param {string} close
 * @param {string} replace
 * @param {(string|number)} input
 * @return {string}
 */
let wrap = (open, close, replace, input) => {
	let string = "" + input
	if (!isColorSupported) return string
	let index = string.indexOf(close, open.length)
	return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close
}


/**
 * @param {(string|number)} input
 * @return {string}
 */
export function reset(input) {
	return wrap("\x1b[0m", "\x1b[0m", "\x1b[0m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bold(input) {
	return wrap("\x1b[1m", "\x1b[22m", "\x1b[22m\x1b[1m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function dim(input) {
	return wrap("\x1b[2m", "\x1b[22m", "\x1b[22m\x1b[2m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function italic(input) {
	return wrap("\x1b[3m", "\x1b[23m", "\x1b[3m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function underline(input) {
	return wrap("\x1b[4m", "\x1b[24m", "\x1b[4m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function inverse(input) {
	return wrap("\x1b[7m", "\x1b[27m", "\x1b[7m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function hidden(input) {
	return wrap("\x1b[8m", "\x1b[28m", "\x1b[8m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function strikethrough(input) {
	return wrap("\x1b[9m", "\x1b[29m", "\x1b[9m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function black(input) {
	return wrap("\x1b[30m", "\x1b[39m", "\x1b[30m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function red(input) {
	return wrap("\x1b[31m", "\x1b[39m", "\x1b[31m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function green(input) {
	return wrap("\x1b[32m", "\x1b[39m", "\x1b[32m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function yellow(input) {
	return wrap("\x1b[33m", "\x1b[39m", "\x1b[33m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function blue(input) {
	return wrap("\x1b[34m", "\x1b[39m", "\x1b[34m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function magenta(input) {
	return wrap("\x1b[35m", "\x1b[39m", "\x1b[35m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function cyan(input) {
	return wrap("\x1b[36m", "\x1b[39m", "\x1b[36m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function white(input) {
	return wrap("\x1b[37m", "\x1b[39m", "\x1b[37m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function gray(input) {
	return wrap("\x1b[90m", "\x1b[39m", "\x1b[90m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgBlack(input) {
	return wrap("\x1b[40m", "\x1b[49m", "\x1b[40m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgRed(input) {
	return wrap("\x1b[41m", "\x1b[49m", "\x1b[41m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgGreen(input) {
	return wrap("\x1b[42m", "\x1b[49m", "\x1b[42m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgYellow(input) {
	return wrap("\x1b[43m", "\x1b[49m", "\x1b[43m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgBlue(input) {
	return wrap("\x1b[44m", "\x1b[49m", "\x1b[44m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgMagenta(input) {
	return wrap("\x1b[45m", "\x1b[49m", "\x1b[45m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgCyan(input) {
	return wrap("\x1b[46m", "\x1b[49m", "\x1b[46m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgWhite(input) {
	return wrap("\x1b[47m", "\x1b[49m", "\x1b[47m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function blackBright(input) {
	return wrap("\x1b[90m", "\x1b[39m", "\x1b[90m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function redBright(input) {
	return wrap("\x1b[91m", "\x1b[39m", "\x1b[91m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function greenBright(input) {
	return wrap("\x1b[92m", "\x1b[39m", "\x1b[92m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function yellowBright(input) {
	return wrap("\x1b[93m", "\x1b[39m", "\x1b[93m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function blueBright(input) {
	return wrap("\x1b[94m", "\x1b[39m", "\x1b[94m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function magentaBright(input) {
	return wrap("\x1b[95m", "\x1b[39m", "\x1b[95m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function cyanBright(input) {
	return wrap("\x1b[96m", "\x1b[39m", "\x1b[96m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function whiteBright(input) {
	return wrap("\x1b[97m", "\x1b[39m", "\x1b[97m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgBlackBright(input) {
	return wrap("\x1b[100m", "\x1b[49m", "\x1b[100m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgRedBright(input) {
	return wrap("\x1b[101m", "\x1b[49m", "\x1b[101m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgGreenBright(input) {
	return wrap("\x1b[102m", "\x1b[49m", "\x1b[102m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgYellowBright(input) {
	return wrap("\x1b[103m", "\x1b[49m", "\x1b[103m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgBlueBright(input) {
	return wrap("\x1b[104m", "\x1b[49m", "\x1b[104m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgMagentaBright(input) {
	return wrap("\x1b[105m", "\x1b[49m", "\x1b[105m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgCyanBright(input) {
	return wrap("\x1b[106m", "\x1b[49m", "\x1b[106m", input)
}

/**
 * @param {(string|number)} input
 * @return {string}
 */
export function bgWhiteBright(input) {
	return wrap("\x1b[107m", "\x1b[49m", "\x1b[107m", input)
}
