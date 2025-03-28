import cat from "./commands/cat";
import cd from "./commands/cd";
import chmod from "./commands/chmod";
import ls from "./commands/ls";
import mkdir from "./commands/mkdir";
import pwd from "./commands/pwd";
import rm from "./commands/rm";
import touch from "./commands/touch";
import whoami from "./commands/whoami";
import {
	constructAbsolutePath,
	getHead,
	getPathSegments,
	resolveParentDirectory,
	resolvePath,
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
	whoami,
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

interface AutocompleteResult {
	knownCompletion: string;
	suggestedCompletions: string[];
}

const resolveMatchingStartCharacters = (strings: string[]): string => {
	let matchingStartCharacters = "";
	if (strings.length === 0) {
		return matchingStartCharacters;
	}

	while (true) {
		const nextSuggestedCharacters = strings.map(
			(name) => name[matchingStartCharacters.length],
		);

		if (nextSuggestedCharacters.some((c) => c === undefined)) {
			return matchingStartCharacters;
		}
		if (
			nextSuggestedCharacters.every((c) => c === nextSuggestedCharacters[0])
		) {
			matchingStartCharacters += nextSuggestedCharacters[0];
		} else {
			return matchingStartCharacters;
		}
	}
};

export const autocomplete = (
	inputBuffer: string,
	state: TerminalState,
): AutocompleteResult => {
	const inputWords = inputBuffer.split(" ");
	if (inputWords.length === 0) {
		return { knownCompletion: inputBuffer, suggestedCompletions: [] };
	}

	let matchString: string | null = null;
	let completionDirectoryString: string | null = null;

	if (inputWords[inputWords.length - 1] == "") {
		const inputArgs = inputWords.filter((word) => word !== "");

		if (resolvePath(inputArgs[inputArgs.length - 1], state)) {
			return { knownCompletion: inputBuffer, suggestedCompletions: [] };
		}
		completionDirectoryString = state.pwd == "/" ? "/" : state.pwd + "/";
		matchString = "";
	} else {
		const finalArgument = inputWords[inputWords.length - 1];
		let completionPath = resolvePath(finalArgument, state);
		if (!completionPath) {
			matchString = getHead(finalArgument);
			completionDirectoryString = finalArgument.slice(
				0,
				finalArgument.length - matchString.length,
			);
		} else if (
			completionPath.type === PathObjectType.DIRECTORY &&
			!finalArgument.endsWith("/")
		) {
			return { knownCompletion: inputBuffer + "/", suggestedCompletions: [] };
		} else if (completionPath.type === PathObjectType.FILE) {
			return { knownCompletion: inputBuffer + " ", suggestedCompletions: [] };
		} else {
			matchString = "";
			completionDirectoryString = finalArgument;
		}
	}

	let completionPath = resolvePath(completionDirectoryString, state);

	if (!completionPath) {
		return { knownCompletion: inputBuffer, suggestedCompletions: [] };
	} else if (completionPath.type === PathObjectType.FILE) {
		return { knownCompletion: inputBuffer, suggestedCompletions: [] };
	}

	let suggestedCompletions = Object.keys(completionPath.children).filter(
		(name) => name.startsWith(matchString),
	);

	if (suggestedCompletions.length === 0) {
		return { knownCompletion: inputBuffer, suggestedCompletions: [] };
	}

	const matchingStartCharacters =
		resolveMatchingStartCharacters(suggestedCompletions);

	if (suggestedCompletions.length === 1) {
		suggestedCompletions = [];
	}

	if (matchingStartCharacters === "") {
		return { knownCompletion: inputBuffer, suggestedCompletions };
	}

	const resolvedCompletionPath = resolvePath(
		completionDirectoryString + matchingStartCharacters,
		state,
	);

	const completionResult =
		inputBuffer.slice(0, inputBuffer.length - matchString.length) +
		matchingStartCharacters;

	if (!resolvedCompletionPath) {
		return {
			knownCompletion: completionResult,
			suggestedCompletions,
		};
	} else if (resolvedCompletionPath.type === PathObjectType.DIRECTORY) {
		return {
			knownCompletion: completionResult + "/",
			suggestedCompletions,
		};
	} else {
		return {
			knownCompletion: completionResult + " ",
			suggestedCompletions,
		};
	}
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
