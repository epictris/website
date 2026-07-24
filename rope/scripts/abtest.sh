#!/usr/bin/env bash
# A/B test a physics change against an older revision, from the exact pre-issue
# game state. The sim is deterministic and a fix only changes behaviour AT the
# issue frame, so replaying a bundle to the fork frame under both revisions
# reproduces the SAME state; the diff of the two `cli fork` traces past that
# frame is precisely the change's effect. This sidesteps the trap that a bundle
# recorded on old physics diverges after a fix, making plain replay useless for
# confirming the fix landed.
#
# Old physics is run with NEW tooling: the worktree gets the old revision's
# physics (src/classes, src/engine, src/level, src/lib) but the current tree's
# tooling (src/tools, src/sim) copied over it — so `cli fork` (which may not
# exist in the old revision) is always available and both sides share one
# serialization/render path. The tooling layer only touches stable physics
# interfaces (physicsProcess, body/rope fields); if a change alters those, run
# the two `cli fork`s by hand instead.
#
# Usage:
#   scripts/abtest.sh <bundle.json> <forkFrame> [oldRef] [window]
#     <bundle.json>  self-contained bundle (embeds level + inputs)
#     <forkFrame>    frame just before the issue (see `cli fork ... --frame`)
#     [oldRef]       git ref for the "before" side (default: HEAD)
#     [window]       frames to trace past the fork (default: 24)
#
# "new" = current working tree (incl. uncommitted changes). "old" = oldRef.
set -euo pipefail

BUNDLE="${1:?usage: abtest.sh <bundle.json> <forkFrame> [oldRef] [window]}"
FRAME="${2:?missing forkFrame}"
OLD_REF="${3:-HEAD}"
WINDOW="${4:-24}"

ROPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$ROPE_DIR" rev-parse --show-toplevel)"
ROPE_REL="$(realpath --relative-to="$REPO_DIR" "$ROPE_DIR")"
BUNDLE_ABS="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"

OUT_DIR="$(mktemp -d)"
WORKTREE="$(mktemp -d)"
cleanup() { git -C "$REPO_DIR" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run_fork() { # <dir> <out-prefix>
  ( cd "$1" && bun run src/tools/cli.ts fork "$BUNDLE_ABS" \
      --frame "$FRAME" --frames "$WINDOW" --out "$2" )
}

echo "▶ new (working tree)"
run_fork "$ROPE_DIR" "$OUT_DIR/new" | tee "$OUT_DIR/new.txt"

echo
echo "▶ old ($OLD_REF) — old physics + new tooling"
git -C "$REPO_DIR" worktree add --quiet --detach "$WORKTREE" "$OLD_REF"
WT_ROPE="$WORKTREE/$ROPE_REL"
# New tooling over old physics; deps via symlink so no reinstall. Remove the
# old dirs first so cp replaces them wholesale (cp -r into an existing dir nests).
rm -rf "$WT_ROPE/src/tools" "$WT_ROPE/src/sim"
cp -r "$ROPE_DIR/src/tools" "$WT_ROPE/src/tools"
cp -r "$ROPE_DIR/src/sim" "$WT_ROPE/src/sim"
[ -e "$WT_ROPE/node_modules" ] || ln -s "$ROPE_DIR/node_modules" "$WT_ROPE/node_modules"
run_fork "$WT_ROPE" "$OUT_DIR/old" | tee "$OUT_DIR/old.txt"

echo
echo "▶ diff (old → new)  [< old, > new]"
diff "$OUT_DIR/old.txt" "$OUT_DIR/new.txt" || true

echo
echo "SVGs (open to eyeball the outcome):"
echo "  old: $OUT_DIR/old.before.svg  $OUT_DIR/old.after.svg"
echo "  new: $OUT_DIR/new.before.svg  $OUT_DIR/new.after.svg"
