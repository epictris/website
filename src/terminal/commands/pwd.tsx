import { TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	state.stdOut.writeLine(state.pwd);
	return { ...state };
};
