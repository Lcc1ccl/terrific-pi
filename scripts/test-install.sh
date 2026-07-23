#!/usr/bin/env bash
# Smoke-test the packed offline installer in isolated agent and skill directories.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/terrific-pi-install-test.XXXXXX")"
PACK_FIXTURE_NAME="pack-test-$$"
PACK_FIXTURE="$ROOT/workflows/$PACK_FIXTURE_NAME"
PACK_SUBAGENT_FIXTURE="$ROOT/workflows/.pi-subagents/$PACK_FIXTURE_NAME"
cleanup() {
	rm -rf "$TMP" "$PACK_FIXTURE" "$PACK_SUBAGENT_FIXTURE"
	rmdir "$ROOT/workflows/.pi-subagents" 2>/dev/null || true
}
trap cleanup EXIT
OUT="$TMP/out"
NO_PRUNE_OUT="$TMP/no-prune"
DEFAULT_PI_HOME="$TMP/default-pi"
RESTORE_PI_HOME="$TMP/restore-pi"
SKILLS="$TMP/skills"

mkdir -p "$PACK_FIXTURE/sessions" "$PACK_FIXTURE/__pycache__" "$PACK_SUBAGENT_FIXTURE" "$OUT"
printf '# safe workflow fixture\n' >"$PACK_FIXTURE/workflow.md"
printf 'SECRET=test-only\n' >"$PACK_FIXTURE/.env"
printf '{}\n' >"$PACK_FIXTURE/auth.json"
printf '{}\n' >"$PACK_FIXTURE/sessions/session.jsonl"
printf 'test pem fixture\n' >"$PACK_FIXTURE/private.pem"
printf 'cache\n' >"$PACK_FIXTURE/__pycache__/cache.pyc"
printf 'runtime\n' >"$PACK_SUBAGENT_FIXTURE/runtime.txt"

for i in {1..7}; do
	printf 'old archive %s\n' "$i" >"$OUT/terrific-pi-2000010${i}T000000Z-old.tar.gz"
	touch -t "2000010${i}0000.00" "$OUT/terrific-pi-2000010${i}T000000Z-old.tar.gz"
done
printf 'keep me\n' >"$OUT/unrelated.txt"
DIST_KEEP=5 "$ROOT/scripts/pack.sh" "$OUT" >/dev/null
ARCHIVE="$(find "$OUT" -maxdepth 1 -type f -name 'terrific-pi-*.tar.gz' -size +1024c -print -quit)"
[[ -n "$ARCHIVE" ]] || { echo "missing archive" >&2; exit 1; }
[[ "$(find "$OUT" -maxdepth 1 -type f -name 'terrific-pi-*.tar.gz' | wc -l)" -eq 5 ]] \
	|| { echo "dist retention did not keep exactly 5 archives" >&2; exit 1; }
for i in {4..7}; do
	[[ -f "$OUT/terrific-pi-2000010${i}T000000Z-old.tar.gz" ]] \
		|| { echo "dist retention removed a newer archive: $i" >&2; exit 1; }
done
for i in {1..3}; do
	[[ ! -e "$OUT/terrific-pi-2000010${i}T000000Z-old.tar.gz" ]] \
		|| { echo "dist retention kept an older archive: $i" >&2; exit 1; }
done
[[ -f "$OUT/unrelated.txt" ]] || { echo "dist retention removed an unrelated file" >&2; exit 1; }
mkdir -p "$NO_PRUNE_OUT"
printf 'old archive\n' >"$NO_PRUNE_OUT/terrific-pi-20000101T000000Z-old.tar.gz"
DIST_KEEP=0 "$ROOT/scripts/pack.sh" "$NO_PRUNE_OUT" >/dev/null
[[ "$(find "$NO_PRUNE_OUT" -maxdepth 1 -type f -name 'terrific-pi-*.tar.gz' | wc -l)" -eq 2 ]] \
	|| { echo "DIST_KEEP=0 unexpectedly removed archives" >&2; exit 1; }
python3 - "$ARCHIVE" "$PACK_FIXTURE_NAME" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
archive, fixture = sys.argv[1:]
with tarfile.open(archive, "r:gz") as tf:
    names = tf.getnames()
assert any(name.endswith("/.gitignore") for name in names), "root .gitignore missing"
assert any(name.endswith(f"/workflows/{fixture}/workflow.md") for name in names), "safe workflow file missing"
forbidden = []
for name in names:
    parts = PurePosixPath(name).parts
    base = parts[-1] if parts else ""
    if ".pi-subagents" in parts or "sessions" in parts or "__pycache__" in parts:
        forbidden.append(name)
    elif base == ".env" or base.startswith(".env.") or base == "auth.json":
        forbidden.append(name)
    elif base.endswith((".jsonl", ".pem", ".key", ".pyc", ".pyo")):
        forbidden.append(name)
assert not forbidden, f"forbidden archive members: {forbidden[:10]}"
PY
mkdir -p "$DEFAULT_PI_HOME/agent"
printf '%s\n' '{"packages":["npm:keep-me","npm:pi-subagents@0.35.1","git:git@github.com:Lcc1ccl/pi-tool-display@stale","git:git@github.com:Lcc1ccl/pi-compact-transcript@stale","../vendor/terrific-pi/extensions/process-view"]}' >"$DEFAULT_PI_HOME/agent/settings.json"
printf '%s\n' '{"processView":{"activityMode":"task","legacyOnly":true}}' >"$DEFAULT_PI_HOME/agent/terrific.json"
FORCE=1 PI_HOME="$DEFAULT_PI_HOME" AGENTS_SKILLS_DIR="$SKILLS" "$ROOT/scripts/install.sh" "$ARCHIVE" >/dev/null
FORCE=1 RESTORE=1 PI_HOME="$RESTORE_PI_HOME" AGENTS_SKILLS_DIR="$SKILLS" "$ROOT/scripts/install.sh" "$ARCHIVE" >/dev/null

python3 - "$DEFAULT_PI_HOME/agent" "$RESTORE_PI_HOME/agent" "$ARCHIVE" <<'PY'
import json, sys, tarfile
from pathlib import Path
default_agent, restore_agent, archive = map(Path, sys.argv[1:])
subagents_pin = "git:github.com/nicobailon/pi-subagents@bd32df2cc1a951b588f6f93f67f3b9adac406303"
retired = (
    "npm:pi-subagents",
    "git:git@github.com:Lcc1ccl/pi-tool-display",
    "git:git@github.com:Lcc1ccl/pi-compact-transcript",
)
for agent in (default_agent, restore_agent):
    packages = json.loads((agent / "settings.json").read_text(encoding="utf-8"))["packages"]
    assert "../vendor/terrific-pi/extensions/presentation" in packages, "presentation package missing"
    assert "../vendor/terrific-pi/extensions/taskboard" in packages, "taskboard package missing"
    assert "../vendor/terrific-pi/extensions/process-view" not in packages, "legacy process-view package survived migration"
    config = json.loads((agent / "terrific.json").read_text(encoding="utf-8"))
    if agent == default_agent:
        assert config == {"processView": {"activityMode": "task", "legacyOnly": True}}, "default install overwrote legacy config"
    else:
        assert isinstance(config.get("taskboard"), dict), "restored taskboard config missing"
        assert "processView" not in config, "legacy processView config survived restore"
    assert subagents_pin in packages, "fixed pi-subagents pin missing"
    assert not any(package.startswith(prefix + "@") for package in packages for prefix in retired), "retired package pin survived merge"
    for relative in (
        "extensions/pi-tool-display/config.json",
        "extensions/pi-compact-transcript/config.json",
    ):
        assert not (agent / relative).exists(), f"retired nested renderer config shipped: {relative}"
    docsflow = json.loads((agent / "terrific.json").read_text(encoding="utf-8")).get("docsflow", {})
    assert not str(docsflow.get("vaultRoot", "")).startswith("/"), "absolute docsflow path leaked into snapshot"
    assert "/home/" not in (agent / "AGENTS.md").read_text(encoding="utf-8"), "agent instructions leaked a source home path"
default_packages = json.loads((default_agent / "settings.json").read_text(encoding="utf-8"))["packages"]
assert "npm:keep-me" in default_packages, "default merge dropped unrelated package"
with tarfile.open(archive, "r:gz") as tf:
    names = tf.getnames()
    manifest = next(tf.extractfile(name).read().decode("utf-8") for name in names if name.endswith("/MANIFEST.txt"))
assert "git_dirty=" in manifest, "manifest has no worktree provenance"
assert "external_packages<<" in manifest, "manifest has no external package block"
assert subagents_pin in manifest, "manifest has no fixed pi-subagents pin"
assert "retired_external_packages<<" in manifest, "manifest has no retired package block"
assert "npm:pi-subagents" in manifest, "manifest does not retire npm pi-subagents"
assert "workflows<<" in manifest, "manifest has no workflows block"
assert not any("pi-tool-display/config.json" in name or "pi-compact-transcript/config.json" in name for name in names), "retired renderer config shipped"
assert "source_root=" not in manifest and "/home/" not in manifest, "manifest leaked a local source path"
PY

echo "install smoke passed"
