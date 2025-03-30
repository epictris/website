import {
	constructAbsolutePath,
	resolvePath,
	resolvePathDirectory,
} from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state };
	}

	for (let arg of args) {
		const dir = resolvePathDirectory(
			constructAbsolutePath(arg, state.pwd),
			state,
		);
		if (!dir) {
			state.stdOut += `touch: cannot touch '${arg}': No such file or directory`;
		} else {
			const fileName = arg.split("/").pop();
			if (fileName && !dir.children[fileName]) {
				dir.children[fileName] = {
					type: PathObjectType.FILE,
					content: "",
					permissions: { execute: false, read: true, write: true },
				};
			}
		}
	}

	return { ...state };
};
