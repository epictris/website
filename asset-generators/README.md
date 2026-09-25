# Procedural asset generators

These source projects power the level editor's **Generate roots**, **Generate
vine v3**, **Generate boulder v5**, **Generate dirt + moss**, and **Generate mushrooms** controls. Generated meshes, renders,
caches, and texture outputs are intentionally excluded from Git.

## Windows setup

Install Blender 5.2, Python 3.11 or newer, and Bun. From the repository root,
create a Python virtual environment and install the generator dependencies:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r .\asset-generators\requirements.txt
```

If PowerShell blocks activation, the environment can still be used without
activating it:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\asset-generators\requirements.txt
```

Generate the local bark texture inputs used by roots. These files are ignored
by Git and can be recreated at any time:

```powershell
.\.venv\Scripts\python.exe .\asset-generators\roots\make_bark.py
```

Start the editor with the virtual environment's Python available to the
boulder generator:

```powershell
$env:PYTHON_PATH = (Resolve-Path .\.venv\Scripts\python.exe)
$env:BLENDER_PATH = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
cd .\rope
bun install
bun run dev
```

Open `http://localhost:3100/editor`. The editor uses the tracked generator
directories automatically. `ROOTS_PROJECT`, `BOULDERS_V5_PROJECT`, and `DIRT_MOSS_PROJECT` may still
be set to override them.

The environment variables last for the current PowerShell window. Set them
again after opening a new window.

## Repository layout

- `roots/` contains the root and vine v3 Blender generators.
- `boulders/stylised_rocks_v5/` contains the boulder v5 generator.
- `dirt_moss/` contains the dirt and moss generator, using the boulder v5 shared helpers.
- `mushrooms/` contains the glowing mushroom patch Blender add-on
  (`mushroom_patch_tools.py`, copied from `blender/mushroom_patch`) and
  `editor_patch.py`, which grows a patch on the faces picked in the editor.
  Override it with `MUSHROOMS_PROJECT`.
- `requirements.txt` contains all packages installed into the virtual
  environment.

Output files go into `rope/public/generated-roots`,
`rope/public/generated-vines`, `rope/public/generated-boulders`,
`rope/public/generated-dirt-moss`, and
`rope/public/generated-mushrooms`. Those
directories remain untracked build output.
