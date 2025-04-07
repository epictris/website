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
	path: string,
	content: string;
	permissions: FilePermissions;
}

export interface Directory {
	type: PathObjectType.DIRECTORY;
	path: string,
	children: Record<string, PathObject>;
	permissions: FilePermissions;
}

export type PathObject = File | Directory;

export enum STDOutType {
	DIRECTORY = "directory",
	FILE = "file",
	EXECUTABLE = "executable",
}

export interface STDOutDirectory {
	type: STDOutType.DIRECTORY;
	absolutePath: string;
}

export interface STDOutFile {
	type: STDOutType.FILE;
	absolutePath: string;
	executable: boolean;
}

export type STDOutEntry = STDOutDirectory | STDOutFile | string;

export class STDOut {
	private lines: STDOutEntry[][];
	private currentLine: STDOutEntry[];

	constructor() {
		this.lines = [];
		this.currentLine = [];
	}
	write(entry: STDOutEntry) {
		this.currentLine.push(entry);
	}
	writeLine(entry?: STDOutEntry) {
		if (entry != null) {
			this.currentLine.push(entry);
		}
		this.lines.push(this.currentLine);
		this.currentLine = []
	}
	clear() {
		this.currentLine = []
		this.lines = [];
	}
	read(): STDOutEntry[][] {
		return this.lines;
	}
}

export interface TerminalState {
	history: string[];
	pwd: string;
	stdOut: STDOut;
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
