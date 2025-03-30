import { constructAbsolutePath, resolvePath } from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state, pwd: "/" };
	}

	const cdPath = constructAbsolutePath(args[0], state.pwd);
	const pathObject = resolvePath(args[0], state);
	if (!pathObject) {
		return { ...state, stdOut: `cd: ${args[0]} does not exist` };
	} else if (pathObject.type === PathObjectType.FILE) {
		return { ...state, stdOut: `cd: ${args[0]} is not a directory` };
	} else if (!pathObject.permissions.execute) {
		return { ...state, stdOut: `cd: permission denied: ${args[0]}` };
	}
	state.environmentVars["PWD"] = cdPath
	return { ...state, pwd: cdPath };
};
