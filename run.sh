#!/usr/bin/env bash
# Start BasicDAW. With uv, python-rtmidi (the MIDI / Midinous bridge) is installed into .venv on first run.
cd "$(dirname "$0")" || exit 1
if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet python server.py "$@"
fi
echo "uv not found - starting without the MIDI bridge (pip install python-rtmidi to enable it)" >&2
exec python3 server.py "$@"
