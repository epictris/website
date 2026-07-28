# tris.sh

A personal website designed to emulate a terminal UI in the browser using [WebTUI](https://webtui.ironclad.sh).

## Design principles

The site uses WebTUI's CSS utilities and components to make the interface feel like a genuine terminal UI — character-grid-based spacing (`ch`/`lh` units), box-drawing borders, and a monospace font throughout. Layout decisions should respect character columns: gaps, padding, and element widths should be expressed in `ch` units where possible.

All text must use the same font size and font family — never set `font-size` or `font-family` on any element. Both are controlled via the `--font-size` and `--font-family` CSS variables set on `body` in `app.css`; WebTUI and all custom elements inherit from there.

## Colours

| Role | Value |
|------|-------|
| Background | `#1f2430` |
| Foreground | `#cbccc6` |
| Accent (title) | `#65bddb` |
| Border | `#313244` |

## Running locally

```sh
cd app
bun run dev
```
