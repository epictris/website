import { createSignal, JSX, type Component } from "solid-js";

import styles from "./App.module.css";
import { Terminal } from "./terminal/Terminal";
import { render } from "solid-js/web";

const renderToText = (jsx: JSX.Element): string => {
	const div = document.createElement("div");
	document.body.appendChild(div);
	render(() => jsx, div);
	const html = div.innerHTML;
	div.remove();
	return html;
};

const AutocompleteSuggestions: Component<{ suggestions: string[] }> = (
	props,
) => {
	return (
		<div>
			{props.suggestions.map((suggestion) => (
				<div>{suggestion}</div>
			))}
		</div>
	);
};

const App: Component = () => {
	const terminal = new Terminal();

	const [tabCompletion, setTabCompletion] = createSignal(false);
	const [autocompleteSuggestions, setAutocompleteSuggestions] = createSignal<
		string[]
	>([]);
	const [state, setState] = createSignal(terminal.getState());
	const [inputBuffer, setInputBuffer] = createSignal("");
	const [output, setOutput] = createSignal<string>(renderToText(<br />));
	const [historyOffset, setHistoryOffset] = createSignal(0);

	const executeCommand = (command: string): void => {
		const frozenPrompt =
			renderToText(generatePrompt(state().pwd, inputBuffer())) +
			renderToText(<br />);

		terminal.execute(command);
		setState(terminal.getState());

		setOutput(
			output() +
				frozenPrompt +
				state().stdOut +
				renderToText(
					<div>
						<br />
					</div>,
				),
		);
		setHistoryOffset(0);
		setInputBuffer("");
	};

	const generatePrompt = (pwd: string, buffer: string) => {
		return (
			<span>
				<div style="color: #60b8d6">{pwd}</div>
				<span style="color: #f28779">❯</span> {buffer}
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
					console.log(result);
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

			case "Enter":
				executeCommand(inputBuffer());
				break;

			case "Backspace":
				setInputBuffer(inputBuffer().slice(0, -1));
				break;

			case "l":
				if (e.ctrlKey) {
					setOutput("");
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

	return (
		<div autofocus tabindex="0" class={styles.terminal} onKeyDown={onKeyDown}>
			<div innerHTML={output()} />
			{generatePrompt(state().pwd, inputBuffer())}
			{generateCursor()}
			<AutocompleteSuggestions suggestions={autocompleteSuggestions()} />
		</div>
	);
};

export default App;
