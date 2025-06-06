import { constructAbsolutePath, resolvePath, join } from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state, pwd: "/" };
	}

	let pathString = args[0];

	if (pathString == "-") {
		pathString = state.environmentVars["OLDPWD"] ?? state.pwd;
	}

	const cdPath = constructAbsolutePath(pathString, state);
	const pathObject = resolvePath(pathString, state);
	if (!pathObject) {
		state.stdOut.writeLine(`cd: ${pathString}: does not exist`);
		return state;
	} else if (pathObject.type === PathObjectType.FILE) {
		state.stdOut.writeLine(`cd: ${pathString}: is not a directory`);
		return state;
	} else if (!pathObject.permissions.execute) {
		state.stdOut.writeLine(`cd: permission denied: ${pathString}`);
	}
	state.environmentVars["OLDPWD"] = state.pwd;
	state.environmentVars["PWD"] = cdPath;
	state.pwd = cdPath;

	return { ...state };
};
