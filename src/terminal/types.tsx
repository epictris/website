export enum PathObjectType {
	FILE = "file",
	DIRECTORY = "directory",
}

interface FilePermissions {
	execute: boolean;
	read: boolean;
	write: boolean;
}

export interface File {
	type: PathObjectType.FILE;
	content: string;
	permissions: FilePermissions
}

export interface Directory {
	type: PathObjectType.DIRECTORY;
	children: Record<string, PathObject>;
	permissions: FilePermissions
}

export type PathObject = File | Directory;

export interface TerminalState {
	history: string[];
	pwd: string;
	stdOut: string;
	fileSystem: Directory;
	theme: Theme;
	environmentVars: Record<string, string>;
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
