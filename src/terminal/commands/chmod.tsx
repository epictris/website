import { resolvePath } from "../string_util";
import { TerminalState } from "../types";

enum PermissionType {
	EXECUTE = "x",
}

enum PermissionModifier {
	ADD = "+",
	REMOVE = "-",
}

export default (args: string[], state: TerminalState): TerminalState => {
	const [permissionsArg, pathArg] = args;

	if (!pathArg || !permissionsArg) {
		return { ...state, stdOut: "chmod: missing operand" };
	}

	const modifier = permissionsArg[0];
	const type = permissionsArg[1];


	if (
		!(Object.values<string>(PermissionModifier).includes(modifier)) ||
		!(Object.values<string>(PermissionType).includes(type))
	) {
		return { ...state, stdOut: "chmod: invalid operand" };
	}

	const path = resolvePath(pathArg, state);

	if (!path) {
		return {
			...state,
			stdOut: `chmod: cannot access '${pathArg}': No such file or directory`,
		};
	}

	if (modifier === PermissionModifier.ADD) {
		path.executable = true;
	} else {
		path.executable = false;
	}

	return { ...state };
};
