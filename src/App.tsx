import { createSignal, JSX, type Component } from "solid-js";

import styles from "./App.module.css";
import * as Terminal from "./terminal/Terminal";
import { render } from "solid-js/web";

const renderToText = (jsx: JSX.Element): string => {
	const div = document.createElement("div");
	document.body.appendChild(div);
	render(() => jsx, div);
	const html = div.innerHTML;
	div.remove();
	return html;
};

const App: Component = () => {
	const [state, setState] = createSignal(Terminal.initState());
	const [inputBuffer, setInputBuffer] = createSignal("");
	const [output, setOutput] = createSignal<string>(renderToText(<br />));
	const [historyOffset, setHistoryOffset] = createSignal(0);

	const executeCommand = (command: string): void => {
		const frozenPrompt =
			renderToText(generatePrompt(state().pwd, inputBuffer())) +
			renderToText(<br />);
		setState(Terminal.execute(state(), command));
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
				setInputBuffer(Terminal.tabComplete(inputBuffer(), state()));
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
	};

	return (
		<div autofocus tabindex="0" class={styles.terminal} onKeyDown={onKeyDown}>
			<div innerHTML={output()} />
			{generatePrompt(state().pwd, inputBuffer())}
			{generateCursor()}
		</div>
	);
};

export default App;
