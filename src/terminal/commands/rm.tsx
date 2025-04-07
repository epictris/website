import {
	constructAbsolutePath,
	getHead,
	resolveParentDirectory,
	resolvePath,
	resolvePathDirectory,
} from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	if (!args.length) {
		return { ...state, pwd: "/" };
	}

	const params = args.filter((arg) => arg.startsWith("-"));
	const paths = args.filter((arg) => !arg.startsWith("-"));

	const recursive = params.includes("-r");

	for (let inputPath of paths) {
		const path = resolvePath(inputPath, state);
		if (!path) {
			state.stdOut.writeLine(
				`rm: cannot remove '${inputPath}': No such file or directory\r\n`,
			);
		} else if (!path.permissions.write && path.type === PathObjectType.FILE) {
			state.stdOut.writeLine(
				`rm: cannot remove '${inputPath}': Permission denied\r\n`,
			);
		} else if (path.type === PathObjectType.FILE) {
			const parent = resolvePathDirectory(
				constructAbsolutePath(inputPath, state),
				state,
			)!;
			delete parent.children[inputPath.split("/").pop()!];
		} else if (!recursive) {
			state.stdOut.writeLine(
				`rm: cannot remove '${inputPath}': Is a directory\r\n`,
			);
		} else if (
			!path.permissions.write &&
			path.type === PathObjectType.DIRECTORY
		) {
			state.stdOut.writeLine(
				`rm: cannot remove '${inputPath}': Permission denied\r\n`,
			);
		} else {
			const parent = resolveParentDirectory(inputPath, state);
			if (!parent) {
				state.stdOut.writeLine(`rm: cannot remove root directory\r\n`);
			}
			if (parent) {
				delete parent.children[getHead(inputPath)];
			}
		}
	}

	return { ...state };
};
