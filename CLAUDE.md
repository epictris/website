# tris.sh

A personal website designed to emulate a terminal UI in the browser using [WebTUI](https://webtui.ironclad.sh).

## Design principles

The site uses WebTUI's CSS utilities and components to make the interface feel like a genuine terminal UI — character-grid-based spacing (`ch`/`lh` units), box-drawing borders, and a monospace font throughout. Layout decisions should respect character columns: gaps, padding, and element widths should be expressed in `ch` units where possible.

## Stack

- **Framework**: SolidStart (SolidJS + Vinxi)
- **Runtime**: Bun
- **Styling**: WebTUI (`@webtui/css`) + plain CSS

## Relevant files

| Path | Purpose |
|------|---------|
| `app/src/app.tsx` | App shell — router, meta provider, global view wrapper |
| `app/src/app.css` | Global styles — font, colours, WebTUI layer imports |
| `app/src/routes/index.tsx` | Home page |
| `app/src/routes/index.css` | Home page styles |
| `app/public/fonts/` | Self-hosted Fantasque Sans Mono Nerd Font (Regular + Bold) |

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
