import cat from "./commands/cat";
import cd from "./commands/cd";
import chmod from "./commands/chmod";
import ls from "./commands/ls";
import mkdir from "./commands/mkdir";
import pwd from "./commands/pwd";
import rm from "./commands/rm";
import touch from "./commands/touch";
import {
	constructAbsolutePath,
	getPathSegments,
	resolvePathDirectory,
	resolvePathObject,
} from "./string_util";
import { PathObjectType, TerminalState } from "./types";

const COMMAND_MAPPING: Record<
	string,
	(args: string[], state: TerminalState) => TerminalState
> = {
	ls,
	cd,
	cat,
	touch,
	rm,
	pwd,
	mkdir,
	chmod,
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

export const tabComplete = (
	inputBuffer: string,
	state: TerminalState,
): string => {
	const inputWords = inputBuffer.split(" ").filter((word) => word);
	if (inputWords.length === 0) {
		return inputBuffer;
	}

	const lastWord = inputWords[inputWords.length - 1];

	const pathObject = resolvePathObject(
		constructAbsolutePath(lastWord, state.pwd),
		state,
	);
	if (pathObject && pathObject.type == PathObjectType.FILE) {
		return inputBuffer;
	}

	const pathDirectory = resolvePathDirectory(
		constructAbsolutePath(lastWord, state.pwd),
		state,
	);
	if (!pathDirectory) {
		return inputBuffer;
	}

	const useFirstSuggestion =
		inputBuffer.endsWith("/") || inputBuffer.endsWith(" ");
	const partialFileName = useFirstSuggestion
		? ""
		: (getPathSegments(lastWord).pop() ?? "");
	console.log(pathDirectory);

	for (let [name, child] of Object.entries(pathDirectory.children)) {
		if (!partialFileName || name.startsWith(partialFileName)) {
			const suggestion = inputBuffer + name.slice(partialFileName.length);
			return child.type === PathObjectType.FILE
				? suggestion + " "
				: suggestion + "/";
		}
	}
	return inputBuffer;
};

export const execute = (
	state: TerminalState,
	command: string,
): TerminalState => {
	state.stdOut = "";
	const parsedCommand = parseCommand(command);
	if (!parsedCommand) {
		return { ...state };
	}

	state.history.push(command);

	if (!(parsedCommand.command in COMMAND_MAPPING)) {
		return {
			...state,
			stdOut: `command not found: ${parsedCommand.command}\r\n`,
		};
	}

	return {
		...COMMAND_MAPPING[parsedCommand.command](parsedCommand.args, state),
	};
};

export const initState: () => TerminalState = () => {
	return {
		history: [],
		pwd: "/",
		stdOut: "",
		fileSystem: {
			type: PathObjectType.DIRECTORY,
			children: {
				"hello_world.txt": {
					type: PathObjectType.FILE,
					content: "Hello World!",
				},
				"hello_world_2.txt": {
					type: PathObjectType.FILE,
					content: "Hello World (2)!",
				},
				example_dir: {
					type: PathObjectType.DIRECTORY,
					children: {
						nested_file: {
							type: PathObjectType.FILE,
							content: '{"hello": "world"}',
						},
					},
				},
			},
		},
		theme: {
			background: "#1f2430",
			foreground: "#cbccc6",
			bright_foreground: "#f28779",
			black: "#212733",
			red: "#f08778",
			green: "#53bf97",
			yellow: "#fdcc60",
			blue: "#60b8d6",
			magenta: "#ec7171",
			cyan: "#98e6ca",
			white: "#fafafa",
			brightBlack: "#686868",
			brightRed: "#f58c7d",
			brightGreen: "#58c49c",
			brightYellow: "#ffd165",
			brightBlue: "#65bddb",
			brightMagenta: "#f17676",
			brightCyan: "#9debcf",
			brightWhite: "#ffffff",
		},
	};
};
