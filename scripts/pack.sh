#!/usr/bin/env bash
# Build an offline install archive from the current terrific-pi tree.
# Includes the public monorepo payload for offline migration restore.
# Usage: ./scripts/pack.sh [output-dir]
# Env: DIST_KEEP=N  archives to retain after a successful pack (default: 5; 0 disables cleanup)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-"$ROOT/dist"}"
DIST_KEEP="${DIST_KEEP:-5}"
[[ "$DIST_KEEP" =~ ^[0-9]+$ ]] || { echo "error: DIST_KEEP must be a non-negative integer" >&2; exit 1; }
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

prune_archives() {
	local current="$1"
	local keep="$2"
	[[ "$keep" -gt 0 ]] || return 0

	local -a archives=("$current")
	local path
	while IFS= read -r path; do
		[[ "$path" == "$current" ]] || archives+=("$path")
	done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'terrific-pi-*.tar.gz' -print | LC_ALL=C sort -r)

	local total="${#archives[@]}"
	[[ "$total" -gt "$keep" ]] || return 0
	local i
	for ((i = keep; i < total; i++)); do
		rm -f -- "${archives[$i]}"
	done
	echo "dist cleanup: kept $keep of $total archives"
}

mkdir -p "$OUT_DIR" "$STAGE/$NAME"

# Package only the public monorepo payload; git/runtime state is never an input.
PACK_PATHS=(.gitignore AGENTS.md README.md agent docs extensions scripts skills snapshot workflows)
for path in "${PACK_PATHS[@]}"; do
	[[ -e "$ROOT/$path" ]] || { echo "error: missing pack path: $path" >&2; exit 1; }
done
tar -C "$ROOT" \
	--exclude='.git' \
	--exclude='*/.git' \
	--exclude='.pi-subagents' \
	--exclude='*/.pi-subagents' \
	--exclude='node_modules' \
	--exclude='*/node_modules' \
	--exclude='__pycache__' \
	--exclude='*/__pycache__' \
	--exclude='sessions' \
	--exclude='*/sessions' \
	--exclude='.env' \
	--exclude='.env.*' \
	--exclude='*/.env' \
	--exclude='*/.env.*' \
	--exclude='auth.json' \
	--exclude='*/auth.json' \
	--exclude='*.jsonl' \
	--exclude='*.pem' \
	--exclude='*.key' \
	--exclude='*.pyc' \
	--exclude='*.pyo' \
	--exclude='*.tgz' \
	--exclude='*.tar.gz' \
	--exclude='.DS_Store' \
	-cf - "${PACK_PATHS[@]}" | tar -C "$STAGE/$NAME" -xf -

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
			has_pi="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); meta=d.get("terrificPi",{}); print("1" if d.get("pi",{}).get("extensions") and not (isinstance(meta,dict) and meta.get("install") is False) else "0")' "$pkg")"
			[[ "$has_pi" == "1" ]] || continue
		fi
		# taskboard must register before presentation; all other package order remains lexical.
		sort_key="$base"
		[[ "$base" == "taskboard" ]] && sort_key="taskboard-0"
		[[ "$base" == "presentation" ]] && sort_key="taskboard-1"
		printf '%s\t%s\n' "$sort_key" "../vendor/terrific-pi/extensions/$base"
	done | sort | cut -f2-
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
	echo "retired_external_packages<<"
	if [[ -f "$STAGE/$NAME/agent/required-external-packages.json" ]]; then
		python3 - "$STAGE/$NAME/agent/required-external-packages.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
retired = data.get("retiredPackages", [])
if not isinstance(retired, list):
    raise SystemExit("retiredPackages must be an array when present")
for package in retired:
    if not isinstance(package, str) or not package.strip():
        raise SystemExit("retired package entries must be non-empty strings")
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
	echo "workflows<<"
	if [[ -d "$STAGE/$NAME/workflows" ]]; then
		find "$STAGE/$NAME/workflows" -type f ! -name '.gitkeep' | sort | while read -r f; do
			relative="${f#"$STAGE/$NAME/workflows/"}"
			case "$relative" in
				""|/*|./*|../*|*/../*|*/..|*//*) echo "unsafe workflow path: $relative" >&2; exit 1 ;;
			esac
			echo "workflows/$relative"
		done
	fi
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
from pathlib import PurePosixPath
path = sys.argv[1]
with tarfile.open(path, "r:gz") as tf:
    names = tf.getnames()
    assert any(n.endswith("/install.sh") for n in names), "missing install.sh"
    assert any("/extensions/" in n and n.endswith("/package.json") for n in names), "missing extension packages"
    assert any("/skills/" in n and n.endswith("/SKILL.md") for n in names), "missing skills"
    assert any("/snapshot/agent/" in n for n in names), "missing agent snapshot"
    allowed = {".gitignore", "AGENTS.md", "README.md", "agent", "docs", "extensions", "scripts", "skills", "snapshot", "workflows", "MANIFEST.txt", "install.sh"}
    forbidden = []
    for name in names:
        parts = PurePosixPath(name).parts
        if len(parts) > 1:
            assert parts[1] in allowed, f"unexpected top-level archive member: {name}"
        base = parts[-1] if parts else ""
        if any(part in {".git", ".pi-subagents", "node_modules", "__pycache__", "sessions"} for part in parts):
            forbidden.append(name)
        elif base == ".env" or base.startswith(".env.") or base == "auth.json":
            forbidden.append(name)
        elif base.endswith((".jsonl", ".pem", ".key", ".pyc", ".pyo")):
            forbidden.append(name)
    assert not forbidden, f"forbidden archive members: {forbidden[:10]}"
    manifest = None
    for n in names:
        if n.endswith("/MANIFEST.txt"):
            member = tf.extractfile(n)
            assert member is not None, "cannot read MANIFEST.txt"
            manifest = member.read().decode("utf-8", errors="replace")
            break
    assert manifest and "skills<<" in manifest and "workflows<<" in manifest and "snapshot_agent<<" in manifest, "manifest incomplete"
    print("ok", path, "members", len(names))
    print("--- MANIFEST ---")
    print(manifest)
PY

prune_archives "$ARCHIVE" "$DIST_KEEP"
echo "packed: $ARCHIVE"
ls -lh "$ARCHIVE"
