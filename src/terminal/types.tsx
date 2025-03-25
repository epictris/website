export enum PathObjectType {
	FILE = "file",
	DIRECTORY = "directory",
}

export interface File {
	type: PathObjectType.FILE;
	content: string;
}

export interface Directory {
	type: PathObjectType.DIRECTORY;
	children: Record<string, PathObject>;
}

export type PathObject = File | Directory;

export interface TerminalState {
	history: string[];
	pwd: string;
	stdOut: string;
	fileSystem: Directory;
	theme: Theme;
}

export interface Theme {
	background: string;
	foreground: string;
	bright_foreground: string;

	black: string;
	red: string;
	green: string;
	yellow: string;
	blue: string;
	magenta: string;
	cyan: string;
	white: string;

	brightBlack: string;
	brightRed: string;
	brightGreen: string;
	brightYellow: string;
	brightBlue: string;
	brightMagenta: string;
	brightCyan: string;
	brightWhite: string;
}
