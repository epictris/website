import {
	constructAbsolutePath,
	resolveParentDirectory,
	resolvePath,
	resolvePathDirectory as resolvePathDirectory,
} from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state };
	}

	for (let arg of args) {
		const targetDir = resolveParentDirectory(arg, state);
		if (!targetDir) {
			state.stdOut.writeLine(
				`touch: cannot touch '${arg}': No such file or directory`,
			);
		} else if (!targetDir.permissions.write || !targetDir.permissions.execute) {
			state.stdOut.writeLine(`touch: cannot touch '${arg}': Permission denied`);
		} else {
			const fileName = arg.split("/").pop();
			if (fileName && !targetDir.children[fileName]) {
				targetDir.children[fileName] = {
					type: PathObjectType.FILE,
					path: constructAbsolutePath(arg, state),
					content: "",
					permissions: { execute: false, read: true, write: true },
				};
			}
		}
	}

	return { ...state };
};
