#!/bin/sh
# Copy the compose SQLite database (volume mediary-data) to a timestamped file
# on the host. The app's DB is a single file at /data/mediary.db inside the web
# container; a plain file copy is a consistent-enough backup while the container
# is idle, and SQLite's WAL journal means copying the main file is safe when the
# app is not mid-write (worst case: last transaction lost, DB never corrupt).
# Usage (repo root): ./scripts/sqlite-backup.sh [output-dir]
set -eu
cd "$(dirname "$0")/.."
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/mediary-${STAMP}.db"
echo "==> copy SQLite DB → $FILE"
docker compose exec -T web sh -c 'cat /data/mediary.db' > "$FILE"
echo "==> OK ($(wc -c < "$FILE") bytes)"
echo "Restore: stop the web container, copy the file back, then start it again."
