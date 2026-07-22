#!/usr/bin/env bash
# Build an offline install archive from the current terrific-pi tree.
# Includes extensions, skills, and config snapshot for 1:1 migration restore.
# Usage: ./scripts/pack.sh [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-"$ROOT/dist"}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GIT_SHA="unknown"
GIT_DIRTY="unknown"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
	GIT_DIRTY="false"
	if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet \
		|| [[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]]; then
		GIT_DIRTY="true"
	fi
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
	--exclude='**/__pycache__' \
	--exclude='*.pyc' \
	--exclude='*.tgz' \
	--exclude='.DS_Store' \
	-cf - . | tar -C "$STAGE/$NAME" -xf -

# Manifest: packages + skills + snapshot files + provenance.
{
	echo "name=terrific-pi"
	echo "packed_at_utc=$STAMP"
	echo "git_sha=$GIT_SHA"
	echo "git_dirty=$GIT_DIRTY"
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
	echo "external_packages<<"
	if [[ -f "$STAGE/$NAME/agent/required-external-packages.json" ]]; then
		python3 - "$STAGE/$NAME/agent/required-external-packages.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
if not isinstance(data, dict) or not isinstance(data.get("packages"), list):
    raise SystemExit("required-external-packages.json must contain a packages array")
for package in data["packages"]:
    if not isinstance(package, str) or not package.strip():
        raise SystemExit("external package entries must be non-empty strings")
    print(package)
PY
	fi
	echo ">>"
	echo "skills<<"
	find "$STAGE/$NAME/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | while read -r d; do
		base="$(basename "$d")"
		# Require SKILL.md to count as a shippable skill
		[[ -f "$d/SKILL.md" ]] || continue
		echo "$base"
	done
	echo ">>"
	echo "snapshot_agent<<"
	if [[ -d "$STAGE/$NAME/snapshot/agent" ]]; then
		find "$STAGE/$NAME/snapshot/agent" -type f ! -name '.gitkeep' | sort | while read -r f; do
			relative="${f#"$STAGE/$NAME/snapshot/agent/"}"
			case "$relative" in
				""|/*|./*|../*|*/../*|*/..|*//*) echo "unsafe snapshot path: $relative" >&2; exit 1 ;;
			esac
			echo "agent/$relative"
		done
	fi
	echo ">>"
} >"$STAGE/$NAME/MANIFEST.txt"

# Root entrypoint for offline hosts that only extract the tarball.
cp "$STAGE/$NAME/scripts/install.sh" "$STAGE/$NAME/install.sh"
chmod +x "$STAGE/$NAME/scripts/"*.sh "$STAGE/$NAME/install.sh" 2>/dev/null || true
find "$STAGE/$NAME/skills" -type f -name '*.py' -exec chmod +x {} + 2>/dev/null || true

ARCHIVE="$OUT_DIR/${NAME}.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" "$NAME"

# Self-check: install entrypoint, extensions, skills, snapshot.
python3 - "$ARCHIVE" <<'PY'
import sys, tarfile
path = sys.argv[1]
with tarfile.open(path, "r:gz") as tf:
    names = tf.getnames()
    assert any(n.endswith("/install.sh") for n in names), "missing install.sh"
    assert any("/extensions/" in n and n.endswith("/package.json") for n in names), "missing extension packages"
    assert any("/skills/" in n and n.endswith("/SKILL.md") for n in names), "missing skills"
    assert any("/snapshot/agent/" in n for n in names), "missing agent snapshot"
    manifest = None
    for n in names:
        if n.endswith("/MANIFEST.txt"):
            member = tf.extractfile(n)
            assert member is not None, "cannot read MANIFEST.txt"
            manifest = member.read().decode("utf-8", errors="replace")
            break
    assert manifest and "skills<<" in manifest and "snapshot_agent<<" in manifest, "manifest incomplete"
    print("ok", path, "members", len(names))
    print("--- MANIFEST ---")
    print(manifest)
PY

echo "packed: $ARCHIVE"
ls -lh "$ARCHIVE"
