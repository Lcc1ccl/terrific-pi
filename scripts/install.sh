#!/usr/bin/env bash
# Offline install of terrific-pi:
#   - vendor extensions -> $PI_HOME/vendor/terrific-pi
#   - skills            -> $AGENTS_SKILLS_DIR
#   - agent snapshot    -> $PI_HOME/agent  (seed, or RESTORE=1 overwrite)
# Usage:
#   ./install.sh                      # from extracted tree / git checkout
#   ./scripts/install.sh              # same
#   ./scripts/install.sh archive.tgz  # extract archive then install
# Env:
#   PI_HOME              default: ~/.pi
#   AGENTS_SKILLS_DIR    default: ~/.agents/skills
#   FORCE=1              replace existing vendor/terrific-pi without prompt
#   RESTORE=1            1:1 restore snapshot/agent files (never auth.json)
set -euo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
TARGET="$PI_HOME/vendor/terrific-pi"
FORCE="${FORCE:-0}"
RESTORE="${RESTORE:-0}"

die() { echo "error: $*" >&2; exit 1; }

resolve_source() {
	local arg="${1:-}"
	if [[ -n "$arg" ]]; then
		[[ -f "$arg" ]] || die "archive not found: $arg"
		local tmp
		tmp="$(mktemp -d "${TMPDIR:-/tmp}/terrific-pi-install.XXXXXX")"
		tar -C "$tmp" -xzf "$arg"
		# Archive root is terrific-pi-<stamp>-<sha>/
		local root
		root="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
		[[ -n "$root" && -f "$root/MANIFEST.txt" ]] || die "invalid archive layout: $arg"
		echo "$root"
		return
	fi

	local here
	here="$(cd "$(dirname "$0")" && pwd)"
	if [[ -f "$here/../MANIFEST.txt" || -d "$here/../extensions" ]]; then
		echo "$(cd "$here/.." && pwd)"
		return
	fi
	if [[ -f "$here/MANIFEST.txt" || -d "$here/extensions" ]]; then
		echo "$here"
		return
	fi
	die "run from terrific-pi tree or pass archive.tar.gz"
}

read_manifest_block() {
	local root="$1"
	local block="$2"
	if [[ -f "$root/MANIFEST.txt" ]]; then
		python3 - "$root/MANIFEST.txt" "$block" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8").read().splitlines()
block = sys.argv[2]
start, end = f"{block}<<", ">>"
inside = False
for line in text:
    if line == start:
        inside = True
        continue
    if inside and line == end:
        break
    if inside and line.strip():
        print(line.strip())
PY
		return
	fi
}

read_packages() {
	local root="$1"
	local -a from_manifest=()
	mapfile -t from_manifest < <(read_manifest_block "$root" "packages" || true)
	if [[ ${#from_manifest[@]} -gt 0 ]]; then
		printf '%s\n' "${from_manifest[@]}"
		return
	fi
	# Fallback: discover extensions/*/package.json
	find "$root/extensions" -mindepth 2 -maxdepth 2 -name package.json 2>/dev/null | sort | while read -r pkg; do
		base="$(basename "$(dirname "$pkg")")"
		echo "../vendor/terrific-pi/extensions/$base"
	done
}

read_skills() {
	local root="$1"
	local -a from_manifest=()
	mapfile -t from_manifest < <(read_manifest_block "$root" "skills" || true)
	if [[ ${#from_manifest[@]} -gt 0 ]]; then
		printf '%s\n' "${from_manifest[@]}"
		return
	fi
	find "$root/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | while read -r d; do
		[[ -f "$d/SKILL.md" ]] || continue
		basename "$d"
	done
}

merge_packages() {
	local settings="$1"
	shift
	local -a pkgs=("$@")
	mkdir -p "$(dirname "$settings")"
	if [[ ! -f "$settings" ]]; then
		printf '%s\n' '{' '  "packages": []' '}' >"$settings"
	fi
	python3 - "$settings" "${pkgs[@]}" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
wanted = sys.argv[2:]
data = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit("settings.json must be an object")
pkgs = data.get("packages")
if not isinstance(pkgs, list):
    pkgs = []
# Drop stale absolute/relative terrific-pi extension entries, keep everything else.
kept = []
for item in pkgs:
    if not isinstance(item, str):
        kept.append(item)
        continue
    if "terrific-pi/extensions/" in item.replace("\\", "/"):
        continue
    kept.append(item)
for item in wanted:
    if item not in kept:
        kept.append(item)
data["packages"] = kept
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"updated packages ({len(wanted)} terrific-pi entries) -> {path}")
PY
}

install_skills() {
	local root="$1"
	shift
	local -a skills=("$@")
	[[ ${#skills[@]} -gt 0 ]] || { echo "no skills to install"; return 0; }
	mkdir -p "$SKILLS_DIR"
	local name
	for name in "${skills[@]}"; do
		local src="$root/skills/$name"
		local dst="$SKILLS_DIR/$name"
		[[ -d "$src" && -f "$src/SKILL.md" ]] || die "skill missing in package: $name"
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
			tar -C "$src" -cf - . | tar -C "$dst" -xf -
		fi
		find "$dst" -type f -name '*.py' -exec chmod +x {} + 2>/dev/null || true
		echo "skill installed: $dst"
	done
}

install_templates() {
	local root="$1"
	local agent_src="$root/agent"
	[[ -d "$agent_src" ]] || return 0
	mkdir -p "$AGENT_DIR"

	# Only seed missing non-secret templates; never overwrite live config.
	local f
	for f in statusline.example.json pi-essentials.example.json settings.packages.example.json; do
		if [[ -f "$agent_src/$f" && ! -f "$AGENT_DIR/$f" ]]; then
			cp "$agent_src/$f" "$AGENT_DIR/$f"
			echo "seeded $AGENT_DIR/$f"
		fi
	done

	# Optional first-time statusline config if none exists.
	if [[ ! -f "$AGENT_DIR/statusline.json" && -f "$agent_src/statusline.example.json" ]]; then
		cp "$agent_src/statusline.example.json" "$AGENT_DIR/statusline.json"
		echo "seeded $AGENT_DIR/statusline.json"
	fi
}

install_auth_template() {
	# Install shape-only auth so migration is: fill keys in auth.json, then run.
	# Never overwrite non-empty live secrets.
	local root="$1"
	local tpl="$root/snapshot/agent/auth.template.json"
	local dest="$AGENT_DIR/auth.json"
	[[ -f "$tpl" ]] || { echo "no auth.template.json in package"; return 0; }
	mkdir -p "$AGENT_DIR"
	python3 - "$tpl" "$dest" <<'PY'
import json, sys
from pathlib import Path
tpl_path, dest_path = Path(sys.argv[1]), Path(sys.argv[2])
tpl = json.loads(tpl_path.read_text(encoding="utf-8"))
if not isinstance(tpl, dict):
    raise SystemExit("auth.template.json must be an object")

def is_secret_key(name: str) -> bool:
    n = name.lower()
    return any(s in n for s in ("key", "token", "secret", "password"))

def secret_nonempty(entry) -> bool:
    if not isinstance(entry, dict):
        return bool(entry)
    for k, v in entry.items():
        if is_secret_key(str(k)) and str(v).strip():
            return True
    return False

if not dest_path.exists():
    dest_path.write_text(json.dumps(tpl, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"seeded {dest_path} (empty keys — fill manually)")
    raise SystemExit(0)

live = json.loads(dest_path.read_text(encoding="utf-8"))
if not isinstance(live, dict):
    raise SystemExit(f"{dest_path} must be an object")

changed = False
for prov, entry in tpl.items():
    if prov not in live:
        live[prov] = entry
        changed = True
        continue
    # Provider exists: fill missing non-secret fields / empty secret slots only.
    cur = live[prov]
    if isinstance(entry, dict) and isinstance(cur, dict):
        for k, v in entry.items():
            if k not in cur:
                cur[k] = v
                changed = True
            elif is_secret_key(str(k)) and not str(cur.get(k, "")).strip() and v == "":
                # keep empty
                pass
        live[prov] = cur
    elif not secret_nonempty(cur) and cur != entry:
        live[prov] = entry
        changed = True

if changed:
    dest_path.write_text(json.dumps(live, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"merged auth providers into {dest_path} (existing keys preserved)")
else:
    print(f"keep existing {dest_path} (keys preserved; fill any empty key fields)")
PY
}

install_snapshot_agent() {
	local root="$1"
	local snap="$root/snapshot/agent"
	[[ -d "$snap" ]] || { echo "no snapshot/agent in package"; return 0; }
	mkdir -p "$AGENT_DIR"

	local f base
	while IFS= read -r f; do
		base="$(basename "$f")"
		# Never install secrets or the template as a literal live auth.json filename.
		case "$base" in
			auth.json|*.pem|*.key) die "refusing to install secret file from snapshot: $base" ;;
			auth.template.json) continue ;;
		esac
		if [[ "$RESTORE" == "1" ]]; then
			cp -a "$f" "$AGENT_DIR/$base"
			echo "restored $AGENT_DIR/$base"
		else
			if [[ ! -f "$AGENT_DIR/$base" ]]; then
				cp -a "$f" "$AGENT_DIR/$base"
				echo "seeded $AGENT_DIR/$base"
			else
				echo "keep existing $AGENT_DIR/$base (set RESTORE=1 to overwrite)"
			fi
		fi
	done < <(find "$snap" -type f ! -name '.gitkeep' | sort)

	install_auth_template "$root"
}

main() {
	local src
	src="$(resolve_source "${1:-}")"
	[[ -d "$src/extensions" ]] || die "no extensions/ in $src"

	mapfile -t PACKAGES < <(read_packages "$src")
	[[ ${#PACKAGES[@]} -gt 0 ]] || die "no packages discovered in $src"
	mapfile -t SKILLS < <(read_skills "$src")

	mkdir -p "$PI_HOME/vendor"
	if [[ -e "$TARGET" ]]; then
		if [[ "$FORCE" == "1" ]]; then
			rm -rf "$TARGET"
		elif [[ -d "$TARGET" ]]; then
			:
		else
			die "refusing to replace non-directory $TARGET"
		fi
	fi

	if [[ "$FORCE" == "1" || ! -e "$TARGET" ]]; then
		mkdir -p "$(dirname "$TARGET")"
		rm -rf "$TARGET"
		mkdir -p "$TARGET"
		# Copy tree; keep scripts for later re-pack on the target machine.
		tar -C "$src" -cf - . | tar -C "$TARGET" -xf -
	else
		if command -v rsync >/dev/null 2>&1; then
			rsync -a --delete \
				--exclude '.git' \
				--exclude 'node_modules' \
				--exclude 'dist' \
				--exclude '__pycache__' \
				"$src"/ "$TARGET"/
		else
			# Portable replace without rsync
			local bak
			bak="${TARGET}.bak.$(date +%s)"
			mv "$TARGET" "$bak"
			mkdir -p "$TARGET"
			tar -C "$src" -cf - . | tar -C "$TARGET" -xf -
			echo "previous install moved to $bak"
		fi
	fi

	# Skills always sync from package (migration 1:1 for skills).
	install_skills "$src" "${SKILLS[@]:-}"

	if [[ "$RESTORE" == "1" ]]; then
		# Full agent snapshot restore first; then ensure terrific-pi packages still merged.
		install_snapshot_agent "$src"
		merge_packages "$AGENT_DIR/settings.json" "${PACKAGES[@]}"
	else
		# Mild path: merge packages, seed templates + missing snapshot files only.
		merge_packages "$AGENT_DIR/settings.json" "${PACKAGES[@]}"
		install_templates "$src"
		install_snapshot_agent "$src"
	fi

	echo "installed: $TARGET"
	echo "packages:"
	printf '  %s\n' "${PACKAGES[@]}"
	if [[ ${#SKILLS[@]} -gt 0 ]]; then
		echo "skills -> $SKILLS_DIR:"
		printf '  %s\n' "${SKILLS[@]}"
	fi
	if [[ "$RESTORE" == "1" ]]; then
		echo "mode: RESTORE=1 (agent snapshot restored; auth keys preserved/empty for manual fill)"
	else
		echo "mode: seed/merge (RESTORE=1 for 1:1 agent snapshot restore)"
	fi
	echo "next: edit $AGENT_DIR/auth.json and fill provider key fields, then start pi"
}

main "$@"
