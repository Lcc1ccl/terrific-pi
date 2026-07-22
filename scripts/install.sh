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

is_safe_relative_path() {
	local path="$1"
	case "$path" in
		""|/*|./*|../*|*/../*|*/..|*//*) return 1 ;;
	esac
	return 0
}

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

read_external_packages() {
	local root="$1"
	local -a from_manifest=()
	mapfile -t from_manifest < <(read_manifest_block "$root" "external_packages" || true)
	if [[ ${#from_manifest[@]} -gt 0 ]]; then
		printf '%s\n' "${from_manifest[@]}"
		return
	fi
	local required="$root/agent/required-external-packages.json"
	[[ -f "$required" ]] || return 0
	python3 - "$required" <<'PY'
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
}

read_retired_external_packages() {
	local root="$1"
	local required="$root/agent/required-external-packages.json"
	[[ -f "$required" ]] || return 0
	python3 - "$required" <<'PY'
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
	local -a local_packages=()
	local -a external_packages=()
	local -a retired_packages=()
	local target="local"
	local item
	for item in "$@"; do
		if [[ "$item" == "--external" ]]; then
			target="external"
			continue
		fi
		if [[ "$item" == "--retired" ]]; then
			target="retired"
			continue
		fi
		if [[ "$target" == "local" ]]; then local_packages+=("$item")
		elif [[ "$target" == "external" ]]; then external_packages+=("$item")
		else retired_packages+=("$item")
		fi
	done
	mkdir -p "$(dirname "$settings")"
	if [[ ! -f "$settings" ]]; then
		printf '%s\n' '{' '  "packages": []' '}' >"$settings"
	fi
	python3 - "$settings" "${local_packages[@]}" --external "${external_packages[@]}" --retired "${retired_packages[@]}" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
args = sys.argv[2:]
external_separator = args.index("--external")
retired_separator = args.index("--retired")
local_packages = args[:external_separator]
external_packages = args[external_separator + 1:retired_separator]
retired_packages = args[retired_separator + 1:]
data = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit("settings.json must be an object")
pkgs = data.get("packages")
if not isinstance(pkgs, list):
    pkgs = []

def external_identity(value: str) -> str:
    if not value.startswith("git:"):
        return value
    # SSH shorthand has one @ in git@host even without a ref; only strip a
    # second/final @ when a pinned ref is present.
    if value.startswith("git:git@") and value.count("@") == 1:
        return value
    return value.rsplit("@", 1)[0] if "@" in value else value

external_identities = {external_identity(value) for value in [*external_packages, *retired_packages]}
kept = []
for item in pkgs:
    if not isinstance(item, str):
        kept.append(item)
        continue
    normalized = item.replace("\\", "/")
    if "terrific-pi/extensions/" in normalized:
        continue
    if any(item == identity or item.startswith(identity + "@") for identity in external_identities):
        continue
    kept.append(item)
for item in [*local_packages, *external_packages]:
    if item not in kept:
        kept.append(item)
data["packages"] = kept
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"updated packages ({len(local_packages)} local, {len(external_packages)} external, {len(retired_packages)} retired) -> {path}")
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
	for f in statusline.example.json terrific.example.json settings.packages.example.json; do
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

	local f base relative dest
	while IFS= read -r f; do
		relative="${f#"$snap/"}"
		is_safe_relative_path "$relative" || die "unsafe snapshot path: $relative"
		base="$(basename "$relative")"
		# Never install secrets or the template as a literal live auth.json filename.
		case "$base" in
			auth.json|*.pem|*.key) die "refusing to install secret file from snapshot: $relative" ;;
			auth.template.json) continue ;;
		esac
		dest="$AGENT_DIR/$relative"
		if [[ "$RESTORE" == "1" ]]; then
			mkdir -p "$(dirname "$dest")"
			cp -a "$f" "$dest"
			echo "restored $dest"
		else
			if [[ ! -f "$dest" ]]; then
				mkdir -p "$(dirname "$dest")"
				cp -a "$f" "$dest"
				echo "seeded $dest"
			else
				echo "keep existing $dest (set RESTORE=1 to overwrite)"
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
	mapfile -t EXTERNAL_PACKAGES < <(read_external_packages "$src")
	mapfile -t RETIRED_EXTERNAL_PACKAGES < <(read_retired_external_packages "$src")
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
		merge_packages "$AGENT_DIR/settings.json" "${PACKAGES[@]}" --external "${EXTERNAL_PACKAGES[@]}" --retired "${RETIRED_EXTERNAL_PACKAGES[@]}"
	else
		# Mild path: merge packages, seed templates + missing snapshot files only.
		merge_packages "$AGENT_DIR/settings.json" "${PACKAGES[@]}" --external "${EXTERNAL_PACKAGES[@]}" --retired "${RETIRED_EXTERNAL_PACKAGES[@]}"
		install_templates "$src"
		install_snapshot_agent "$src"
	fi

	echo "installed: $TARGET"
	echo "packages:"
	printf '  %s\n' "${PACKAGES[@]}"
	if [[ ${#EXTERNAL_PACKAGES[@]} -gt 0 ]]; then
		echo "external packages:"
		printf '  %s\n' "${EXTERNAL_PACKAGES[@]}"
	fi
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
