import { PathObject, PathObjectType, TerminalState, Directory } from "./types";

export const join = (...paths: string[]): string => {
	const normalizedPaths = paths.map((path) => path.replace(/\/+$/, ""));
	return normalizedPaths.join("/");
};

export const resolvePath = (
	relativePath: string,
	state: TerminalState,
): PathObject | null => {
	const absolutePath = constructAbsolutePath(relativePath, state);
	return resolvePathObject(absolutePath, state);
};

export const getHead = (path: string): string => {
	const pathSegments = getPathSegments(path);
	return pathSegments[pathSegments.length - 1];
};

export const constructAbsolutePath = (
	relativePath: string,
	state: TerminalState,
): string => {
	const relativePathSegments = getPathSegments(relativePath);

	let basePathSegments: string[] = [];

	if (relativePath.startsWith("/")) {
		basePathSegments = [];
	} else if (relativePath.startsWith("~")) {
		basePathSegments = getPathSegments(state.environmentVars["HOME"]);
		relativePathSegments.shift();
	} else {
		basePathSegments = getPathSegments(state.pwd);
	}

	for (let segment of relativePathSegments) {
		if (segment === ".") {
			continue;
		}
		if (segment === "..") {
			basePathSegments.length && basePathSegments.pop();
		} else {
			basePathSegments.push(segment);
		}
	}

	return "/" + basePathSegments.join("/");
};

export const getPathSegments = (path: string) => {
	const cleanedPath = path.replaceAll(/\/+/gi, "/").replace(/\/$/gi, "");
	return cleanedPath.split("/").filter((value) => value);
};

export const resolveParentDirectory = (
	relativePath: string,
	state: TerminalState,
): Directory | null => {
	const absolutePath = constructAbsolutePath(relativePath, state);
	const pathSegments = getPathSegments(absolutePath);
	if (pathSegments.length === 0) {
		return null;
	}
	if (pathSegments.length === 1) {
		return state.fileSystem;
	}
	pathSegments.pop();
	const parentDirectory = resolvePath("/" + pathSegments.join("/"), state);
	if (!parentDirectory) {
		return null;
	} else if (parentDirectory.type === PathObjectType.FILE) {
		return null;
	} else {
		return parentDirectory;
	}
};

export const resolvePathDirectory = (
	absolutePath: string,
	state: TerminalState,
): Directory | null => {
	const pathSegments = getPathSegments(absolutePath);
	if (pathSegments.length === 0) {
		return state.fileSystem;
	}
	let file = pathSegments.pop()!;

	let currentDirectory = state.fileSystem;

	for (let segment of pathSegments) {
		if (segment in currentDirectory.children) {
			if (
				currentDirectory.children[segment].type === PathObjectType.DIRECTORY
			) {
				currentDirectory = currentDirectory.children[segment];
			} else {
				return null;
			}
		}
	}

	if (file in currentDirectory.children) {
		if (currentDirectory.children[file].type === PathObjectType.DIRECTORY) {
			return currentDirectory.children[file];
		}
	}
	return currentDirectory;
};

export const resolvePathObject = (
	absolutePath: string,
	state: TerminalState,
): PathObject | null => {
	const pathSegments = getPathSegments(absolutePath);
	if (pathSegments.length === 0) {
		return state.fileSystem;
	}
	let file = pathSegments.pop()!;

	let currentDirectory = state.fileSystem;

	for (let segment of pathSegments) {
		if (segment in currentDirectory.children) {
			if (
				currentDirectory.children[segment].type === PathObjectType.DIRECTORY
			) {
				currentDirectory = currentDirectory.children[segment];
			} else {
				return null;
			}
		}
	}

	if (file in currentDirectory.children) {
		return currentDirectory.children[file];
	}
	return null;
};
