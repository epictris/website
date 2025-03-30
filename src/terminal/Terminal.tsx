import cat from "./commands/cat";
import cd from "./commands/cd";
import chmod from "./commands/chmod";
import ls from "./commands/ls";
import mkdir from "./commands/mkdir";
import pwd from "./commands/pwd";
import rm from "./commands/rm";
import touch from "./commands/touch";
import whoami from "./commands/whoami";
import AutoComplete from "./features/autocomplete";
import { resolvePath } from "./string_util";
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

export class Terminal {
	private state: TerminalState;
	public autoComplete: AutoComplete;

	constructor() {
		this.state = initState();
		this.autoComplete = new AutoComplete(this);
	}
	execute(command: string): void {
		this.state.stdOut = "";
		const parsedCommand = parseCommand(command);
		if (!parsedCommand) {
			return;
		}
		this.state.history.push(command);
		if (!COMMAND_MAPPING[parsedCommand.command]) {
			const executableFile = resolvePath(parsedCommand.command, this.state);
			if (
				!executableFile ||
				executableFile.type !== PathObjectType.FILE ||
				!executableFile.permissions.execute
			) {
				this.state.stdOut = `command not found: ${parsedCommand.command}\r\n`;
				return;
			} else {
				window.open(encodeURI(executableFile.content), "_blank");
				return;
			}
		}

		this.state = COMMAND_MAPPING[parsedCommand.command](
			parsedCommand.args,
			this.state,
		);
	}

	getState(): TerminalState {
		return this.state;
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

export const initState: () => TerminalState = () => {
	return {
		history: [],
		pwd: "/",
		stdOut: "",
		fileSystem: {
			type: PathObjectType.DIRECTORY,
			permissions: { execute: false, read: true, write: true },
			children: {
				"hello_world.txt": {
					type: PathObjectType.FILE,
					permissions: { execute: false, read: true, write: true },
					content: "Hello World!",
				},
				"hello_world_2.txt": {
					type: PathObjectType.FILE,
					permissions: { execute: false, read: true, write: true },
					content: "Hello World (2)!",
				},
				executable_file: {
					type: PathObjectType.FILE,
					permissions: { execute: true, read: true, write: true },
					content: "https://google.com",
				},
				example_dir: {
					type: PathObjectType.DIRECTORY,
					permissions: { execute: false, read: true, write: true },
					children: {
						nested_file: {
							type: PathObjectType.FILE,
							permissions: { execute: false, read: true, write: true },
							content: '{"hello": "world"}',
						},
						nested_dir: {
							type: PathObjectType.DIRECTORY,
							permissions: { execute: false, read: true, write: true },
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
