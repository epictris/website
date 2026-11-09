# Just Swing authoring tools

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

These development tools support authoring levels and sound for the Just Swing browser game. The level editor manipulates collision geometry, lights, cameras, paths, and notes and provides an in-game test. The sound mixer arranges original recordings into editable event variations.

## Workflows

- Level editor: choose a level, workspace and layer; draw or select objects; edit properties; test and save. Level edits autosave.
- Sounds: audition recordings, assign event variations and tune event playback.
- Sound layers: choose an event and variation; arrange and trim clips; edit effects; preview; save a draft, export WAV, or apply a variation to the game.
- Sound lab: compare candidate recordings and export feedback.

## Constraints

Preserve existing authoring behavior, keyboard shortcuts, API routes, persistence, source credits, and audio processing. Draft saving and applying audio to the game are distinct actions. The editor is canvas based; its DOM furniture must leave the canvas reachable. No changes to gameplay or simulation are in scope.

## Current brief

The user requested Impeccable UI improvements to the level editor and sound mixer, explicitly released the old visual style, and requested autonomous execution. Desktop authoring is the primary usage inferred from the existing controls; narrower screens must retain access to controls. These statements describe repository evidence and the current request, rather than a separate product interview.
