"""params.json and the add-on agree, and every parameter has somewhere to go.

mushroom_patch_tools.py installs into Blender as one file, so it keeps its own
defaults: the node group's sockets and the LOOK table. The level editor's
generator sets every one of them from params.json, so the two only matter
together when they drift; this fails when they do. Read with ast, since both
modules import bpy.

Run by `bun run generators:check`, or directly:

    python tools/blender/mushrooms/test_params.py
"""
import ast
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Where the level editor deliberately differs from the add-on's socket default:
# the fork's editor sent detail 0.3 (about 330 triangles a mushroom) where the
# add-on's own panel starts at 0.5.
EDITOR_CHOICES = {"detail": (0.3, 0.5)}


def literal(node, constants):
    if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "radians":
        return ("deg", literal(node.args[0], constants))
    if isinstance(node, ast.Name):
        return constants[node.id]
    return ast.literal_eval(node)


def module_constants(tree):
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            try:
                value = ast.literal_eval(node.value)
            except ValueError:
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out[target.id] = value
                elif isinstance(target, ast.Tuple) and isinstance(value, tuple):
                    for name, v in zip(target.elts, value):
                        out[name.id] = v
    return out


def main():
    schema = {p["key"]: p["default"] for p in json.loads((HERE / "params.json").read_text())["params"]}
    tools = ast.parse((HERE / "mushroom_patch_tools.py").read_text())
    constants = module_constants(tools)

    look_node = next(n for n in tools.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "LOOK")
    look = {ast.literal_eval(k): literal(v, constants) for k, v in zip(look_node.value.keys, look_node.value.values)}
    for key, value in look.items():
        assert schema[key] == value, f"LOOK[{key}] = {value}, params.json says {schema[key]}"

    group = next(n for n in tools.body if isinstance(n, ast.FunctionDef) and n.name == "build_group")
    sockets = {}
    for call in ast.walk(group):
        if isinstance(call, ast.Call) and getattr(call.func, "id", None) == "param":
            sockets[ast.literal_eval(call.args[0])] = literal(call.args[2], constants)

    patch = ast.parse((HERE / "editor_patch.py").read_text())
    table = next(n for n in patch.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "SOCKETS")
    socket_of = {ast.literal_eval(k): ast.literal_eval(v.elts[0]) for k, v in zip(table.value.keys, table.value.values)}
    editor_side = next(ast.literal_eval(n.value) for n in patch.body
                       if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "EDITOR_SIDE")

    for key, name in socket_of.items():
        addon = sockets[name]
        if isinstance(addon, tuple):  # an ANGLE socket, authored in degrees
            addon = addon[1]
        if key in EDITOR_CHOICES:
            assert (schema[key], addon) == EDITOR_CHOICES[key], f"{key}: {schema[key]} / add-on {addon}"
            continue
        assert math.isclose(float(schema[key]), float(addon)), f"{key}: params.json {schema[key]}, socket {name} {addon}"

    homeless = set(schema) - set(socket_of) - set(look) - editor_side
    assert not homeless, f"parameters nothing reads: {sorted(homeless)}"
    unset = set(sockets) - set(socket_of.values()) - {"Show Area"}
    assert not unset, f"sockets the editor never sets: {sorted(unset)}"
    print(f"mushroom params: {len(socket_of)} sockets and {len(look)} look knobs agree with params.json; "
          f"{len(editor_side)} editor-side limits")


if __name__ == "__main__":
    main()
