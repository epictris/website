import { resolvePath } from "../string_util";
import { PathObjectType, TerminalState } from "../types";

export default (args: string[], state: TerminalState): TerminalState => {
	for (let [name, value] of Object.entries(state.environmentVars)) {
		state.stdOut += `${name}=${value}\r\n`;
	}
	return { ...state };
};
