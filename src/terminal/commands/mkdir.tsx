import { constructAbsolutePath, resolvePathDirectory } from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state };
	}

	for (let arg of args) {
		const dir = resolvePathDirectory(constructAbsolutePath(arg, state), state);
		if (!dir) {
			state.stdOut.writeLine(
				`mkdir: cannot create directory '${arg}': No such file or directory`,
			);
		} else {
			const fileName = arg.split("/").pop();
			if (fileName && !dir.children[fileName]) {
				dir.children[fileName] = {
					type: PathObjectType.DIRECTORY,
					path: constructAbsolutePath(arg, state),
					children: {},
					permissions: { execute: true, read: true, write: true },
				};
			}
		}
	}

	return { ...state };
};
