import { resolvePath } from "../string_util";
import { Terminal } from "../Terminal";
import { PathObjectType, TerminalState } from "../types";

interface AutocompleteResult {
	unambiguousCompletion: string;
	suggestedCompletions: string[];
}

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

export default class AutoComplete {
	private suggestedCompletions: string[];
	private selectedCompletionIndex: number | null;
	private unambiguousCompletion: string;
	private terminal: Terminal;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
		this.suggestedCompletions = [];
		this.selectedCompletionIndex = null;
		this.unambiguousCompletion = "";
	}

	getNextSuggestion(inputBuffer: string): string {
		if (this.selectedCompletionIndex === null) {
			this.selectedCompletionIndex = 0;
			return (
				inputBuffer +
				this.suggestedCompletions[this.selectedCompletionIndex].slice(
					this.unambiguousCompletion.length,
				)
			);
		}
		const currentSuggestion =
			this.suggestedCompletions[this.selectedCompletionIndex];
		if (!inputBuffer.endsWith(currentSuggestion)) {
			return inputBuffer;
		}

		this.selectedCompletionIndex =
			this.selectedCompletionIndex >= this.suggestedCompletions.length - 1
				? 0
				: this.selectedCompletionIndex + 1;
		return (
			inputBuffer.slice(0, inputBuffer.length - currentSuggestion.length) +
			this.suggestedCompletions[this.selectedCompletionIndex]
		);
	}

	generate(inputBuffer: string): AutocompleteResult {
		const state = this.terminal.getState();

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

				const matches = resolveMatches(head, directory, state);
				this.suggestedCompletions = matches;
				this.unambiguousCompletion = resolveMatchingStartCharacters(
					matches,
				).slice(head.length);
			} else if (completionPath.type === PathObjectType.FILE) {
				this.unambiguousCompletion = " ";
			} else if (completionPath.type === PathObjectType.DIRECTORY) {
				this.unambiguousCompletion = "/";
			}
		}

		console.log(this.suggestedCompletions);
		console.log(this.unambiguousCompletion);

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
