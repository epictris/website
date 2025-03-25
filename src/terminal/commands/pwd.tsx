import { TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	state.stdOut += state.pwd;
	return { ...state };
};
