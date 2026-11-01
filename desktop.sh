#!/usr/bin/env bash
# Start BasicDAW in its own window (from source). uv installs PyQt6 + python-rtmidi into .venv on first run.
cd "$(dirname "$0")" || exit 1
command -v uv >/dev/null 2>&1 || { echo "desktop.sh needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; }
exec uv run --quiet --group desktop python desktop.py "$@"
