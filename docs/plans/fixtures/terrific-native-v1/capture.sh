#!/usr/bin/env bash
# Reproduce sanitized Terrific native v1 PTY evidence from a temporary archive install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
FIXTURE_DIR="$ROOT/docs/plans/fixtures/terrific-native-v1"
CAPTURE_MODE="active"
if [[ $# -eq 2 && "$1" == "--inactive-compare" ]]; then
	CAPTURE_MODE="inactive-compare"
	OUT="$(realpath -m "$2")"
elif [[ $# -eq 1 ]]; then
	OUT="$(realpath -m "$1")"
else
	echo "usage: $0 OUTPUT_DIR | $0 --inactive-compare OUTPUT_DIR" >&2
	exit 2
fi
[[ "$OUT" != "$FIXTURE_DIR" ]] || { echo "refusing to overwrite the committed fixture directory" >&2; exit 2; }
if [[ -e "$OUT" && -n "$(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
	echo "refusing to overwrite non-empty output directory: $OUT" >&2
	exit 2
fi

for command in node python3 tmux magick sha256sum; do
	command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
[[ -f "$FONT" ]] || { echo "missing ImageMagick preview font: $FONT" >&2; exit 1; }
PI_PACKAGE="$ROOT/extensions/appearance/node_modules/@earendil-works/pi-coding-agent"
PI_TUI="$PI_PACKAGE/node_modules/@earendil-works/pi-tui"
[[ -d "$PI_PACKAGE" && -d "$PI_TUI" ]] || { echo "missing repository-local Pi peers" >&2; exit 1; }
[[ "$(node -p "require('$PI_PACKAGE/package.json').version")" == "0.81.1" ]] \
	|| { echo "capture requires repository-local Pi 0.81.1" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/terrific-native-capture.XXXXXX")"
SOCKET="terrific-native-capture-$$"
DISPLAY_ROOT=""
cleanup() {
	tmux -L "$SOCKET" kill-server 2>/dev/null || true
	[[ -z "$DISPLAY_ROOT" ]] || rm -rf "$DISPLAY_ROOT"
	rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
mkdir -p "$OUT" "$TMP/archive" "$TMP/home" "$TMP/skills"

DIST_KEEP=0 "$ROOT/scripts/pack.sh" "$TMP/archive" >/dev/null
ARCHIVE="$(find "$TMP/archive" -maxdepth 1 -type f -name 'terrific-pi-*.tar.gz' -print -quit)"
[[ -n "$ARCHIVE" ]] || { echo "temporary archive was not created" >&2; exit 1; }
PI_HOME="$TMP/pi"
AGENT_DIR="$PI_HOME/agent"
env -i PATH="$PATH" HOME="$TMP/home" PI_HOME="$PI_HOME" PI_CODING_AGENT_DIR="$AGENT_DIR" \
	AGENTS_SKILLS_DIR="$TMP/skills" FORCE=1 RESTORE=1 \
	"$ROOT/scripts/install.sh" "$ARCHIVE" >/dev/null
RUNTIME_PI_HOME="$PI_HOME"
RUNTIME_AGENT_DIR="$AGENT_DIR"
RUNTIME_PROJECT="$TMP/project"
if [[ "$CAPTURE_MODE" == "inactive-compare" ]]; then
	DISPLAY_ROOT="$(mktemp -d /tmp/terrific-native-display.XXXXXX)"
	ln -s "$PI_HOME" "$DISPLAY_ROOT/pi"
	mkdir "$DISPLAY_ROOT/project"
	RUNTIME_PI_HOME="$DISPLAY_ROOT/pi"
	RUNTIME_AGENT_DIR="$DISPLAY_ROOT/pi/agent"
	RUNTIME_PROJECT="$DISPLAY_ROOT/project"
fi

if [[ "$CAPTURE_MODE" == "active" ]]; then
python3 - "$AGENT_DIR" <<'PY'
import json
import sys
from pathlib import Path

agent = Path(sys.argv[1])
packages = [
    "../vendor/terrific-pi/extensions/taskboard",
    "../vendor/terrific-pi/extensions/presentation",
    "../vendor/terrific-pi/extensions/appearance",
    "../vendor/terrific-pi/extensions/statusline",
    "../vendor/terrific-pi/extensions/mode",
    "../vendor/terrific-pi/extensions/btw",
]
(agent / "settings.json").write_text(json.dumps({
    "packages": packages,
    "theme": "terrific-night",
    "editorPaddingX": 1,
    "outputPad": 1,
}, indent=2) + "\n", encoding="utf-8")
(agent / "terrific.json").write_text('{"appearance":{"profile":"terrific-native-v1"}}\n', encoding="utf-8")
(agent / "statusline.json").write_text('{"layout":"terrific","iconMode":"plain"}\n', encoding="utf-8")
PY
fi
mkdir -p "$PI_HOME/vendor/terrific-pi/node_modules/@earendil-works" "$TMP/project"
ln -s "$PI_PACKAGE" "$PI_HOME/vendor/terrific-pi/node_modules/@earendil-works/pi-coding-agent"
ln -s "$PI_TUI" "$PI_HOME/vendor/terrific-pi/node_modules/@earendil-works/pi-tui"

WRAPPER="$TMP/pty-wrapper.sh"
cat >"$WRAPPER" <<'SH'
#!/usr/bin/env bash
set -u
gate="$1"
before_file="$2"
after_file="$3"
project="$4"
path="$5"
home="$6"
colorterm="$7"
pi_home="$8"
agent_dir="$9"
cli="${10}"
session_dir="${11}"
seed_file="${12}"
seed_name="${13}"

stty -g >"$before_file"
printf '__START_GATE_READY__\n'
while [[ ! -e "$gate" ]]; do sleep 0.05; done
cd "$project" || exit 90
env -i PATH="$path" HOME="$home" LANG=C.UTF-8 TERM=xterm-256color COLORTERM="$colorterm" \
	PI_HOME="$pi_home" PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 \
	node "$cli" --offline --session-dir "$session_dir" --session "$seed_file" --name "$seed_name"
pi_status=$?
stty -g >"$after_file"
printf '__PI_EXIT__=%s\n' "$pi_status"
if cmp -s "$before_file" "$after_file"; then
	printf '__STTY_EXACT_MATCH__\n'
else
	printf '__STTY_MISMATCH__\n'
fi
printf '__SHELL_READY__\n'
IFS= read -r shell_line
printf '__SHELL_ECHO__=%s\n' "$shell_line"
sleep 0.5
exit "$pi_status"
SH
chmod +x "$WRAPPER"

pane_alive() {
	[[ "$(tmux -L "$SOCKET" display-message -p -t "$1" '#{pane_dead}' 2>/dev/null)" == "0" ]]
}

wait_for_pane() {
	local target="$1" marker="$2" attempt
	for attempt in {1..200}; do
		if tmux -L "$SOCKET" capture-pane -p -t "$target" 2>/dev/null | grep -Fq "$marker"; then
			return 0
		fi
		sleep 0.1
	done
	echo "timed out waiting for PTY marker: $marker" >&2
	tmux -L "$SOCKET" capture-pane -p -t "$target" 2>/dev/null | tail -20 >&2 || true
	return 1
}

wait_for_raw_after() {
	local raw="$1" offset="$2" marker="$3" attempt
	for attempt in {1..200}; do
		if [[ -f "$raw" ]] && tail -c "+$((offset + 1))" "$raw" 2>/dev/null | grep -aFq "$marker"; then
			return 0
		fi
		sleep 0.1
	done
	echo "timed out waiting for new raw PTY marker: $marker" >&2
	tail -c 8000 "$raw" 2>/dev/null | strings | tail -30 >&2 || true
	return 1
}

raw_marker_count() {
	python3 - "$1" "$2" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_bytes().decode("utf-8", errors="replace")
text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", text)
print(text.count(sys.argv[2]))
PY
}

wait_for_raw_count() {
	local raw="$1" marker="$2" expected="$3" attempt count
	for attempt in {1..200}; do
		count="$(raw_marker_count "$raw" "$marker")"
		[[ "$count" -ge "$expected" ]] && return 0
		sleep 0.1
	done
	echo "timed out waiting for raw marker count $expected: $marker" >&2
	return 1
}

raw_offset() {
	local raw="$1" previous=-1 current stable=0
	for _ in {1..100}; do
		current="$(wc -c <"$raw" | tr -d ' ')"
		if [[ "$current" == "$previous" ]]; then
			stable=$((stable + 1))
			[[ "$stable" -ge 3 ]] && { echo "$current"; return 0; }
		else
			stable=0
			previous="$current"
		fi
		sleep 0.05
	done
	echo "raw PTY pipe did not settle" >&2
	return 1
}

send_command() {
	local target="$1" command="$2"
	tmux -L "$SOCKET" send-keys -t "$target" -l "$command"
	tmux -L "$SOCKET" send-keys -t "$target" Enter
}

capture_frame() {
	local target="$1" label="$2" prefix="$3" rows="$4"
	local plain="$TMP/$prefix-$label.txt" ansi="$TMP/$prefix-$label.ansi"
	local full_plain="$TMP/$prefix-$label-full.txt" full_ansi="$TMP/$prefix-$label-full.ansi"
	tmux -L "$SOCKET" capture-pane -p -S - -t "$target" >"$full_plain"
	tmux -L "$SOCKET" capture-pane -p -e -S - -t "$target" >"$full_ansi"
	python3 - "$full_plain" "$full_ansi" "$plain" "$ansi" <<'PY'
import re
import sys
from pathlib import Path

escape = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
for source, output in ((sys.argv[1], sys.argv[3]), (sys.argv[2], sys.argv[4])):
    lines = Path(source).read_text(encoding="utf-8").splitlines()
    starts = [index for index, line in enumerate(lines) if escape.sub("", line).rstrip() == "Terrific"]
    selected = lines[starts[-1]:] if starts else lines
    Path(output).write_text("\n".join(selected) + "\n", encoding="utf-8")
PY
	[[ -s "$plain" ]] || { echo "plain frame is empty: $prefix/$label" >&2; exit 1; }
	[[ -s "$ansi" ]] || { echo "ANSI frame is empty: $prefix/$label" >&2; exit 1; }
}

combine_frames() {
	local prefix="$1" output="$2" extension="$3"
	python3 - "$TMP" "$ROOT" "$prefix" "$output" "$extension" <<'PY'
import sys
from pathlib import Path

tmp, root, prefix, output, extension = sys.argv[1:]
labels = (
    ("startup", "startup named seed session"),
    ("ctrl-o", "after Ctrl+O resource expansion"),
    ("new", "after /new"),
    ("resume", "after /resume seed selection"),
    ("ctrl-c", "after Ctrl+C cleared editor draft"),
    ("reload", "after 10 sequential /reload operations"),
    ("exit", "after normal /quit terminal restoration"),
)
parts = []
for stem, label in labels:
    text = (Path(tmp) / f"{prefix}-{stem}.{extension}").read_text(encoding="utf-8")
    text = text.replace(root, "<REPO>").replace(tmp, "<PTY_TMP>")
    parts.append(f"\n===== actual tmux PTY: {label} =====\n\n{text.rstrip()}\n")
Path(output).write_text("\n".join(parts), encoding="utf-8")
PY
}

run_matrix_point() {
	local cols="$1" rows="$2" mode="$3"
	local prefix="${cols}x${rows}-${mode}" session="capture-${cols}-${rows}-${mode}"
	local target="$session:0.0"
	local point="$TMP/$prefix"
	local raw="$point/raw.bin" gate="$point/start.gate"
	local tty_before="$point/stty.before" tty_after="$point/stty.after"
	local session_dir="$point/sessions" seed_file="$point/sessions/team-f-seed.jsonl"
	local seed_name="team-f-seed-$prefix" shell_line="TEAM_F_SHELL_INPUT_$prefix" colorterm=""
	local launch raw_start package pipe_command
	[[ "$mode" == "truecolor" ]] && colorterm="truecolor"
	mkdir -p "$point" "$session_dir"
	: >"$raw"
	: >"$seed_file"
	printf -v launch '%q %q %q %q %q %q %q %q %q %q %q %q %q %q' \
		"$WRAPPER" "$gate" "$tty_before" "$tty_after" "$TMP/project" "$PATH" "$TMP/home" "$colorterm" \
		"$PI_HOME" "$AGENT_DIR" "$PI_PACKAGE/dist/cli.js" "$session_dir" "$seed_file" "$seed_name"
	tmux -L "$SOCKET" -f /dev/null new-session -d -s "$session" -x "$cols" -y "$rows" -e "COLORTERM=$colorterm" "$launch"
	[[ "$(tmux -L "$SOCKET" display-message -p -t "$target" '#{pane_width}x#{pane_height}')" == "${cols}x${rows}" ]] \
		|| { echo "tmux pane dimension mismatch: $prefix" >&2; exit 1; }
	wait_for_pane "$target" "__START_GATE_READY__"
	printf -v pipe_command 'cat > %q' "$raw"
	tmux -L "$SOCKET" pipe-pane -O -t "$target" "$pipe_command"
	raw_start="$(raw_offset "$raw")"
	touch "$gate"
	wait_for_raw_after "$raw" "$raw_start" "Ready"
	pane_alive "$target" || { echo "Pi exited during startup: $prefix" >&2; exit 1; }
	capture_frame "$target" startup "$prefix" "$rows"

	tmux -L "$SOCKET" send-keys -t "$target" C-o
	wait_for_pane "$target" "  user"
	capture_frame "$target" ctrl-o "$prefix" "$rows"

	raw_start="$(raw_offset "$raw")"
	send_command "$target" /new
	wait_for_raw_after "$raw" "$raw_start" "New session started"
	pane_alive "$target" || { echo "Pi exited after /new: $prefix" >&2; exit 1; }
	grep -lF "$seed_name" "$session_dir"/*.jsonl >/dev/null 2>&1 \
		|| { echo "named seed session was not persisted: $prefix" >&2; find "$session_dir" -maxdepth 1 -type f -printf '%f\n' >&2; exit 1; }
	capture_frame "$target" new "$prefix" "$rows"

	raw_start="$(raw_offset "$raw")"
	send_command "$target" /resume
	wait_for_raw_after "$raw" "$raw_start" "$seed_name"
	tmux -L "$SOCKET" send-keys -t "$target" -l "$seed_name"
	tmux -L "$SOCKET" send-keys -t "$target" Enter
	wait_for_raw_after "$raw" "$raw_start" "Resumed session"
	pane_alive "$target" || { echo "Pi exited after /resume: $prefix" >&2; exit 1; }
	capture_frame "$target" resume "$prefix" "$rows"

	local draft="TEAM_F_CTRL_C_DRAFT_$prefix"
	tmux -L "$SOCKET" send-keys -t "$target" -l "$draft"
	wait_for_pane "$target" "$draft"
	tmux -L "$SOCKET" send-keys -t "$target" C-c
	for _ in {1..100}; do
		if ! tmux -L "$SOCKET" capture-pane -p -t "$target" | grep -Fq "$draft"; then break; fi
		sleep 0.05
	done
	! tmux -L "$SOCKET" capture-pane -p -t "$target" | grep -Fq "$draft" \
		|| { echo "Ctrl+C did not clear editor draft: $prefix" >&2; exit 1; }
	pane_alive "$target" || { echo "Pi exited after one Ctrl+C: $prefix" >&2; exit 1; }
	capture_frame "$target" ctrl-c "$prefix" "$rows"

	local reload_marker="Reloaded keybindings, extensions, skills, prompts, themes, and context files"
	local reload_baseline reload_count
	raw_offset "$raw" >/dev/null
	reload_baseline="$(raw_marker_count "$raw" "$reload_marker")"
	for reload in {1..10}; do
		raw_offset "$raw" >/dev/null
		reload_count="$(raw_marker_count "$raw" "$reload_marker")"
		send_command "$target" /reload
		wait_for_raw_count "$raw" "$reload_marker" "$((reload_count + 1))"
		for _ in {1..100}; do
			if ! tmux -L "$SOCKET" capture-pane -p -t "$target" | grep -Fq "Reloading keybindings"; then break; fi
			sleep 0.05
		done
		! tmux -L "$SOCKET" capture-pane -p -t "$target" | grep -Fq "Reloading keybindings" \
			|| { echo "reload $reload did not settle: $prefix" >&2; exit 1; }
		pane_alive "$target" || { echo "Pi exited after reload $reload: $prefix" >&2; exit 1; }
	done
	raw_offset "$raw" >/dev/null
	reload_count="$(raw_marker_count "$raw" "$reload_marker")"
	[[ "$reload_count" -ge "$((reload_baseline + 10))" ]] \
		|| { echo "fewer than 10 new reload completions: $prefix" >&2; exit 1; }
	local current="$TMP/$prefix-reload-joined.txt" joined_full="$TMP/$prefix-reload-joined-full.txt"
	capture_frame "$target" reload "$prefix" "$rows"
	tmux -L "$SOCKET" capture-pane -p -J -S - -t "$target" >"$joined_full"
	python3 - "$joined_full" "$current" <<'PY'
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
starts = [index for index, line in enumerate(lines) if line.rstrip() == "Terrific"]
selected = lines[starts[-1]:] if starts else lines
Path(sys.argv[2]).write_text("\n".join(selected) + "\n", encoding="utf-8")
PY
	[[ "$(grep -c '^Terrific$' "$current")" -eq 1 ]] || { echo "Terrific header is not unique after 10 reloads: $prefix" >&2; cat "$current" >&2; exit 1; }
	[[ "$(grep -Fc 'ctrl+o tools' "$current")" -eq 1 ]] || { echo "shortcuts widget is not unique after 10 reloads: $prefix" >&2; exit 1; }
	[[ "$(grep -Fc 'Ready · t' "$current")" -eq 1 ]] || { echo "footer is not unique after 10 reloads: $prefix" >&2; exit 1; }
	[[ "$(grep -Fc '[Extensions]' "$current")" -eq 1 ]] || { echo "extension resource group is not unique after 10 reloads: $prefix" >&2; exit 1; }
	python3 - "$current" "$prefix" <<'PY'
from pathlib import Path
import sys

text = "".join(Path(sys.argv[1]).read_text(encoding="utf-8").split())
prefix = sys.argv[2]
for package in ("appearance", "btw", "mode", "presentation", "statusline", "taskboard"):
    count = text.count(f"{package}.ts")
    if count != 1:
        raise SystemExit(f"expanded {package} resource count is {count} after 10 reloads: {prefix}")
theme_count = text.count("terrific-night.json")
if theme_count != 1:
    raise SystemExit(f"terrific-night resource count is {theme_count} after 10 reloads: {prefix}")
PY
	python3 - "$raw" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_bytes().decode("utf-8", errors="replace")
text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", text)
errors = re.findall(r"(?:TypeError|ReferenceError|SyntaxError|Unhandled|ERR_[A-Z_]+|Failed to load extension|Extension error)", text)
assert not errors, f"runtime errors found: {errors}"
PY

	raw_start="$(raw_offset "$raw")"
	send_command "$target" /quit
	wait_for_raw_after "$raw" "$raw_start" "__SHELL_READY__"
	pane_alive "$target" || { echo "wrapper shell was not alive after Pi exit: $prefix" >&2; exit 1; }
	tmux -L "$SOCKET" send-keys -t "$target" -l "$shell_line"
	tmux -L "$SOCKET" send-keys -t "$target" Enter
	wait_for_raw_after "$raw" "$raw_start" "__SHELL_ECHO__=$shell_line"
	wait_for_raw_after "$raw" "$raw_start" "__STTY_EXACT_MATCH__"
	cmp -s "$tty_before" "$tty_after" || { echo "stty state was not restored exactly: $prefix" >&2; exit 1; }
	python3 - "$raw" <<'PY'
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_bytes()
assert b"\x1b[?25h" in raw, "cursor-show restore sequence missing"
assert b"\x1b[?2004l" in raw, "bracketed-paste-disable restore sequence missing"
PY
	capture_frame "$target" exit "$prefix" "$rows"

	combine_frames "$prefix" "$OUT/$prefix.txt" txt
	combine_frames "$prefix" "$OUT/$prefix.ansi" ansi
	python3 - "$OUT/$prefix.txt" "$OUT/$prefix.ansi" "$ROOT" "$TMP" "$mode" <<'PY'
import sys
from pathlib import Path

plain_path, ansi_path, root, tmp, mode = sys.argv[1:]
plain = Path(plain_path).read_text(encoding="utf-8")
ansi = Path(ansi_path).read_text(encoding="utf-8")
for marker in (
    "Terrific", "[Extensions]", "terrific-night", "ctrl+o tools", "Ready",
    "New session started", "Resumed session", "after Ctrl+C cleared editor draft",
    "after 10 sequential /reload operations", "Reloaded keybindings",
    "__PI_EXIT__=0", "__STTY_EXACT_MATCH__", "__SHELL_READY__", "__SHELL_ECHO__=",
):
    assert marker in plain, f"missing content marker {marker!r} in {plain_path}"
for package in ("appearance", "btw", "mode", "presentation", "statusline", "taskboard"):
    assert package in plain, f"missing package marker {package!r} in {plain_path}"
assert root not in plain and root not in ansi, "repository root was not sanitized"
assert tmp not in plain and tmp not in ansi, "temporary root was not sanitized"
truecolor = "\x1b[38;2;" in ansi or "\x1b[48;2;" in ansi
color256 = "\x1b[38;5;" in ansi or "\x1b[48;5;" in ansi
assert truecolor if mode == "truecolor" else color256, f"missing {mode} ANSI marker"
if mode == "256color":
    assert not truecolor, "256-color capture contains a truecolor marker"
PY
	magick -background white -fill black -font "$FONT" -pointsize 12 \
		label:@"$OUT/$prefix.txt" -depth 8 -strip "$OUT/$prefix.png"
	python3 - "$OUT/$prefix.png" <<'PY'
import subprocess
import sys

image = sys.argv[1]
dimensions = subprocess.check_output(["magick", "identify", "-format", "%w %h", image], text=True).split()
assert int(dimensions[0]) > 1 and int(dimensions[1]) > 1, "PNG dimensions are blank"
stddev = float(subprocess.check_output(["magick", image, "-format", "%[fx:standard_deviation]", "info:"], text=True))
assert stddev > 0, "PNG pixels are blank"
PY
	for _ in {1..30}; do
		[[ "$(tmux -L "$SOCKET" display-message -p -t "$target" '#{pane_dead}' 2>/dev/null || echo 1)" == "1" ]] && break
		sleep 0.1
	done
	if tmux -L "$SOCKET" has-session -t "$session" 2>/dev/null; then
		tmux -L "$SOCKET" kill-session -t "$session"
	fi
	echo "captured $prefix: session/new/resume/Ctrl+C/10-reload/normal-exit checks passed"
}

write_inactive_config() {
	local variant="$1"
	python3 - "$AGENT_DIR" "$variant" <<'PY'
import json
import sys
from pathlib import Path

agent = Path(sys.argv[1])
variant = sys.argv[2]
packages = [
    "../vendor/terrific-pi/extensions/taskboard",
    "../vendor/terrific-pi/extensions/presentation",
    "../vendor/terrific-pi/extensions/statusline",
    "../vendor/terrific-pi/extensions/mode",
    "../vendor/terrific-pi/extensions/btw",
]
if variant == "target":
    packages.insert(2, "../vendor/terrific-pi/extensions/appearance")
(agent / "settings.json").write_text(json.dumps({
    "packages": packages,
    "theme": "dark",
    "defaultProvider": "openai",
    "defaultModel": "gpt-5.6-terra",
}, indent=2) + "\n", encoding="utf-8")
(agent / "auth.json").write_text('{"openai":{"type":"api_key","key":"offline-fixture-placeholder"}}\n', encoding="utf-8")
(agent / "terrific.json").write_text('{"appearance":{"profile":"off"}}\n', encoding="utf-8")
(agent / "statusline.json").write_text(json.dumps({
    "layout": "single",
    "widgets": ["path", "session", "model", "mode", "fast", "tokens", "cache", "cost", "contextBar", "branch", "branchDiff", "progress", "state"],
}, separators=(",", ":")) + "\n", encoding="utf-8")
PY
}

normalize_inactive_surface() {
	local source="$1" output="$2"
	python3 - "$source" "$output" "$ROOT" "$TMP" "$AGENT_DIR" "$PI_HOME" "$RUNTIME_AGENT_DIR" "$RUNTIME_PI_HOME" "$RUNTIME_PROJECT" <<'PY'
import re
import sys
from pathlib import Path

source, output, root, tmp, agent_dir, pi_home, runtime_agent_dir, runtime_pi_home, runtime_project = sys.argv[1:]
text = Path(source).read_text(encoding="utf-8")
escape = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")

def visible(value: str) -> str:
    return escape.sub("", value)

lines = text.splitlines()
normalized = []
section = None
resource_gap = False
for line in lines:
    plain = visible(line).strip()
    if plain == "__START_GATE_READY__":
        continue
    if plain == "[Extensions]":
        section = "extensions"
        resource_gap = False
        normalized.append(line)
        continue
    if plain == "[Themes]":
        # This controlled target has one appearance-owned theme discovery band.
        section = "themes"
        resource_gap = False
        continue
    if section in {"extensions", "themes"} and plain == "":
        resource_gap = True
        continue
    if section == "themes":
        if plain in {"terrific-night", "user"} or "/extensions/appearance/themes/terrific-night.json" in plain:
            continue
        normalized.append("")
        section = None
    if plain.startswith("[") and plain.endswith("]"):
        section = None
    if section == "extensions":
        # The target adds exactly one package-owned discovery entry.
        line = re.sub(r"appearance\.ts,\s*", "", line)
        line = re.sub(r",\s*appearance\.ts", "", line)
        if "/extensions/appearance/extensions/appearance.ts" in visible(line):
            continue
        if resource_gap:
            normalized.append("")
            section = None
    normalized.append(line)

result = "\n".join(normalized).strip("\n") + "\n"
replacements = (
    (runtime_agent_dir, "<AGENT>"),
    (runtime_pi_home, "<PI_HOME>"),
    (runtime_project, "<PROJECT>"),
    (agent_dir, "<AGENT>"),
    (pi_home, "<PI_HOME>"),
    (str(Path(tmp) / "project"), "<PROJECT>"),
    (root, "<REPO>"),
    (tmp, "<ISOLATED_HOME>"),
)
for old, new in replacements:
    result = result.replace(old, new)
result = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "<SESSION_ID>", result, flags=re.I)
held = []
def hold_escape(match: re.Match[str]) -> str:
    held.append(match.group(0))
    return f"<ANSI_ESCAPE_{len(held) - 1}>"
result = escape.sub(hold_escape, result)
for index, value in enumerate(held):
    result = result.replace(f"<ANSI_ESCAPE_{index}>", value)
Path(output).write_text(result, encoding="utf-8")
PY
}

run_inactive_variant() {
	local cols="$1" rows="$2" variant="$3"
	local prefix="${cols}x${rows}-${variant}" session="inactive-${cols}-${rows}-${variant}"
	local target="$session:0.0" point="$TMP/$prefix"
	local raw="$point/raw.bin" gate="$point/start.gate"
	local tty_before="$point/stty.before" tty_after="$point/stty.after"
	local session_dir="$point/sessions" seed_file="$point/sessions/inactive-seed.jsonl"
	local seed_name="inactive-seed-${cols}x${rows}" shell_line="INACTIVE_SHELL_INPUT_${cols}x${rows}"
	local launch raw_start pipe_command draft="INACTIVE_COMPARE_DRAFT"

	write_inactive_config "$variant"
	python3 - "$AGENT_DIR" "$variant" <<'PY'
import json
import sys
from pathlib import Path

agent = Path(sys.argv[1])
variant = sys.argv[2]
settings = json.loads((agent / "settings.json").read_text(encoding="utf-8"))
expected = ["taskboard", "presentation"] + (["appearance"] if variant == "target" else []) + ["statusline", "mode", "btw"]
actual = [Path(package).name for package in settings["packages"]]
assert actual == expected, (actual, expected)
assert settings["theme"] == "dark"
assert "editorPaddingX" not in settings and "outputPad" not in settings
assert json.loads((agent / "terrific.json").read_text(encoding="utf-8")) == {"appearance": {"profile": "off"}}
statusline = json.loads((agent / "statusline.json").read_text(encoding="utf-8"))
assert statusline["layout"] == "single"
assert "duration" not in statusline["widgets"] and "state" in statusline["widgets"]
PY
	mkdir -p "$point" "$session_dir"
	: >"$raw"
	: >"$seed_file"
	printf -v launch '%q %q %q %q %q %q %q %q %q %q %q %q %q %q' \
		"$WRAPPER" "$gate" "$tty_before" "$tty_after" "$RUNTIME_PROJECT" "$PATH" "$TMP/home" "truecolor" \
		"$RUNTIME_PI_HOME" "$RUNTIME_AGENT_DIR" "$PI_PACKAGE/dist/cli.js" "$session_dir" "$seed_file" "$seed_name"
	tmux -L "$SOCKET" -f /dev/null new-session -d -s "$session" -x "$cols" -y "$rows" -e "COLORTERM=truecolor" "$launch"
	[[ "$(tmux -L "$SOCKET" display-message -p -t "$target" '#{pane_width}x#{pane_height}')" == "${cols}x${rows}" ]] \
		|| { echo "tmux pane dimension mismatch: $prefix" >&2; exit 1; }
	wait_for_pane "$target" "__START_GATE_READY__"
	printf -v pipe_command 'cat > %q' "$raw"
	tmux -L "$SOCKET" pipe-pane -O -t "$target" "$pipe_command"
	raw_start="$(raw_offset "$raw")"
	touch "$gate"
	wait_for_raw_after "$raw" "$raw_start" "Ready"
	pane_alive "$target" || { echo "Pi exited during inactive startup: $prefix" >&2; exit 1; }
	tmux -L "$SOCKET" send-keys -t "$target" -l "$draft"
	wait_for_pane "$target" "$draft"

	tmux -L "$SOCKET" capture-pane -p -t "$target" >"$point/surface.txt"
	tmux -L "$SOCKET" capture-pane -p -e -t "$target" >"$point/surface.ansi"
	[[ -s "$point/surface.txt" && -s "$point/surface.ansi" ]] \
		|| { echo "inactive surface capture is empty: $prefix" >&2; exit 1; }
	if [[ "$variant" == "target" ]]; then
		! grep -Fxq "Terrific" "$point/surface.txt" || { echo "inactive target mounted Terrific header: $prefix" >&2; exit 1; }
		! grep -Fq "enter submit  ·  shift+enter/ctrl+j newline" "$point/surface.txt" \
			|| { echo "inactive target mounted appearance shortcuts: $prefix" >&2; exit 1; }
		! grep -Fq "─ ❯ ─" "$point/surface.txt" || { echo "inactive target mounted custom editor: $prefix" >&2; exit 1; }
	fi

	normalize_inactive_surface "$point/surface.txt" "$OUT/${cols}x${rows}-${variant}.txt"
	normalize_inactive_surface "$point/surface.ansi" "$OUT/${cols}x${rows}-${variant}.ansi"
	for artifact in "$OUT/${cols}x${rows}-${variant}.txt" "$OUT/${cols}x${rows}-${variant}.ansi"; do
		! grep -aFq "$TMP" "$artifact" || { echo "temporary path leaked into $artifact" >&2; exit 1; }
		! grep -aEq 'raw\.bin|/sessions/|inactive-[0-9]+-[0-9]+-(baseline|target)' "$artifact" \
			|| { echo "session/raw path leaked into $artifact" >&2; exit 1; }
	done

	tmux -L "$SOCKET" send-keys -t "$target" C-c
	for _ in {1..100}; do
		if ! tmux -L "$SOCKET" capture-pane -p -t "$target" | grep -Fq "$draft"; then break; fi
		sleep 0.05
	done
	! tmux -L "$SOCKET" capture-pane -p -t "$target" | grep -Fq "$draft" \
		|| { echo "Ctrl+C did not clear inactive draft: $prefix" >&2; exit 1; }
	raw_start="$(raw_offset "$raw")"
	send_command "$target" /quit
	wait_for_raw_after "$raw" "$raw_start" "__SHELL_READY__"
	wait_for_raw_after "$raw" "$raw_start" "__PI_EXIT__=0"
	tmux -L "$SOCKET" send-keys -t "$target" -l "$shell_line"
	tmux -L "$SOCKET" send-keys -t "$target" Enter
	wait_for_raw_after "$raw" "$raw_start" "__SHELL_ECHO__=$shell_line"
	wait_for_raw_after "$raw" "$raw_start" "__STTY_EXACT_MATCH__"
	cmp -s "$tty_before" "$tty_after" || { echo "stty state was not restored exactly: $prefix" >&2; exit 1; }
	if tmux -L "$SOCKET" has-session -t "$session" 2>/dev/null; then
		tmux -L "$SOCKET" kill-session -t "$session"
	fi
}

compare_inactive_width() {
	local cols="$1" rows="$2" stem="${cols}x${rows}"
	local baseline_txt="$OUT/$stem-baseline.txt" target_txt="$OUT/$stem-target.txt"
	local baseline_ansi="$OUT/$stem-baseline.ansi" target_ansi="$OUT/$stem-target.ansi"
	local diff_file="$TMP/$stem.diff" txt_hash ansi_hash
	if ! diff -u --label "$stem-baseline.txt" --label "$stem-target.txt" "$baseline_txt" "$target_txt" >"$diff_file"; then
		echo "inactive plain UI surfaces differ at $stem:" >&2
		cat "$diff_file" >&2
		exit 1
	fi
	if ! diff -u --label "$stem-baseline.ansi" --label "$stem-target.ansi" "$baseline_ansi" "$target_ansi" >"$diff_file"; then
		echo "inactive ANSI UI surfaces differ at $stem:" >&2
		cat "$diff_file" >&2
		exit 1
	fi
	txt_hash="$(sha256sum "$baseline_txt" | cut -d' ' -f1)"
	ansi_hash="$(sha256sum "$baseline_ansi" | cut -d' ' -f1)"
	cat >"$OUT/$stem-comparison.txt" <<EOF
width=$cols
height=$rows
pi_version=0.81.1
baseline_packages=taskboard,presentation,statusline,mode,btw
target_packages=taskboard,presentation,appearance,statusline,mode,btw
theme=dark
appearance_profile=off
statusline_layout=single
statusline_duration_widget=disabled_for_deterministic_byte_comparison
model=openai/gpt-5.6-terra (offline placeholder authentication)
archive_installs=1
runtime=actual_tmux_tui
baseline_exit=0
target_exit=0
terminal_state_restored=yes
target_terrific_header=absent
target_appearance_shortcuts=absent
target_custom_editor=absent
plain_sha256=$txt_hash
ansi_sha256=$ansi_hash
plain_byte_equal=yes
ansi_byte_equal=yes
runtime_theme_equal_to_builtin_dark_baseline=yes
normalization=appearance-owned extension/theme resource discovery; isolated paths; session UUID
EOF
	echo "inactive comparison passed: $stem plain=$txt_hash ansi=$ansi_hash"
}

if [[ "$CAPTURE_MODE" == "inactive-compare" ]]; then
	for dimensions in "80 24" "120 40" "160 50"; do
		read -r cols rows <<<"$dimensions"
		run_inactive_variant "$cols" "$rows" baseline
		run_inactive_variant "$cols" "$rows" target
		compare_inactive_width "$cols" "$rows"
	done
	(
		cd "$OUT"
		sha256sum -- *.ansi *-baseline.txt *-target.txt *-comparison.txt | LC_ALL=C sort -k2 >SHA256SUMS
	)
	echo "inactive comparison SHA256SUMS:"
	cat "$OUT/SHA256SUMS"
	exit 0
fi

run_matrix_point 80 24 truecolor
run_matrix_point 120 40 truecolor
run_matrix_point 160 50 truecolor
run_matrix_point 120 40 256color
(
	cd "$OUT"
	sha256sum -- *.ansi *.png *.txt | LC_ALL=C sort -k2 >SHA256SUMS
)
echo "capture SHA256SUMS:"
cat "$OUT/SHA256SUMS"
