import {
	constructAbsolutePath,
	resolvePath,
	resolvePathDirectory,
} from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state, pwd: "/" };
	}

	for (let arg of args) {
		const path = resolvePath(arg, state);
		if (!path) {
			state.stdOut += `rm: cannot remove '${arg}': No such file or directory\r\n`;
		} else if (path.type === PathObjectType.FILE) {
			const parent = resolvePathDirectory(
				constructAbsolutePath(arg, state.pwd),
				state,
			)!;
			delete parent.children[arg.split("/").pop()!];
		}
	}

	return { ...state };
};
