enum PathObjectType {
	FILE = "file",
	DIRECTORY = "directory",
}

interface File {
	name: string;
	type: PathObjectType.FILE;
	content: string;
}

interface Directory {
	name: string;
	type: PathObjectType.DIRECTORY;
	children: Record<string, PathObject>;
}

type PathObject = File | Directory;

interface TerminalState {
	history: string[];
	pwd: string;
	stdOut: string;
	fileSystem: Directory;
	theme: Theme;
}

interface Theme {
	promptPrefix: (state: TerminalState) => string[]
}

const constructAbsolutePath = (relativePath: string, pwd: string): string => {
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

const getPathSegments = (path: string) => {
	const cleanedPath = path.replaceAll(/\/+/gi, "/").replace(/\/$/gi, "");
	return cleanedPath.split("/").filter((value) => value);
};

const resolvePathObject = (
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

const COMMAND_MAPPING: Record<
	string,
	(args: string[], state: TerminalState) => TerminalState
> = {
	cd: (args, state) => {
		if (!args.length) {
			return { ...state, pwd: "/" };
		}

		const cdPath = constructAbsolutePath(args[0], state.pwd);
		const pathObject = resolvePathObject(cdPath, state);
		if (!pathObject) {
			return { ...state, stdOut: `cd: ${args[0]} does not exist` };
		} else if (pathObject.type === PathObjectType.FILE) {
			return { ...state, stdOut: `cd: ${args[0]} is not a directory` };
		}
		return { ...state, pwd: cdPath };
	},

	ls: (args, state) => {

		const params = args.filter((arg) => arg.startsWith("-"));
		const paths = args.filter((arg) => !arg.startsWith("-"));
		for (let path of paths) {
			const pathObject = resolvePathObject(
				constructAbsolutePath(path, state.pwd),
				state,
			);
			if (!pathObject) {
				state.stdOut += `ls: cannot access ${path}: No such file or directory\r\n`;
			} else if (pathObject.type === PathObjectType.FILE) {
				state.stdOut += `${path}\r\n`;
			} else if (paths.length === 1) {
				state.stdOut += `${Object.keys(pathObject.children).join("  ")}\r\n`;
			} else {
				state.stdOut += `${path}:\r\n`;
				state.stdOut += `${Object.keys(pathObject.children).join("  ")}\r\n`;
			}
			state.stdOut += "\r\n";
		}

		if (!paths.length) {
			const pathObject = resolvePathObject(state.pwd, state)!;
			if (pathObject && pathObject.type == PathObjectType.DIRECTORY) {
				state.stdOut += `${Object.keys(pathObject.children).join("  ")}\r\n`;
			}
		}

		return { ...state };
	},
};

const parseCommand = (
	commandString: string,
): { command: string; args: string[] } | null => {
	const commandSegments = commandString
		.split(" ")
		.filter((segment) => segment !== "");
	if (commandSegments.length === 0) {
		return null;
	}
	return {
		command: commandSegments[0],
		args: commandSegments.slice(1),
	};
};

export const execute = (
	state: TerminalState,
	command: string,
): TerminalState => {
	state.stdOut = "";
	const parsedCommand = parseCommand(command);
	if (!parsedCommand) {
		return { ...state, history: [...state.history]};
	}

	if (!(parsedCommand.command in COMMAND_MAPPING)) {
		return {
			...state,
			history: [...state.history],
			stdOut: `command ${parsedCommand.command} not found`,
		};
	}

	return {
		...COMMAND_MAPPING[parsedCommand.command](parsedCommand.args, state),
		history: [...state.history, command],
	};
};

export const initState: () => TerminalState = () => {
	return {
		history: [],
		pwd: "/",
		stdOut: "",
		fileSystem: {
			name: "/",
			type: PathObjectType.DIRECTORY,
			children: {
				"hello_world.txt": {
					name: "hello_world.txt",
					type: PathObjectType.FILE,
					content: "Hello World!",
				},
				example_dir: {
					name: "example_dir",
					type: PathObjectType.DIRECTORY,
					children: {
						nested_file: {
							name: "nested_file",
							type: PathObjectType.FILE,
							content: "",
						},
					},
				},
			},
		},
		theme: {
			promptPrefix: (state) => [`${state.pwd}`, "❯"],
		}
	};
};
