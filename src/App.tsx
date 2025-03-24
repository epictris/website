import { createSignal, For, JSX, onMount, type Component } from "solid-js";

import styles from "./App.module.css";
import { execute as Execute, initState } from "./Terminal";

interface Prompt {
	pwd: string;
	execute: (command: string) => JSX.Element[];
}

const Prompt: Component<Prompt> = (props) => {
	const [outputLines, setOutputLines] = createSignal<JSX.Element[]>([]);

	return (
		<div>
			<div class="row">{props.pwd}</div>
			<div class="row prompt">
				<span>❯ </span>
				<input
					onKeyDown={(e) =>
						e.key === "Enter" &&
						setOutputLines(props.execute(e.currentTarget.value))
					}
				/>
			</div>
			{outputLines().map((value) => (
				<div class="row">{value}</div>
			))}
		</div>
	);
};

const App: Component = () => {
	const [state, setState] = createSignal(initState());

	const getCwd = (): string => {
		return "/";
	};

	const execute = (command: string): JSX.Element[] => {
		setEntries([...entries(), { pwd: getCwd(), execute, value: "" }]);
		return [<div>{command}</div>];
	};

	const initPrompt = (): void => {
		setEntries([{ pwd: getCwd(), execute, value: "" }]);
	};

	const [entries, setEntries] = createSignal<Prompt[]>([]);
	initPrompt();

	return (
		<div class={styles.terminal}>
			<For each={entries()}>{(entry) => <Prompt {...entry} />}</For>
			<Prompt />
		</div>
	);
};

export default App;
