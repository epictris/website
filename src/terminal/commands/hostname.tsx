import { TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	const newState = { ...state };
	newState.stdOut += "tris.sh";
	return newState;
};
