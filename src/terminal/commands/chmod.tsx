import { resolvePath } from "../string_util";
import { TerminalState } from "../types";

enum PermissionType {
	EXECUTE = "x",
	READ = "r",
	WRITE = "w",
}

enum PermissionModifier {
	ADD = "+",
	REMOVE = "-",
	SET = "=",
}

export default (args: string[], state: TerminalState): TerminalState => {
	const [permissionsArg, pathArg] = args;

	if (!pathArg || !permissionsArg) {
		return { ...state, stdOut: "chmod: missing operand" };
	}

	const modifier = permissionsArg[0];
	const permissionTypes = permissionsArg.slice(1, permissionsArg.length);

	if (
		!Object.values<string>(PermissionModifier).includes(modifier) ||
		permissionTypes.length === 0
	) {
		return { ...state, stdOut: "chmod: invalid operand" };
	}

	for (let type of permissionTypes) {
		if (!Object.values<string>(PermissionType).includes(type)) {
			return { ...state, stdOut: "chmod: invalid operand" };
		}
	}

	const path = resolvePath(pathArg, state);

	if (!path) {
		return {
			...state,
			stdOut: `chmod: cannot access '${pathArg}': No such file or directory`,
		};
	}

	if (modifier === PermissionModifier.ADD) {
		if (permissionTypes.includes(PermissionType.EXECUTE)) {
			path.permissions.execute = true;
		}
		if (permissionTypes.includes(PermissionType.READ)) {
			path.permissions.read = true;
		}
		if (permissionTypes.includes(PermissionType.WRITE)) {
			path.permissions.write = true;
		}
	} else if (modifier === PermissionModifier.REMOVE) {
		if (permissionTypes.includes(PermissionType.EXECUTE)) {
			path.permissions.execute = false;
		}
		if (permissionTypes.includes(PermissionType.READ)) {
			path.permissions.read = false;
		}
		if (permissionTypes.includes(PermissionType.WRITE)) {
			path.permissions.write = false;
		}
	} else if (modifier === PermissionModifier.SET) {
		path.permissions.execute = false;
		path.permissions.read = false;
		path.permissions.write = false;

		if (permissionTypes.includes(PermissionType.EXECUTE)) {
			path.permissions.execute = true;
		}
		if (permissionTypes.includes(PermissionType.READ)) {
			path.permissions.read = true;
		}
		if (permissionTypes.includes(PermissionType.WRITE)) {
			path.permissions.write = true;
		}
	}

	return { ...state };
};
