import { resolvePath } from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	const newState = { ...state };
	newState.stdOut.writeLine("tris");
	return newState;
};
