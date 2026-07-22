#!/usr/bin/env bash
# Smoke-test the packed offline installer in isolated agent and skill directories.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/terrific-pi-install-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/out"
DEFAULT_PI_HOME="$TMP/default-pi"
RESTORE_PI_HOME="$TMP/restore-pi"
SKILLS="$TMP/skills"

"$ROOT/scripts/pack.sh" "$OUT" >/dev/null
ARCHIVE="$(find "$OUT" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
[[ -n "$ARCHIVE" ]] || { echo "missing archive" >&2; exit 1; }
mkdir -p "$DEFAULT_PI_HOME/agent"
printf '%s\n' '{"packages":["npm:keep-me","git:git@github.com:Lcc1ccl/pi-tool-display@stale"]}' >"$DEFAULT_PI_HOME/agent/settings.json"
FORCE=1 PI_HOME="$DEFAULT_PI_HOME" AGENTS_SKILLS_DIR="$SKILLS" "$ROOT/scripts/install.sh" "$ARCHIVE" >/dev/null
FORCE=1 RESTORE=1 PI_HOME="$RESTORE_PI_HOME" AGENTS_SKILLS_DIR="$SKILLS" "$ROOT/scripts/install.sh" "$ARCHIVE" >/dev/null

python3 - "$DEFAULT_PI_HOME/agent" "$RESTORE_PI_HOME/agent" "$ARCHIVE" <<'PY'
import json, sys, tarfile
from pathlib import Path
default_agent, restore_agent, archive = map(Path, sys.argv[1:])
pins = (
    "git:git@github.com:Lcc1ccl/pi-tool-display@8dd8fcaa7a3307abac5ee05f735615d4eae394b1",
    "git:git@github.com:Lcc1ccl/pi-compact-transcript@1bad0d81c38ca0821710e466a8e76928bdc326ef",
)
for agent in (default_agent, restore_agent):
    packages = json.loads((agent / "settings.json").read_text(encoding="utf-8"))["packages"]
    for package in pins:
        assert package in packages, f"missing package pin: {package}"
    assert not any(package.endswith("@stale") for package in packages), "stale pin survived merge"
    for relative in (
        "extensions/pi-tool-display/config.json",
        "extensions/pi-compact-transcript/config.json",
    ):
        assert (agent / relative).is_file(), f"missing nested snapshot: {relative}"
    docsflow = json.loads((agent / "terrific.json").read_text(encoding="utf-8")).get("docsflow", {})
    assert not str(docsflow.get("vaultRoot", "")).startswith("/"), "absolute docsflow path leaked into snapshot"
    assert "/home/" not in (agent / "AGENTS.md").read_text(encoding="utf-8"), "agent instructions leaked a source home path"
default_packages = json.loads((default_agent / "settings.json").read_text(encoding="utf-8"))["packages"]
assert "npm:keep-me" in default_packages, "default merge dropped unrelated package"
with tarfile.open(archive, "r:gz") as tf:
    manifest = next(tf.extractfile(name).read().decode("utf-8") for name in tf.getnames() if name.endswith("/MANIFEST.txt"))
assert "git_dirty=" in manifest, "manifest has no worktree provenance"
assert "external_packages<<" in manifest, "manifest has no external package block"
assert "agent/extensions/pi-tool-display/config.json" in manifest, "manifest flattened nested path"
assert "source_root=" not in manifest and "/home/" not in manifest, "manifest leaked a local source path"
PY

echo "install smoke passed"
