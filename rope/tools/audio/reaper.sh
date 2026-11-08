#!/usr/bin/env bash
# Isolated configuration keeps this workstation separate from personal REAPER settings.
set -euo pipefail
audio_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
reaper_bin="$audio_dir/.local/reaper_linux_x86_64/REAPER/reaper"
if [[ ! -x "$reaper_bin" ]]; then
  echo "REAPER is missing. Extract the official Linux x86_64 archive under tools/audio/.local/." >&2
  exit 1
fi
mkdir -p "$audio_dir/.local/config"
exec "$reaper_bin" -newinst -cfgfile "$audio_dir/.local/config/reaper.ini" "$@"
