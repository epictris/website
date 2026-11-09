---
name: Just Swing authoring tools
description: A midnight docked studio for precise level and sound authoring.
colors:
  studio-bg: "#11161f"
  studio-panel: "#1b2534"
  studio-raised: "#253348"
  studio-input: "#141d2b"
  studio-line: "#3c4c62"
  studio-text: "#e2eafa"
  studio-muted: "#a5b4cd"
  studio-accent: "#96beff"
  studio-selected: "#2b4265"
  studio-warm: "#edc282"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.5
  brand:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 750
    lineHeight: 1.5
rounded:
  small: "3px"
  control: "4px"
  container: "5px"
  overlay: "6px"
spacing:
  control-block: ".45lh"
  control-inline: "1.2ch"
  panel-block: "1lh"
  panel-inline: "1.8ch"
components:
  button:
    backgroundColor: "{colors.studio-raised}"
    textColor: "{colors.studio-text}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: ".45lh 1.2ch"
  button-primary:
    backgroundColor: "{colors.studio-accent}"
    textColor: "#14243d"
    rounded: "{rounded.control}"
    typography: "{typography.title}"
  button-selected:
    backgroundColor: "{colors.studio-selected}"
    textColor: "{colors.studio-accent}"
  input:
    backgroundColor: "{colors.studio-input}"
    textColor: "{colors.studio-text}"
    rounded: "{rounded.control}"
    height: "32px"
  panel:
    backgroundColor: "{colors.studio-panel}"
    textColor: "{colors.studio-text}"
---

# Design System: Just Swing authoring tools

## Overview

**Creative North Star: "Midnight Docked Studio"**

A docked studio for precise level and sound authoring. Midnight navy furniture frames the real game canvas and recording waveforms; blue identifies controls and selection, while amber singles out clip focus and time.

Compact controls share one system sans size. Hierarchy comes from weight, spacing, alignment and bounded work areas, preserving room for the artifact being edited.

**Key Characteristics:**
- Midnight tonal panels with restrained borders.
- One compact type size with tabular measurements.
- Tools and sources left; properties right.
- Real canvas and waveforms supply the visual material.

## Colors

Cool navy surfaces and pale blue controls establish a quiet working environment, with warm amber reserved for focus and time. The frontmatter records the normative shared palette from `src/styles/studio.css`.

### Primary

- **Studio Blue** (`studio-accent`): primary playback/test actions, active navigation, range controls and keyboard focus.
- **Selected Navy** (`studio-selected`): pressed controls, selected tracks and outliner rows.

### Secondary

- **Timeline Amber** (`studio-warm`): selected clip edge, playhead, meters and status emphasis; also locked-state emphasis in the editor.

### Neutral

- **Midnight Ground** (`studio-bg`): canvas-adjacent shell and arrangement ground.
- **Dock Navy** (`studio-panel`): tool docks, inspector, header and action bars.
- **Raised Navy** (`studio-raised`): resting buttons and ruler.
- **Recessed Navy** (`studio-input`): fields and waveform wells.
- **Slate Line** (`studio-line`): panel boundaries and control borders.
- **Ice Text** (`studio-text`): main content and control labels.
- **Muted Slate** (`studio-muted`): supporting labels, hints and measurements.

**The The Blue Control Rule.** Use blue for controls, navigation and general selection; reserve amber for timeline focus, time and status emphasis.

## Typography

The entire authoring shell uses the system sans stack in the frontmatter. There is no separate display face or larger heading ramp. Body, labels, titles and brand share the same size; weights distinguish roles. Headings use inherited typography, usually weight 650; ordinary buttons use 500, and the brand uses 750 with slightly tightened tracking. Numeric fields, timeline ticks and metrics use tabular numerals.

**The The One Size Rule.** Keep authoring text at the shared font size; use weight, spacing and grouping to establish hierarchy.

## Layout

A shared header (56px) carries Just Swing and authoring navigation; the action row follows. Desktop editor tools and outliner share the left dock (260px at the normal desktop size); properties occupy the right edge (276px). The canvas stays accessible between them. Docks have independent overflow rather than expanding the viewport.

The mixer uses a three-column workspace: sources (240px), a flexible arrangement, and properties (300px). At 1600px its side columns become 260px and 320px; at 1150px they become 210px and 270px. At 850px properties move below the arrangement. At 600px all mixer areas stack, while editor tools and properties become explicit, initially closed drawers; opening one closes the other. The timeline retains its internal horizontal scrolling and minimum width (600px).

Spacing follows line-height and character-width units for compact controls and panels. Use the frontmatter's reused spacing values rather than imposing a new pixel scale. The sound lab is a bounded sibling surface (120ch maximum width).

**The The Dock Rule.** Keep desktop furniture at the workspace edges and let the working artifact occupy the center.

## Elevation & Depth

Desktop docks are flat and separated by tonal fills and single-pixel borders. The final dock override removes the old toolbar shadow. Floating help, pickers and sound assignment overlays may retain inherited soft shadows; these are local overlay affordances, not the material treatment for every panel. No animation token or transition system is established in the shared studio stylesheet.

## Shapes

Controls use modest rounded corners, with smaller rounding for chips and clips. Timeline wells, lab cards and mobile drawers use the container radius; sound overlays retain the overlay radius. Desktop edge docks have square corners and continuous boundaries. Avoid treating each dock section as a separate floating card.

## Components

### Buttons and navigation

Raised navy buttons carry clear text. Primary playback and test controls use pale blue with dark ink. Pressed controls combine selected navy, blue text and a visible accent border. Hover and active fills are distinct; disabled controls reduce opacity. Keyboard focus uses a blue outline (2px) with an offset (3px). Authoring links use an active bottom border and `aria-current="page"`.

### Inputs and precision controls

Recessed fields use slate borders and the shared control radius, with minimum height (32px); editor buttons use a compact minimum (30px). Number fields commonly occupy 9ch. Mixer effect controls pair labeled numeric inputs with ranges where appropriate, preserving units, limits and steps. Native checkboxes and ranges use the blue accent.

### Panels and disclosures

Tool, source and property panels share the same navy surface and muted label treatment. Mixer effects and help use native details/summary. Editor sections and sound families use native buttons with `aria-expanded` and shared SVG chevrons; editor section state persists across rebuilds. Shared play, close and chevron SVGs have consistent thin strokes and are hidden from assistive technology; the owning control supplies the accessible name.

### Source browser and sound assignments

Search filters real recording names and exposes counts and empty recovery. Assignment chips use selected navy with separate named audition/unassign actions. Source credits remain part of the workflow.

### Timeline

Track headers sit above gridded lanes. Clips use blue fills and borders; selected clips gain a thicker amber edge. The amber playhead is separate from the blue keyboard focus outline. Muted tracks dim clips. Preserve keyboard selection, nudging and focus when the arrangement is rebuilt.

## Do's and Don'ts

### Do:

- **Do** use the shared studio tokens and system sans stack.
- **Do** pair exact numeric values with sliders where both precision and audition matter.
- **Do** provide visible keyboard focus, accessible control names and native keyboard-operable disclosures.
- **Do** preserve distinct Save draft, Export WAV and Apply to game actions.
- **Do** keep mobile editor drawers closed initially and mutually exclusive.

### Don't:

- **Don't** reintroduce the retired cyan monospace authoring identity.
- **Don't** use amber as the general navigation or button accent.
- **Don't** enlarge headings to create hierarchy within the compact authoring shell.
- **Don't** substitute decorative imagery for real canvas content or waveforms.
