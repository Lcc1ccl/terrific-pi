#!/usr/bin/env bash
# Offline install of terrific-pi into ~/.pi/vendor/terrific-pi and merge package paths.
# Usage:
#   ./install.sh                      # from extracted tree / git checkout
#   ./scripts/install.sh              # same
#   ./scripts/install.sh archive.tgz  # extract archive then install
# Env:
#   PI_HOME   default: ~/.pi
#   FORCE=1   replace existing vendor/terrific-pi without prompt
set -euo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
TARGET="$PI_HOME/vendor/terrific-pi"
FORCE="${FORCE:-0}"

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

read_packages() {
	local root="$1"
	if [[ -f "$root/MANIFEST.txt" ]]; then
		python3 - "$root/MANIFEST.txt" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8").read().splitlines()
inside = False
for line in text:
    if line == "packages<<":
        inside = True
        continue
    if line == ">>":
        inside = False
        continue
    if inside and line.strip():
        print(line.strip())
PY
		return
	fi
	# Fallback: discover extensions/*/package.json
	find "$root/extensions" -mindepth 2 -maxdepth 2 -name package.json 2>/dev/null | sort | while read -r pkg; do
		base="$(basename "$(dirname "$pkg")")"
		echo "../vendor/terrific-pi/extensions/$base"
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

main() {
	local src
	src="$(resolve_source "${1:-}")"
	[[ -d "$src/extensions" ]] || die "no extensions/ in $src"

	mapfile -t PACKAGES < <(read_packages "$src")
	[[ ${#PACKAGES[@]} -gt 0 ]] || die "no packages discovered in $src"

	mkdir -p "$PI_HOME/vendor"
	if [[ -e "$TARGET" ]]; then
		if [[ "$FORCE" == "1" ]]; then
			rm -rf "$TARGET"
		elif [[ -d "$TARGET" ]]; then
			# In-place sync: rsync if available, else rm+cp
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

	merge_packages "$AGENT_DIR/settings.json" "${PACKAGES[@]}"
	install_templates "$src"

	echo "installed: $TARGET"
	echo "packages:"
	printf '  %s\n' "${PACKAGES[@]}"
	echo "done. restart pi or /reload"
}

main "$@"
