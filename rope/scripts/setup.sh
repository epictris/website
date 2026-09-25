#!/usr/bin/env bash
# Everything local development of the swing game (rope/) needs, run after a
# clone and safe to run again at any time: every step skips what is already in
# place. `just setup swing` runs it.
#
#   bun packages          bun install
#   binary assets         bun run assets:fetch (props, textures, skies, and the
#                         generated meshes the levels name; docs/asset-store.md)
#   generator Python      bun run generators:setup (rope/.venv; docs/generators.md)
#   Blender               the version the generators were built against, into
#                         ~/.local/opt with ~/.local/bin/blender pointing at it
#
# ImageMagick (the asset pipeline) and the GitHub CLI (publishing to the store)
# are only needed to ADD assets, so they are checked and reported, not
# installed: installing them wants the system package manager and sudo.

set -euo pipefail
cd "$(dirname "$0")/.."

# The generators' output is pinned to this version (docs/generators.md), and
# the sha256 is the one download.blender.org publishes for the Linux tarball.
BLENDER_VERSION=5.2.0
BLENDER_SERIES=5.2
BLENDER_LINUX_SHA256=96f6c181a30f4950607839dc84d42a354b250d8a0231b098b59b7bc69c351c48

step() { printf '\n\033[1m[setup] %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[setup] %s\033[0m\n' "$1"; }
fail() { printf '\033[31m[setup] %s\033[0m\n' "$1" >&2; exit 1; }

step "bun packages"
bun install

step "binary assets from the release store"
bun run assets:fetch

step "Python environment for the generators"
command -v python3 >/dev/null || fail "python3 is required (the boulder generator runs in it)"
bun run generators:setup

step "Blender $BLENDER_VERSION"
blender_version() { "$1" --version 2>/dev/null | head -1 | awk '{print $2}'; }
blender="${BLENDER_PATH:-$(command -v blender || true)}"
if [[ -n "$blender" && "$(blender_version "$blender")" == "$BLENDER_VERSION" ]]; then
  echo "[setup] $blender is $BLENDER_VERSION"
elif [[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]]; then
  name="blender-$BLENDER_VERSION-linux-x64"
  opt="$HOME/.local/opt"
  link="$HOME/.local/bin/blender"
  if [[ ! -x "$opt/$name/blender" ]]; then
    tarball="$(mktemp -d)/$name.tar.xz"
    trap 'rm -rf "$(dirname "$tarball")"' EXIT
    echo "[setup] downloading $name (~370 MB)"
    curl -fL --progress-bar -o "$tarball" "https://download.blender.org/release/Blender$BLENDER_SERIES/$name.tar.xz"
    echo "$BLENDER_LINUX_SHA256  $tarball" | sha256sum -c --quiet - || fail "$name.tar.xz does not match its published sha256"
    mkdir -p "$opt"
    tar -xJf "$tarball" -C "$opt"
  fi
  # Only a link this script owns is replaced: a blender someone installed at
  # that path by other means is theirs, and BLENDER_PATH is the way round it.
  if [[ -e "$link" && ! ( -L "$link" && "$(readlink "$link")" == "$opt"/blender-* ) ]]; then
    warn "$link is not a link this script made, so it is left alone; set BLENDER_PATH=$opt/$name/blender"
  else
    mkdir -p "$(dirname "$link")"
    ln -sfn "$opt/$name/blender" "$link"
    echo "[setup] $link -> $opt/$name/blender"
    [[ ":$PATH:" == *":$HOME/.local/bin:"* ]] || warn "~/.local/bin is not on PATH; add it, or set BLENDER_PATH=$link"
  fi
else
  warn "install Blender $BLENDER_VERSION from https://www.blender.org/download/ and put it on PATH or set BLENDER_PATH"
  warn "(needed only to generate rocks and mushroom patches in the editor; published ones are fetched above)"
fi

step "tools for adding assets (optional)"
command -v magick >/dev/null && echo "[setup] ImageMagick: $(command -v magick)" \
  || warn "ImageMagick (magick) not found: needed by assets:optimize-texture and the scalar-map check in cli assets"
command -v gh >/dev/null && echo "[setup] GitHub CLI: $(command -v gh)" \
  || warn "GitHub CLI (gh) not found: needed by assets:publish and assets:publish-generated"

step "done - \`just swing\` starts the dev server on http://localhost:3100"
