# tris.sh

A personal website designed to emulate a terminal UI in the browser using [WebTUI](https://webtui.ironclad.sh).

## Design principles

The site uses WebTUI's CSS utilities and components to make the interface feel like a genuine terminal UI — character-grid-based spacing (`ch`/`lh` units), box-drawing borders, and a monospace font throughout. Layout decisions should respect character columns: gaps, padding, and element widths should be expressed in `ch` units where possible.

All text must use the same font size and font family — never set `font-size` or `font-family` on any element. Both are controlled via the `--font-size` and `--font-family` CSS variables set on `body` in `app.css`; WebTUI and all custom elements inherit from there.

## Stack

- **Framework**: SolidStart (SolidJS + Vinxi)
- **Runtime**: Bun
- **Styling**: WebTUI (`@webtui/css`) + plain CSS

## Relevant files

| Path | Purpose |
|------|---------|
| `app/src/app.tsx` | App shell — router, meta provider, social-links nav |
| `app/src/app.css` | Global styles — font, colours, WebTUI layer imports |
| `app/src/routes/index.tsx` | Home page (renders the most recent post) |
| `app/src/components/PostShell.tsx` | Persistent frame — search bar, post switcher, reader pane |
| `app/src/components/PostReader.tsx` | Renders a single post (snapshot header + body) |
| `app/src/content/posts.tsx` | Post registry + bodies |
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
