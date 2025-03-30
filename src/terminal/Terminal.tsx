import cat from "./commands/cat";
import cd from "./commands/cd";
import chmod from "./commands/chmod";
import hostname from "./commands/hostname";
import ls from "./commands/ls";
import mkdir from "./commands/mkdir";
import printenv from "./commands/printenv";
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
	hostname,
	touch,
	rm,
	pwd,
	mkdir,
	chmod,
	whoami,
	printenv,
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
		pwd: "/home/tris",
		stdOut: "",
		environmentVars: {
			USER: "tris",
			HOSTNAME: "tris.sh",
			HOME: "/home/tris",
			PWD: "/home/tris",
		},
		fileSystem: {
			type: PathObjectType.DIRECTORY,
			permissions: { execute: true, read: true, write: true },
			children: {
				home: {
					type: PathObjectType.DIRECTORY,
					permissions: { execute: true, read: true, write: true },
					children: {
						tris: {
							type: PathObjectType.DIRECTORY,
							permissions: { execute: true, read: true, write: true },
							children: {
								projects: {
									type: PathObjectType.DIRECTORY,
									permissions: { execute: true, read: true, write: true },
									children: {
										online_clipboard: {
											type: PathObjectType.DIRECTORY,
											permissions: { execute: true, read: true, write: true },
											children: {
												try_now: {
													type: PathObjectType.FILE,
													permissions: { execute: true, read: true, write: true },
													content: "https://clipboard.tris.sh",
												},
												GitHub: {
													type: PathObjectType.FILE,
													permissions: { execute: true, read: true, write: true },
													content: "https://github.com/epictris/clipboard",
												}
											}
										},
										pattern_linter_language_server: {
											type: PathObjectType.DIRECTORY,
											permissions: { execute: true, read: true, write: true },
											children: {
												GitHub: {
													type: PathObjectType.FILE,
													permissions: { execute: true, read: true, write: true },
													content: "https://github.com/epictris/splints",
												},
												PyPI: {
													type: PathObjectType.FILE,
													permissions: { execute: true, read: true, write: true },
													content: "https://pypi.org/project/splints",
												}
											}
										},
										personal_website: {
											type: PathObjectType.DIRECTORY,
											permissions: { execute: true, read: true, write: true },
											children: {
												GitHub: {
													type: PathObjectType.FILE,
													permissions: { execute: true, read: true, write: true },
													content: "https://github.com/epictris/website",
												},
											}
										},
										character_sheet_builder: {
											type: PathObjectType.DIRECTORY,
											permissions: { execute: true, read: true, write: true },
											children: {
												GitHub: {
													type: PathObjectType.FILE,
													permissions: { execute: true, read: true, write: true },
													content: "https://github.com/epictris/canvas-character-sheet",
												},
											}
										}
									}
								},
								".config": {
									type: PathObjectType.DIRECTORY,
									permissions: { execute: true, read: true, write: true },
									children: {

									}
								}
							},
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
