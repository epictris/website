import * as stringUtil from "../string_util";
import {
	PathObject,
	PathObjectType,
	STDOutEntry,
	STDOutType,
	TerminalState,
} from "../types";

const renderPathObject = (pathObject: PathObject): STDOutEntry => {
	if (pathObject.type === PathObjectType.DIRECTORY) {
		return {
			type: STDOutType.DIRECTORY,
			absolutePath: pathObject.path,
		};
	} else if (pathObject.permissions.execute) {
		return {
			type: STDOutType.FILE,
			absolutePath: pathObject.path,
			executable: true,
		};
	} else {
		return {
			type: STDOutType.FILE,
			absolutePath: pathObject.path,
			executable: false,
		};
	}
};

const resolveChildDirectories = (
	parentPath: string,
	showHidden: boolean,
	state: TerminalState,
): string[] => {
	const pathObject = stringUtil.resolvePath(parentPath, state);
	if (!pathObject) {
		return [];
	}
	if (pathObject.type === PathObjectType.FILE) {
		return [];
	}
	if (!pathObject.permissions.read) {
		return [];
	}

	let childDirectories = Object.keys(pathObject.children).filter(
		(name) => pathObject.children[name].type === PathObjectType.DIRECTORY,
	);
	if (!showHidden) {
		childDirectories = childDirectories.filter((name) => !name.startsWith("."));
	}
	if (!childDirectories.length) {
		return [];
	}

	let allPaths: string[] = [];

	for (let directory of childDirectories) {
		const childPath = stringUtil.join(parentPath, directory);
		allPaths.push(childPath);
		allPaths = allPaths.concat(
			resolveChildDirectories(childPath, showHidden, state),
		);
	}
	return allPaths;
};

export default (args: string[], state: TerminalState): TerminalState => {
	const params = args.filter((arg) => arg.startsWith("-"));
	const paths = args.filter((arg) => !arg.startsWith("-"));

	let recursive = params.includes("-R");
	let showHidden = params.includes("-a");

	if (!paths.length) {
		if (recursive) {
			paths.push(".");
		} else {
			const pathObject = stringUtil.resolvePathObject(state.pwd, state)!;
			if (
				pathObject &&
				pathObject.type === PathObjectType.DIRECTORY &&
				!pathObject.permissions.read
			) {
				state.stdOut.writeLine(
					`ls: cannot open directory '.': Permission denied`,
				);
				return { ...state };
			}
			if (pathObject && pathObject.type == PathObjectType.DIRECTORY) {
				let children = Object.entries(pathObject.children);
				if (!showHidden) {
					children = children.filter(([name, _child]) => !name.startsWith("."));
				} else {
					state.stdOut.writeLine({
						type: STDOutType.DIRECTORY,
						absolutePath: stringUtil.constructAbsolutePath(".", state),
					});
					state.stdOut.writeLine({
						type: STDOutType.DIRECTORY,
						absolutePath: stringUtil.constructAbsolutePath("..", state),
					});
				}
				for (let [name, child] of children) {
					state.stdOut.writeLine(renderPathObject(child));
				}
			}
			return { ...state };
		}
	}

	let validPaths: string[] = [];

	for (let inputPath of paths) {
		const pathObject = stringUtil.resolvePath(inputPath, state);
		if (!pathObject) {
			state.stdOut.writeLine(
				`ls: cannot access ${inputPath}: No such file or directory`,
			);
		} else if (pathObject.type === PathObjectType.FILE) {
			validPaths.push(inputPath);
		} else if (!pathObject.permissions.read) {
			state.stdOut.writeLine(
				`ls: cannot open directory '${inputPath}': Permission denied\r\n`,
			);
		} else {
			validPaths.push(inputPath);
			if (recursive) {
				validPaths = validPaths.concat(
					resolveChildDirectories(inputPath, showHidden, state),
				);
			}
		}
	}

	for (let validPath of validPaths) {
		const pathObject = stringUtil.resolvePath(validPath, state);
		if (!pathObject) {
			state.stdOut.writeLine(
				`ls: cannot access ${validPath}: No such file or directory`,
			);
		} else if (pathObject.type === PathObjectType.FILE) {
			state.stdOut.writeLine(renderPathObject(pathObject));
		} else {
			if (validPaths.length > 1 || recursive) {
				state.stdOut.writeLine(validPath);
			}
			let children = Object.entries(pathObject.children);
			if (!showHidden) {
				children = children.filter(([name, _child]) => !name.startsWith("."));
			} else {
				state.stdOut.writeLine({
					type: STDOutType.DIRECTORY,
					absolutePath: stringUtil.constructAbsolutePath(".", state),
				});
				state.stdOut.writeLine({
					type: STDOutType.DIRECTORY,
					absolutePath: stringUtil.constructAbsolutePath("..", state),
				});
			}
			for (let [name, child] of Object.entries(pathObject.children)) {
				state.stdOut.writeLine(renderPathObject(child));
			}
		}
		state.stdOut.writeLine();
		state.stdOut.writeLine();
	}

	return { ...state };
};
