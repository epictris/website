import { createSignal, For, JSX, onMount, type Component } from "solid-js";

import styles from "./App.module.css";
import * as Terminal from "./Terminal";

interface Prompt {
	prefixCharacters: () => JSX.Element;
	prefixLines: () => JSX.Element[];
	executeCommand: (command: string) => void;
}

const Prompt: Component<Prompt> = (props) => {
	const [value, setValue] = createSignal("");

	return (
		<div>
			<div class="row">
				{props.prefixLines().map((line) => (
					<div class="row">{line}</div>
				))}
				<span>{props.prefixCharacters()}</span>
				<input
					value={value()}
					onKeyDown={(e) =>
						e.key === "Enter" &&
						(() => {
							props.executeCommand(e.currentTarget.value);
							setValue("");
							console.log("test");
						})()
					}
				/>
			</div>
		</div>
	);
};

const App: Component = () => {
	const [state, setState] = createSignal(Terminal.initState());
	const [inputBuffer, setInputBuffer] = createSignal("");
	const [outputs, setOutputs] = createSignal<string[]>([]);

	const executeCommand = (command: string): void => {
		setState(Terminal.execute(state(), command));
		setOutputs((outputs) => [...outputs, state().stdOut]);
	};

	const generatePrompt = () => {
		return `${state().pwd}\r\n❯ `
	}

	const generateCursor = () => {
		return `█`
	}

	const onKeyDown = (e: KeyboardEvent) => {
		switch (e.key) {

			case "Shift":
			case "Control":
			case "Alt":
			case "Meta":
				break;

			case "Enter":
				setOutputs([...outputs(), generatePrompt() + inputBuffer()])
				executeCommand(inputBuffer())
				setInputBuffer("")
				break

			case "Backspace":
				setInputBuffer(inputBuffer().slice(0, -1))
				break

			default:
				setInputBuffer(inputBuffer() + e.key)
			console.log(e.key)
		}
	}

	return (
		<div autofocus tabindex="0" class={styles.terminal} onKeyDown={onKeyDown}>
			<For each={outputs()}>{(output) => <div>{output}</div>}</For>
			{generatePrompt()}{inputBuffer()}{generateCursor()}
		</div>
	);
};

export default App;
