import {
	resolvePath,
} from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state };
	}

	for (let arg of args) {
		const path = resolvePath(arg, state);
		if (!path) {
			state.stdOut += `cat: ${args[0]}: No such file or directory`;
		} else if (path.type === PathObjectType.DIRECTORY) {
			state.stdOut += `cat: ${args[0]}: Is a directory`;
		} else {
			state.stdOut += path.content + "\r\n";
		}
	}

	return { ...state };
};
