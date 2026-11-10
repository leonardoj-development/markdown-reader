#!/bin/bash
set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)/lector-md"
VENV="$PROJECT/.venv-macos"
REQUIREMENTS="$PROJECT/requirements.txt"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ ! -f "$PROJECT/app.py" || ! -f "$REQUIREMENTS" ]]; then
    echo "No se encontró el proyecto lector-md o su archivo requirements.txt." >&2
    exit 1
fi

if [[ ! -x "$VENV/bin/python" ]]; then
    if ! command -v python3.12 >/dev/null 2>&1; then
        echo "Se necesita Python 3.12. Instálalo y vuelve a ejecutar este lanzador." >&2
        echo "Con Homebrew: brew install python@3.12" >&2
        exit 1
    fi
    echo "Preparando el entorno de Lector MD..."
    python3.12 -m venv "$VENV"
fi

CHECKSUM="$(shasum -a 256 "$REQUIREMENTS" | cut -d ' ' -f 1)"
if [[ ! -f "$VENV/.requirements-sha256" ]] || [[ "$(cat "$VENV/.requirements-sha256")" != "$CHECKSUM" ]]; then
    echo "Instalando dependencias de Lector MD..."
    "$VENV/bin/python" -m pip install -r "$REQUIREMENTS"
    printf '%s\n' "$CHECKSUM" > "$VENV/.requirements-sha256"
fi

cd "$PROJECT"
exec "$VENV/bin/python" "$PROJECT/app.py" "$@"
