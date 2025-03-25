import { Directory, PathObject, PathObjectType, TerminalState } from "./types";

export const constructAbsolutePath = (relativePath: string, pwd: string): string => {
	const relativePathSegments = getPathSegments(relativePath);
	const basePathSegments = relativePath.startsWith("/")
		? []
		: getPathSegments(pwd);
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
