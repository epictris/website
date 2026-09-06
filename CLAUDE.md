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

## Working practices

### Validate the behaviour before writing the cases

When a change is about how something FEELS - a camera, a control, a piece of game feel - do not write regression cases for it until the behaviour has been played and confirmed as the thing that was asked for.

A case written against an unvalidated behaviour is a case written twice: the bars encode the numbers the current attempt happens to produce, and the next attempt reddens all of them for no reason other than having changed.
Worse, they read as coverage while they are really a snapshot, so the temptation on the next pass is to nudge the bars rather than the behaviour.

Get the measurement, hand it over to be played, and write the cases once the shape is settled.

### Bash timeouts

Never run a Bash command with a timeout greater than 30s unless a long timeout is explicitly necessary and justified.

A high timeout is almost always guessing.
When the guess is wrong the command does not fail fast - it sits there, and fifteen minutes are spent learning nothing at all.
A command that would genuinely take minutes is nearly always the wrong command: shrink the workload (fewer frames, fewer iterations, a smaller input) until it fits inside 30s, and measure from that.

If something really does need longer, say why before running it, and prefer `run_in_background` over a long blocking timeout so the session is not held hostage while it runs.
