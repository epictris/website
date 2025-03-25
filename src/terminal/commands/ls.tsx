import { constructAbsolutePath, resolvePathObject } from "../string_util";
import { PathObject, PathObjectType, TerminalState } from "../types";

const renderPathObject = (
	pathObject: PathObject,
	file_name: string,
	state: TerminalState,
) => {
	const { theme } = state;

	switch (pathObject.type) {
		case PathObjectType.FILE:
			return pathObject.executable
				? `<span style="color:${theme.green}"><b>${file_name}  </b></span>`
				: file_name + "  ";
		case PathObjectType.DIRECTORY:
			return `<span style="color:${theme.brightBlue}"><b>${file_name}  </b></span>`;
	}
};

export default (args: string[], state: TerminalState): TerminalState => {
	const params = args.filter((arg) => arg.startsWith("-"));
	const paths = args.filter((arg) => !arg.startsWith("-"));
	for (let path of paths) {
		const pathObject = resolvePathObject(
			constructAbsolutePath(path, state.pwd),
			state,
		);
		if (!pathObject) {
			state.stdOut += `ls: cannot access ${path}: No such file or directory`;
		} else if (pathObject.type === PathObjectType.FILE) {
			state.stdOut += renderPathObject(pathObject, path, state);
		} else if (paths.length === 1) {
			for (let [name, child] of Object.entries(pathObject.children)) {
				state.stdOut += renderPathObject(child, name, state);
			}
		} else {
			state.stdOut += `${path}:\r\n`;
			for (let [name, child] of Object.entries(pathObject.children)) {
				state.stdOut += renderPathObject(child, name, state);
			}
		}
	}

	if (!paths.length) {
		const pathObject = resolvePathObject(state.pwd, state)!;
		if (pathObject && pathObject.type == PathObjectType.DIRECTORY) {
			for (let [name, child] of Object.entries(pathObject.children)) {
				state.stdOut += renderPathObject(child, name, state);
			}
		}
	}

	return { ...state };
};
