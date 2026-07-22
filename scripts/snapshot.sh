#!/usr/bin/env bash
# Capture local non-secret pi config + registered skills into this repo for packing/migration.
# Usage:
#   ./scripts/snapshot.sh
# Env:
#   PI_HOME              default: ~/.pi
#   AGENTS_SKILLS_DIR    default: ~/.agents/skills
#   SNAPSHOT_ONLY=agent|skills|all   default: all
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi}"
AGENT_SRC="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
SKILLS_SRC="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
SNAPSHOT_ONLY="${SNAPSHOT_ONLY:-all}"
AGENT_DST="$ROOT/snapshot/agent"
SKILLS_DST="$ROOT/skills"

# Agent files safe to ship (no secrets). Extend carefully.
# auth.json is never copied; we emit auth.template.json with empty keys only.
AGENT_WHITELIST=(
	models.json
	settings.json
	statusline.json
	AGENTS.md
	terrific.json
)
GENERATED_AGENT_FILES=(
	auth.template.json
)

die() { echo "error: $*" >&2; exit 1; }

is_safe_relative_path() {
	local path="$1"
	case "$path" in
		""|/*|./*|../*|*/../*|*/..|*//*) return 1 ;;
	esac
	return 0
}

sanitize_portable_terrific_config() {
	local path="$1"
	python3 - "$path" <<'PY'
import json, re, sys
from pathlib import Path
path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit(f"terrific.json must be an object: {path}")
docsflow = data.get("docsflow")
if isinstance(docsflow, dict):
    vault = docsflow.get("vaultRoot")
    if isinstance(vault, str) and (vault.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", vault)):
        docsflow.pop("vaultRoot")
        print(f"removed machine-local docsflow.vaultRoot from {path}")
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

sanitize_portable_agent_instructions() {
	local path="$1"
	python3 - "$path" <<'PY'
import re, sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
portable = re.sub(r"/(?:home|Users)/[A-Za-z0-9._-]+", "~", text)
if portable != text:
    path.write_text(portable, encoding="utf-8")
    print(f"rewrote machine-local home paths in {path}")
PY
}

sanitize_check() {
	local path="$1"
	python3 - "$path" <<'PY'
import re, sys
from pathlib import Path
p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8", errors="ignore")
# Real secret patterns only (avoid matching words like "subdirectory").
patterns = [
    (r'(?i)"apiKey"\s*:\s*"[^"]+"', "apiKey field with value"),
    (r"(?i)authorization:\s*bearer\s+\S+", "bearer token"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key block"),
    (r"(?i)sk-[a-z0-9]{20,}", "sk-looking api token"),
]
for rx, label in patterns:
    if re.search(rx, text):
        raise SystemExit(f"refusing to snapshot secret-like content ({label}) in {p}")
print(f"sanitize ok: {p}")
PY
}

snapshot_auth_template() {
	# Shape-only export: provider entries with empty key/token fields for manual fill after migrate.
	python3 - "$AGENT_SRC/auth.json" "$AGENT_DST/auth.template.json" <<'PY'
import json, sys
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
if not src.exists():
    # Still emit an empty object so install always has a slot file.
    dst.write_text(json.dumps({}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("auth template: empty (no live auth.json)")
    raise SystemExit(0)
data = json.loads(src.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit(f"auth.json must be an object: {src}")
out = {}
for prov, entry in data.items():
    if isinstance(entry, dict):
        item = {}
        for k, v in entry.items():
            kl = str(k).lower()
            if any(s in kl for s in ("key", "token", "secret", "password")):
                item[k] = ""
            else:
                item[k] = v
        # Ensure a key field exists for the common api_key shape.
        if item.get("type") == "api_key" and "key" not in item:
            item["key"] = ""
        out[str(prov)] = item
    else:
        out[str(prov)] = ""
dst.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"auth template: {dst} providers={list(out)}")
PY
	sanitize_check "$AGENT_DST/auth.template.json"
}

snapshot_agent() {
	mkdir -p "$AGENT_DST"
	local f
	for f in "${AGENT_WHITELIST[@]}"; do
		is_safe_relative_path "$f" || die "unsafe agent whitelist path: $f"
		if [[ -f "$AGENT_SRC/$f" ]]; then
			mkdir -p "$(dirname "$AGENT_DST/$f")"
			cp -a "$AGENT_SRC/$f" "$AGENT_DST/$f"
			# Normalize LF
			if command -v python3 >/dev/null 2>&1; then
				python3 - "$AGENT_DST/$f" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
data = p.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
if data and not data.endswith(b"\n"):
    data += b"\n"
p.write_bytes(data)
PY
			fi
			if [[ "$f" == "terrific.json" ]]; then
				sanitize_portable_terrific_config "$AGENT_DST/$f"
			elif [[ "$f" == "AGENTS.md" ]]; then
				sanitize_portable_agent_instructions "$AGENT_DST/$f"
			fi
			sanitize_check "$AGENT_DST/$f"
			echo "agent snapshot: $f"
		fi
	done
	snapshot_auth_template
	# Drop leftovers that are not on whitelist / generated set, preserving approved nested paths.
	find "$AGENT_DST" -type f ! -name '.gitkeep' | sort | while read -r path; do
		relative="${path#"$AGENT_DST/"}"
		is_safe_relative_path "$relative" || { rm -f "$path"; continue; }
		keep=0
		for f in "${AGENT_WHITELIST[@]}" "${GENERATED_AGENT_FILES[@]}"; do
			[[ "$relative" == "$f" ]] && keep=1 && break
		done
		[[ "$keep" == "1" ]] || rm -f "$path"
	done
}

snapshot_skills() {
	mkdir -p "$SKILLS_DST"
	# Only skills already registered under repo skills/ (or create from live if dir exists empty?).
	# Policy: for each directory name in skills/, refresh from live AGENTS_SKILLS_DIR if present.
	local names=()
	if [[ -d "$SKILLS_DST" ]]; then
		while IFS= read -r d; do
			[[ -n "$d" ]] || continue
			names+=("$(basename "$d")")
		done < <(find "$SKILLS_DST" -mindepth 1 -maxdepth 1 -type d | sort)
	fi
	[[ ${#names[@]} -gt 0 ]] || die "no skills registered under $SKILLS_DST (add skills/<name> first)"

	local name
	for name in "${names[@]}"; do
		local src="$SKILLS_SRC/$name"
		local dst="$SKILLS_DST/$name"
		[[ -d "$src" ]] || { echo "skip skill (not on machine): $name"; continue; }
		mkdir -p "$dst"
		if command -v rsync >/dev/null 2>&1; then
			rsync -a --delete \
				--exclude '__pycache__' \
				--exclude '*.pyc' \
				--exclude '.DS_Store' \
				"$src"/ "$dst"/
		else
			rm -rf "$dst"
			mkdir -p "$dst"
			tar -C "$src" \
				--exclude='__pycache__' \
				--exclude='*.pyc' \
				--exclude='.DS_Store' \
				-cf - . | tar -C "$dst" -xf -
		fi
		# Executable bit for *.py helpers
		find "$dst" -type f -name '*.py' -exec chmod +x {} +
		echo "skill snapshot: $name <- $src"
	done
}

main() {
	[[ -d "$ROOT/scripts" ]] || die "run from terrific-pi repo"
	case "$SNAPSHOT_ONLY" in
		all)
			snapshot_agent
			snapshot_skills
			;;
		agent)
			snapshot_agent
			;;
		skills)
			snapshot_skills
			;;
		*)
			die "SNAPSHOT_ONLY must be all|agent|skills"
			;;
	esac
	echo "snapshot written under $ROOT/snapshot and $ROOT/skills"
	echo "next: ./scripts/pack.sh"
}

main "$@"
