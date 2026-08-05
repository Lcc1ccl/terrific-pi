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

scan_archive_hygiene() {
	python3 - "$1" "$ROOT" "$HOME" <<'PY'
import json
import re
import sys
import tarfile

archive, repo_root, home = sys.argv[1:]
credential_keys = {"key", "token", "apikey", "accesstoken", "secret", "password", "clientsecret"}
auth_keys = {"key", "token", "apikey"}
private_key = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE[ ]KEY-----")
bearer = re.compile(rb"\bbearer[ \t]+(?![$<{[(])(?=[A-Za-z0-9._~+/=-]{16,}\b)[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
sk_token = re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b")
allowed_fake_suffix = "/extensions/context/tests/tokens.test.ts"
allowed_fake_token = b"sk" + b"-abcdefghijklmnopqrstuvwxyz012345"


def normalized_key(key):
    return re.sub(r"[-_]", "", key).lower()


def find_byte_issues(name, content, current_repo, current_home):
    issues = []
    repo_bytes = current_repo.encode("utf-8")
    home_bytes = current_home.encode("utf-8")
    if repo_bytes and repo_bytes in content:
        issues.append("current repository path")
    if home_bytes and home_bytes in content:
        issues.append("current home path prefix")
    secret_content = content
    if name.endswith(allowed_fake_suffix):
        secret_content = secret_content.replace(allowed_fake_token, b"")
    if private_key.search(secret_content):
        issues.append("private-key marker")
    if bearer.search(secret_content):
        issues.append("bearer-looking token")
    if sk_token.search(secret_content):
        issues.append("sk-looking token")
    return issues


def credential_json_issues(value, path="$", allowed=credential_keys):
    issues = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if normalized_key(str(key)) in allowed and child not in (None, "", [], {}):
                issues.append(child_path)
            issues.extend(credential_json_issues(child, child_path, allowed))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            issues.extend(credential_json_issues(child, f"{path}[{index}]", allowed))
    return issues


def auth_template_issues(value, path="$"):
    return credential_json_issues(value, path, auth_keys)


def inspect_payload(name, content, current_repo, current_home):
    issues = find_byte_issues(name, content, current_repo, current_home)
    text = None
    try:
        decoded = content.decode("utf-8")
    except UnicodeDecodeError as error:
        if name.lower().endswith(".json"):
            issues.append(f"invalid UTF-8 JSON: {error}")
    else:
        if b"\0" not in content:
            text = decoded
    value = None
    if name.lower().endswith(".json"):
        if b"\0" in content:
            issues.append("NUL byte in JSON")
        elif text is not None:
            try:
                value = json.loads(text)
            except json.JSONDecodeError as error:
                issues.append(f"invalid JSON: {error}")
            else:
                issues.extend(f"non-empty credential field {path}" for path in credential_json_issues(value))
    return issues, text, value


def run_self_test():
    sample_repo = "/sample/repo"
    sample_home = "/sample/home"
    private_sample = b"-----BEGIN PRIVATE" + b" KEY-----"
    bearer_sample = b"Authorization: Bearer " + b"abcdefghijklmnopqrstuvwxyz"
    other_token = b"sk" + b"-zyxwvutsrqponmlkjihgfedcba"

    def issues(name, content):
        return inspect_payload(name, content, sample_repo, sample_home)[0]

    assert issues("pkg/blob.bin", f"source={sample_repo}".encode()), "repo path sample was not detected"
    assert issues("pkg/blob.bin", f"home={sample_home}".encode()), "home path sample was not detected"
    assert issues("pkg/blob.bin", b"\xff" + sample_home.encode()), "invalid UTF-8 path sample was not detected"
    assert issues("pkg/blob.bin", b"\0" + sample_home.encode()), "NUL path sample was not detected"
    assert issues("pkg/lib/config.ts", private_sample), "private-key sample was not detected"
    assert issues("docs/config.md", bearer_sample), "bearer sample was not detected"
    assert issues("pkg/blob.bin", b"\xff\0" + other_token), "binary sk token was not detected"
    assert issues("agent/settings.json", b'{"token":"not-empty"}'), "JSON token sample was not detected"
    allowlisted = "root" + allowed_fake_suffix
    assert not issues(allowlisted, allowed_fake_token), "known context test token was rejected"
    assert issues(allowlisted, allowed_fake_token + b"\n" + other_token), "second secret in allowlisted file was not detected"
    assert not issues("docs/config.md", b"Authorization: Bearer $KEY\napiKey: sk-..."), "documented placeholders were rejected"
    assert issues("agent/broken.json", b'{"safe":"\xff"}'), "invalid UTF-8 JSON was accepted"
    assert issues("agent/broken.json", b'{"safe":"ok\0"}'), "NUL JSON was accepted"
    assert issues("snapshot/agent/auth.template.json", b"\xff"), "binary auth template was accepted"
    assert issues("snapshot/agent/auth.template.json", b"{"), "malformed auth template was accepted"
    assert auth_template_issues({"nested": {"token": "not-empty"}}), "nested auth token was not detected"
    assert auth_template_issues({"apiKey": 7}), "non-string auth credential was not detected"
    assert not auth_template_issues({"nested": {"apiKey": "", "key": ""}}), "empty auth fields were rejected"
    print("archive scanner self-test passed: detections=15 allowances=3 including exact-token-only exception")


run_self_test()
if archive == "--self-test":
    raise SystemExit(0)

payload_count = 0
text_count = 0
auth_count = 0
failures = []
with tarfile.open(archive, "r:gz") as tf:
    for member in tf.getmembers():
        if not member.isfile():
            continue
        payload_count += 1
        is_auth_name = member.name.rsplit("/", 1)[-1].lower() == "auth.template.json"
        if is_auth_name:
            auth_count += 1
            if not member.name.endswith("/snapshot/agent/auth.template.json"):
                failures.append(f"{member.name}: unexpected auth template path")
        source = tf.extractfile(member)
        assert source is not None, f"cannot read archive member: {member.name}"
        content = source.read()
        issues, text, value = inspect_payload(member.name, content, repo_root, home)
        failures.extend(f"{member.name}: {issue}" for issue in issues)
        if text is not None:
            text_count += 1
        if is_auth_name and value is not None:
            failures.extend(f"{member.name}: non-empty auth credential {path}" for path in auth_template_issues(value))
if auth_count != 1:
    failures.append(f"archive: expected exactly 1 auth.template.json, found {auth_count}")
if failures:
    raise SystemExit("archive hygiene failures:\n" + "\n".join(failures[:20]))
print(f"archive hygiene scan passed: regular_payloads={payload_count} utf8_text_payloads={text_count} auth_templates={auth_count}")
PY
}

if [[ "${SCANNER_SELF_TEST_ONLY:-0}" == "1" ]]; then
	scan_archive_hygiene --self-test
	exit
fi

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
scan_archive_hygiene "$ARCHIVE"
mkdir -p "$DEFAULT_PI_HOME/agent"
printf '%s\n' '{"packages":["npm:keep-me","npm:pi-subagents@0.35.1","npm:pi-vision-handoff@0.8.1","git:git@github.com:Lcc1ccl/pi-tool-display@stale","git:git@github.com:Lcc1ccl/pi-compact-transcript@stale","../vendor/terrific-pi/extensions/process-view"]}' >"$DEFAULT_PI_HOME/agent/settings.json"
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
    "npm:pi-vision-handoff",
    "git:git@github.com:Lcc1ccl/pi-tool-display",
    "git:git@github.com:Lcc1ccl/pi-compact-transcript",
)
for agent in (default_agent, restore_agent):
    packages = json.loads((agent / "settings.json").read_text(encoding="utf-8"))["packages"]
    assert "../vendor/terrific-pi/extensions/presentation" in packages, "presentation package missing"
    assert "../vendor/terrific-pi/extensions/appearance" in packages, "appearance package missing"
    assert "../vendor/terrific-pi/extensions/taskboard" in packages, "taskboard package missing"
    assert "../vendor/terrific-pi/extensions/process-view" not in packages, "legacy process-view package survived migration"
    assert "../vendor/terrific-pi/extensions/mode" in packages, "standalone mode package missing"
    assert "../vendor/terrific-pi/extensions/pilot" in packages, "manual Pilot package missing"
    assert "../vendor/terrific-pi/extensions/docsflow" in packages, "standalone docsflow package missing"
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
    members = {
        name: tf.extractfile(name).read()
        for name in names
        if tf.getmember(name).isfile()
    }
    manifest = next(content.decode("utf-8") for name, content in members.items() if name.endswith("/MANIFEST.txt"))
assert "git_dirty=" in manifest, "manifest has no worktree provenance"
assert "external_packages<<" in manifest, "manifest has no external package block"
assert subagents_pin in manifest, "manifest has no fixed pi-subagents pin"
assert "retired_external_packages<<" in manifest, "manifest has no retired package block"
assert "../vendor/terrific-pi/extensions/pilot" in manifest, "manifest does not enable manual Pilot"
assert "../vendor/terrific-pi/extensions/appearance" in manifest, "manifest does not enable appearance"
assert "npm:pi-subagents" in manifest, "manifest does not retire npm pi-subagents"
assert "npm:pi-vision-handoff" in manifest, "manifest does not retire pi-vision-handoff"
assert "workflows<<" in manifest, "manifest has no workflows block"
for relative in (
    "extensions/pilot/extensions/pilot.ts",
    "extensions/pilot/agents/pilot-planner.md",
    "extensions/pilot/agents/pilot-worker.md",
    "extensions/pilot/agents/pilot-reviewer.md",
    "extensions/pilot/lib/bundle.ts",
    "extensions/pilot/lib/worker-policy.ts",
    "extensions/pilot/tests/fixtures/worker-policy-child.ts",
):
    assert any(name.endswith("/" + relative) for name in names), f"Pilot archive resource missing: {relative}"
assert not any("pi-tool-display/config.json" in name or "pi-compact-transcript/config.json" in name for name in names), "retired renderer config shipped"
assert "source_root=" not in manifest and "/home/" not in manifest, "manifest leaked a local source path"
PY

HOST_PI_PACKAGE="$ROOT/extensions/presentation/node_modules/@earendil-works/pi-coding-agent"
HOST_PI_TUI="$HOST_PI_PACKAGE/node_modules/@earendil-works/pi-tui"
[[ -d "$HOST_PI_PACKAGE" && -d "$HOST_PI_TUI" ]] || { echo "missing Pi 0.81.1 peers for installed payload tests" >&2; exit 1; }
[[ "$(node -p "require('$HOST_PI_PACKAGE/package.json').version")" == "0.81.1" ]] \
	|| { echo "installed payload gate requires Pi 0.81.1" >&2; exit 1; }
mkdir -p "$RESTORE_PI_HOME/vendor/terrific-pi/node_modules/@earendil-works"
ln -s "$HOST_PI_PACKAGE" "$RESTORE_PI_HOME/vendor/terrific-pi/node_modules/@earendil-works/pi-coding-agent"
ln -s "$HOST_PI_TUI" "$RESTORE_PI_HOME/vendor/terrific-pi/node_modules/@earendil-works/pi-tui"
HOST_SUBAGENTS="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/nicobailon/pi-subagents"
if [[ -d "$HOST_SUBAGENTS" ]]; then
	mkdir -p "$RESTORE_PI_HOME/agent/git/github.com/nicobailon"
	ln -s "$HOST_SUBAGENTS" "$RESTORE_PI_HOME/agent/git/github.com/nicobailon/pi-subagents"
fi
PI_CODING_AGENT_DIR="$RESTORE_PI_HOME/agent" npm --prefix "$RESTORE_PI_HOME/vendor/terrific-pi/extensions/pilot" test


echo "install smoke passed"
