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
			state.stdOut += `cat: ${arg}: No such file or directory`;
		} else if (path.type === PathObjectType.DIRECTORY) {
			state.stdOut += `cat: ${arg}: Is a directory`;
		} else if (!path.permissions.read) {
			state.stdOut += `cat: ${arg}: Permission denied`;
		} else {
			state.stdOut += path.content + "\r\n";
		}
	}

	return { ...state };
};
