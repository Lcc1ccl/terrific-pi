#!/usr/bin/env bash
# Build an offline install archive from the current terrific-pi tree.
# Usage: ./scripts/pack.sh [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-"$ROOT/dist"}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GIT_SHA="unknown"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi
NAME="terrific-pi-${STAMP}-${GIT_SHA}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/terrific-pi-pack.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT_DIR" "$STAGE/$NAME"

# Source tree only — no .git, node_modules, dist, or local junk.
tar -C "$ROOT" \
	--exclude='.git' \
	--exclude='dist' \
	--exclude='node_modules' \
	--exclude='**/node_modules' \
	--exclude='*.tgz' \
	--exclude='.DS_Store' \
	-cf - . | tar -C "$STAGE/$NAME" -xf -

# Manifest: discovered packages + provenance (drives install, tracks pack source).
{
	echo "name=terrific-pi"
	echo "packed_at_utc=$STAMP"
	echo "git_sha=$GIT_SHA"
	echo "source_root=$ROOT"
	echo "packages<<"
	# One package per extensions/<name>/package.json that declares pi.extensions
	find "$STAGE/$NAME/extensions" -mindepth 2 -maxdepth 2 -name package.json 2>/dev/null | sort | while read -r pkg; do
		dir="$(dirname "$pkg")"
		base="$(basename "$dir")"
		if command -v python3 >/dev/null 2>&1; then
			has_pi="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("1" if d.get("pi",{}).get("extensions") else "0")' "$pkg")"
			[[ "$has_pi" == "1" ]] || continue
		fi
		echo "../vendor/terrific-pi/extensions/$base"
	done
	echo ">>"
} >"$STAGE/$NAME/MANIFEST.txt"

# Root entrypoint for offline hosts that only extract the tarball.
cp "$STAGE/$NAME/scripts/install.sh" "$STAGE/$NAME/install.sh"
chmod +x "$STAGE/$NAME/scripts/install.sh" "$STAGE/$NAME/install.sh"

ARCHIVE="$OUT_DIR/${NAME}.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" "$NAME"

# Self-check: archive contains install entrypoint + at least one extension package.
python3 - "$ARCHIVE" <<'PY'
import sys, tarfile
path = sys.argv[1]
with tarfile.open(path, "r:gz") as tf:
    names = tf.getnames()
assert any(n.endswith("/install.sh") for n in names), "missing install.sh"
assert any("/extensions/" in n and n.endswith("/package.json") for n in names), "missing extension packages"
print("ok", path, "members", len(names))
PY

echo "packed: $ARCHIVE"
ls -lh "$ARCHIVE"
