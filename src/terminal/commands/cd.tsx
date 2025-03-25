import { constructAbsolutePath, resolvePathObject } from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state, pwd: "/" };
	}

	const cdPath = constructAbsolutePath(args[0], state.pwd);
	const pathObject = resolvePathObject(cdPath, state);
	if (!pathObject) {
		return { ...state, stdOut: `cd: ${args[0]} does not exist` };
	} else if (pathObject.type === PathObjectType.FILE) {
		return { ...state, stdOut: `cd: ${args[0]} is not a directory` };
	}
	return { ...state, pwd: cdPath };
};
