# Install a subproject's dev dependencies: just setup [app|swing]
setup PROJECT="app":
    just _setup-{{PROJECT}}

_setup-app:
    cd app && bun install

# The swing game (rope/): bun packages, the asset store, the generators' Python
# and Blender. Safe to re-run; see rope/scripts/setup.sh.
_setup-swing:
    rope/scripts/setup.sh

# Run a subproject's dev server: just run [app|rope|pool|3d]
run PROJECT="app":
    bun run --cwd {{PROJECT}} dev

swing:
    bun run --cwd rope dev

check:
    cd app && bun run typecheck && bun run lint

fmt:
    cd app && bun run format

check-all:
    cd app && bun run format && bun run typecheck && bun run lint

# Optimise a 3D prop, then upload it to the asset release. Paths are relative to
# rope/, since that is where the recipe runs. See "The asset store" in rope/CLAUDE.md.
#   just asset assets-src/rock.glb public/meshes/rock.glb
asset IN OUT:
    cd rope && bun run assets:optimize {{IN}} {{OUT}} && bun run assets:publish {{OUT}}

# The same for one map of a PBR texture set. MAP is base|normal|roughness|metallic|ao,
# and it picks the encoding as well as the slot - an albedo is a picture and is
# encoded lossily, the other four are data and are not.
#   just texture assets-src/stone_col.png public/textures/quarry-stone-base.webp base
texture IN OUT MAP:
    cd rope && bun run assets:optimize-texture {{IN}} {{OUT}} --map {{MAP}} && bun run assets:publish {{OUT}}

# Pull the props, textures and Blender scenes this checkout's manifests name into rope/public/.
assets:
    cd rope && bun run assets:fetch

# Pull the Blender scenes' sources (their .blend files and the pictures their
# tools paint with) into rope/assets-src/. Never overwrites a file with
# unpublished edits. See rope/scripts/sceneSources.ts.
sources:
    cd rope && bun run assets:fetch-sources

# Publish the Blender scenes the levels name to the asset release and pin them in
# rope/src/render3d/sceneAssets.json, and those scenes' sources (their .blend
# files, pinned in rope/scripts/sceneSources.json). Run it after `just scene`,
# then commit the pins with the level.
publish:
    cd rope && bun run assets:publish-scenes && bun run assets:publish-sources

# Export a level's Blender scene (rope/assets-src/scenes/<scene>.blend, the
# level's `scene`) into rope/public/scenes/<scene>/ and report what it dressed.
# Then refresh the browser. See rope/docs/blender-scenes.md.
#   just scene ball
scene LEVEL:
    cd rope && bun run scene:export {{LEVEL}}

# Install the moss add-on (rope/tools/blender/moss): paint painterly moss onto a
# scene's rocks. Links it into the user extensions, enables it and saves the
# preferences; then the Moss tab is in the 3D viewport's sidebar.
# See rope/docs/blender-moss.md.
moss-install:
    cd rope && blender -b --python tools/blender/addon_install.py -- moss

# Install the ivy add-on (rope/tools/blender/ivy; the "moss" add-on until
# 2026-10-02): paint carpets of flat ivy leaves and hang vines. Then the Ivy
# tab is in the 3D viewport's sidebar. See rope/docs/blender-ivy.md.
ivy-install:
    cd rope && blender -b --python tools/blender/addon_install.py -- ivy

# Install the formations add-on (rope/tools/blender/formations): rock masses
# from outlines, edited through the game camera, and what grows on them. Then
# the Formations tab is in the 3D viewport's sidebar.
# See rope/docs/blender-formations.md.
formations-install:
    cd rope && blender -b --python tools/blender/addon_install.py -- formations

# Write the level's collision and its game camera (along the camera paths, or
# along a recorded run: just scene-guide ball --ride playtests/x.json.gz) into
# <scene>-guide.blend as a linked guide to model against, and create
# <scene>.blend linking it if there is none yet.
#   just scene-guide ball
scene-guide LEVEL *ARGS:
    cd rope && bun run scene:guide {{LEVEL}} {{ARGS}}
