import { resolvePath, resolvePathObject } from "../string_util";
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
				? `<a href="https://google.com" style="color:${theme.green};"><b>${file_name}  </b></a>`
				: file_name + "  ";
		case PathObjectType.DIRECTORY:
			return `<span style="color:${theme.brightBlue}"><b>${file_name}  </b></span>`;
	}
};

const resolveChildDirectories = (
	parentPath: string,
	state: TerminalState,
): string[] => {
	const pathObject = resolvePath(parentPath, state);
	if (!pathObject) {
		return [];
	}
	if (pathObject.type === PathObjectType.FILE) {
		return [];
	}

	const childDirectories = Object.keys(pathObject.children).filter(
		(name) => pathObject.children[name].type === PathObjectType.DIRECTORY,
	);

	if (!childDirectories.length) {
		return [];
	}

	let allPaths: string[] = [];

	for (let directory of childDirectories) {
		const childPath = join(parentPath, directory);
		allPaths.push(childPath);
		allPaths = allPaths.concat(resolveChildDirectories(childPath, state));
	}
	console.log(allPaths);
	return allPaths;
};

export default (args: string[], state: TerminalState): TerminalState => {
	const params = args.filter((arg) => arg.startsWith("-"));
	const paths = args.filter((arg) => !arg.startsWith("-"));

	let recursive = false;

	if (params.includes("-R")) {
		recursive = true;
	}

	if (!paths.length) {
		if (recursive) {
			paths.push(".");
		} else {
			const pathObject = resolvePathObject(state.pwd, state)!;
			if (pathObject && pathObject.type == PathObjectType.DIRECTORY) {
				for (let [name, child] of Object.entries(pathObject.children)) {
					state.stdOut += renderPathObject(child, name, state);
				}
			}
			return { ...state };
		}
	}

	let validPaths: string[] = [];

	for (let inputPath of paths) {
		const pathObject = resolvePath(inputPath, state);
		if (!pathObject) {
			state.stdOut += `ls: cannot access ${inputPath}: No such file or directory`;
		} else if (pathObject.type === PathObjectType.FILE) {
			validPaths.push(inputPath);
		} else {
			validPaths.push(inputPath);
			if (recursive) {
				validPaths = validPaths.concat(
					resolveChildDirectories(inputPath, state),
				);
			}
		}
	}

	for (let validPath of validPaths) {
		const pathObject = resolvePath(validPath, state);
		if (!pathObject) {
			state.stdOut += `ls: cannot access ${validPath}: No such file or directory`;
		} else if (pathObject.type === PathObjectType.FILE) {
			state.stdOut += renderPathObject(pathObject, validPath, state);
		} else if (validPaths.length === 1) {
			for (let [name, child] of Object.entries(pathObject.children)) {
				state.stdOut += renderPathObject(child, name, state);
			}
		} else {
			state.stdOut += `${validPath}:\r\n`;
			for (let [name, child] of Object.entries(pathObject.children)) {
				state.stdOut += renderPathObject(child, name, state);
			}
		}
		state.stdOut += "\r\n\r\n";
	}
	state.stdOut = state.stdOut.slice(0, -4);

	return { ...state };
};
