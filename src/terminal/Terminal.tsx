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

const resolveMatches = (
	matchString: string,
	completionDirectoryPath: string,
	state: TerminalState,
): string[] => {
	const completionDirectory = resolvePath(
		completionDirectoryPath || "/",
		state,
	);
	if (!completionDirectory) {
		return [];
	}
	if (completionDirectory.type === PathObjectType.FILE) {
		return [];
	}
	return Object.keys(completionDirectory.children)
		.filter((name) => name.startsWith(matchString))
		.map((name) =>
			completionDirectory.children[name].type === PathObjectType.DIRECTORY
				? name + "/"
				: name,
		);
};

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

const decapitate = (path: string): [string, string] => {
	const segments = path.split("/");
	return [segments.slice(0, -1).join("/"), segments[segments.length - 1]];
};

class AutoComplete {
	private suggestedCompletions: string[];
	private selectedCompletionIndex: number | null;
	private unambiguousCompletion: string;

	constructor() {
		this.suggestedCompletions = [];
		this.selectedCompletionIndex = null;
		this.unambiguousCompletion = "";
	}

	getNextSuggestion(inputBuffer: string): string {
		console.log(this.selectedCompletionIndex)
		if (this.selectedCompletionIndex === null) {
			this.selectedCompletionIndex = 0;
			return (
				inputBuffer + this.suggestedCompletions[this.selectedCompletionIndex].slice(this.unambiguousCompletion.length)
			);
		}
		const currentSuggestion =
			this.suggestedCompletions[this.selectedCompletionIndex];
		if (!inputBuffer.endsWith(currentSuggestion)) {
			return inputBuffer;
		}

		console.log({currentSuggestion, inputBuffer})

		this.selectedCompletionIndex =
			this.selectedCompletionIndex >= this.suggestedCompletions.length - 1
				? 0
				: this.selectedCompletionIndex + 1;
		return (
			inputBuffer.slice(0, inputBuffer.length - currentSuggestion.length) +
			this.suggestedCompletions[this.selectedCompletionIndex]
		);
	}

	generate(inputBuffer: string, state: TerminalState): AutocompleteResult {
		this.selectedCompletionIndex = null;
		this.suggestedCompletions = [];
		this.unambiguousCompletion = "";

		const finalCharacter = inputBuffer[inputBuffer.length - 1];
		const finalArgument = inputBuffer
			.split(" ")
			.filter((word) => word != "")
			.pop();

		if (!finalArgument) {
			return {
				unambiguousCompletion: this.unambiguousCompletion,
				suggestedCompletions: this.suggestedCompletions,
			};
		}

		if (finalCharacter == " ") {
			// Don't autocomplete if the last argument is a valid file/directory
			if (resolvePath(finalArgument, state)) {
				return {
					unambiguousCompletion: this.unambiguousCompletion,
					suggestedCompletions: this.suggestedCompletions,
				};
			}
			const matches = resolveMatches(
				"",
				state.pwd == "/" ? "/" : state.pwd + "/",
				state,
			);
			this.suggestedCompletions = matches;
			this.unambiguousCompletion = resolveMatchingStartCharacters(matches);
		} else if (finalCharacter == "/") {
			const matches = resolveMatches("", finalArgument, state);
			this.suggestedCompletions = matches;
			this.unambiguousCompletion = resolveMatchingStartCharacters(matches);
		} else {
			const completionPath = resolvePath(finalArgument, state);
			if (!completionPath) {
				const [directory, head] = decapitate(finalArgument);

				console.log({ directory, head });
				const matches = resolveMatches(head, directory, state);
				this.suggestedCompletions = matches;
				this.unambiguousCompletion = resolveMatchingStartCharacters(
					matches,
				).slice(head.length);
				console.log(this.suggestedCompletions, this.unambiguousCompletion);
			} else if (completionPath.type === PathObjectType.FILE) {
				this.unambiguousCompletion = " ";
			} else if (completionPath.type === PathObjectType.DIRECTORY) {
				this.unambiguousCompletion = "/";
			}
		}

		if (this.suggestedCompletions.length === 1) {
			if (!this.suggestedCompletions[0].endsWith("/")) {
				this.unambiguousCompletion += " ";
			}
		}

		return {
			unambiguousCompletion: this.unambiguousCompletion,
			suggestedCompletions: this.suggestedCompletions,
		};
	}
}

export class Terminal {
	private state: TerminalState;
	public autoComplete: AutoComplete;

	constructor() {
		this.state = initState();
		this.autoComplete = new AutoComplete();
	}
	execute(command: string): void {
		this.state.stdOut = "";
		const parsedCommand = parseCommand(command);
		if (!parsedCommand) {
			return;
		}
		this.state.history.push(command);
		if (!(parsedCommand.command in COMMAND_MAPPING)) {
			this.state.stdOut = `command not found: ${parsedCommand.command}\r\n`;
		}
		this.state = COMMAND_MAPPING[parsedCommand.command](
			parsedCommand.args,
			this.state,
		);
	}
}

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
	unambiguousCompletion: string;
	suggestedCompletions: string[];
}

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
						nested_dir: {
							type: PathObjectType.DIRECTORY,
							content: '{"hello": "world"}',
							children: {},
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
