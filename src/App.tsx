import { createSignal, For, JSX, JSXElement, type Component } from "solid-js";

import styles from "./App.module.css";
import { Terminal } from "./terminal/Terminal";
import { STDOutEntry, STDOutType } from "./terminal/types";

const AutocompleteSuggestions: Component<{ suggestions: string[] }> = (
	props,
) => {
	return (
		<div>
			{props.suggestions.map((suggestion) => (
				<span>{suggestion + "  "}</span>
			))}
		</div>
	);
};

const sleep = (delay: number) =>
	new Promise((resolve) => setTimeout(resolve, delay));

const App: Component = () => {
	async function enqueueCommand(characters: string): Promise<void> {
		await sleep(100)
		for (let i = 0; i < characters.length; i++) {
			onKeyDown(new KeyboardEvent("keydown", { key: characters[i] }));
			await sleep(20);
		}
		onKeyDown(new KeyboardEvent("keydown", { key: "Enter" }));
	}

	const terminal = new Terminal(enqueueCommand);

	const [tabCompletion, setTabCompletion] = createSignal(false);
	const [autocompleteSuggestions, setAutocompleteSuggestions] = createSignal<
		string[]
	>([]);

	const [state, setState] = createSignal(terminal.getState());
	const [inputBuffer, setInputBuffer] = createSignal("");
	const [output, setOutput] = createSignal<(JSXElement)[]>([<br />]);
	const [historyOffset, setHistoryOffset] = createSignal(0);

	const executeCommand = (command: string): void => {
		setAutocompleteSuggestions([]);
		setTabCompletion(false);

		const frozenPrompt = generatePrompt(
			state().pwd,
			state().environmentVars["HOME"],
			inputBuffer(),
		);

		terminal.execute(command);
		setState(terminal.getState());

		setOutput([
			...output(),
			frozenPrompt,
			...state().stdOut.read().map(line => line.map(entry => renderEntry(entry))),
			<div>
				<br />
			</div>,
		]);
		setHistoryOffset(0);
		setInputBuffer("");
	};

	const generatePrompt = (
		pwd: string,
		home: string | undefined,
		buffer: string,
	) => {
		const homeString =
			home && pwd.startsWith(home) ? "~/" + pwd.slice(home.length + 1) : pwd;

		return (
			<span>
				<div onClick={() => enqueueCommand("cd " + homeString)} style="color: #60b8d6; cursor: pointer;">{homeString}</div>
				<span onClick={() => enqueueCommand(buffer)} style="cursor: pointer"><span style="color: #f28779">❯</span> {buffer}</span>
			</span>
		);
	};

	const generateCursor = () => {
		return `█`;
	};

	const onKeyDown = (e: KeyboardEvent) => {
		switch (e.key) {
			case "Shift":
			case "Control":
			case "Alt":
			case "Meta":
				break;

			case "Tab":
				e.preventDefault();
				if (tabCompletion()) {
					setInputBuffer(
						terminal.autoComplete.getNextSuggestion(inputBuffer()),
					);
				} else {
					const result = terminal.autoComplete.generate(inputBuffer());
					setInputBuffer(inputBuffer() + result.unambiguousCompletion);
					if (result.suggestedCompletions.length > 1) {
						setAutocompleteSuggestions(result.suggestedCompletions);
						setTabCompletion(true);
					} else {
						setAutocompleteSuggestions([]);
						setTabCompletion(false);
					}
				}
				break;

			case "ArrowUp":
				e.preventDefault();
				if (historyOffset() < state().history.length) {
					const historyIndex = state().history.length - (1 + historyOffset());
					setInputBuffer(state().history[historyIndex]);
					setHistoryOffset(historyOffset() + 1);
				}
				break;

			case "ArrowDown":
				e.preventDefault();
				if (historyOffset() > 0) {
					const historyIndex = state().history.length - (historyOffset() - 1);
					setInputBuffer(state().history[historyIndex]);
					setHistoryOffset(historyOffset() - 1);
				} else {
					setInputBuffer("");
				}
				break;

			case "ArrowRight":
				e.preventDefault();
				break;

			case "Enter":
				executeCommand(inputBuffer());
				break;

			case "Backspace":
				setInputBuffer(inputBuffer().slice(0, -1));
				break;

			case "c":
				if (e.ctrlKey) {
					e.preventDefault();
					executeCommand("");
					break;
				}

			case "l":
				if (e.ctrlKey) {
					setOutput([""]);
					e.preventDefault();
					break;
				}

			default:
				setInputBuffer(inputBuffer() + e.key);
				e.preventDefault();
				console.log(e.key);
		}

		if (!(e.key === "Tab")) {
			setTabCompletion(false);
		}
	};

	enqueueCommand("whoami")
		.then(() => {
			return enqueueCommand("ls projects");
		})
		.then(() => {
			return enqueueCommand("pwd");
		})
		.then(() => {
			return enqueueCommand("cat projects/online_clipboard/try_now");
		});

	const renderEntry = (output: STDOutEntry): JSXElement => {
		if (typeof output === "string") {
			return <span>{output}</span>
		} else if (output.type === STDOutType.DIRECTORY) {
			return <span onClick={() => enqueueCommand("ls " + output.absolutePath)} style="color: #60b8d6; cursor: pointer;"><b>{output.absolutePath.split("/").pop()}</b></span>
		} else if (output.executable) {
			return <span onClick={() => enqueueCommand(output.absolutePath)} style="color: #f28779; cursor: pointer"><b>{output.absolutePath.split("/").pop()}</b></span>
		} else {
			return <span onClick={() => enqueueCommand("cat " + output.absolutePath)}>{output.absolutePath.split("/").pop()}</span>
		}
	}

	return (
		<div autofocus tabindex="0" onKeyDown={onKeyDown}>
			<div class={styles.terminal}>
				<div>
					<For each={output()}>{(line) => <div>{line}</div>}</For>
					{generatePrompt(
						state().pwd,
						state().environmentVars["HOME"],
						inputBuffer(),
					)}
					{generateCursor()}
					<AutocompleteSuggestions suggestions={autocompleteSuggestions()} />
				</div>
			</div>
		</div>
	);
};

export default App;
