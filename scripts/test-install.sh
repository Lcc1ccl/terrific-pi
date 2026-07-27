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
    assert "../vendor/terrific-pi/extensions/appearance" in packages, "appearance package missing"
    assert "../vendor/terrific-pi/extensions/presentation" in packages, "presentation package missing"
    assert "../vendor/terrific-pi/extensions/taskboard" in packages, "taskboard package missing"
    assert packages.index("../vendor/terrific-pi/extensions/taskboard") < packages.index("../vendor/terrific-pi/extensions/presentation"), "taskboard must load before presentation"
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
manifest_packages = manifest.split("packages<<\n", 1)[1].split("\n>>", 1)[0].splitlines()
assert manifest_packages.index("../vendor/terrific-pi/extensions/taskboard") < manifest_packages.index("../vendor/terrific-pi/extensions/presentation"), "manifest must load taskboard before presentation"
assert "npm:pi-subagents" in manifest, "manifest does not retire npm pi-subagents"
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
for relative in (
    "extensions/appearance/extensions/appearance.ts",
    "extensions/appearance/themes/terrific-night.json",
    "extensions/appearance/package.json",
):
    assert any(name.endswith("/" + relative) for name in names), f"appearance archive resource missing: {relative}"
appearance_package_name = next(name for name in names if name.endswith("/extensions/appearance/package.json"))
appearance_package = json.loads(members[appearance_package_name])
appearance_root = appearance_package_name.rsplit("/", 1)[0]
for extension in appearance_package["pi"]["extensions"]:
    member = appearance_root + "/" + extension.removeprefix("./")
    assert member in names, f"appearance pi.extensions path missing: {extension}"
for theme_path in appearance_package["pi"]["themes"]:
    prefix = appearance_root + "/" + theme_path.removeprefix("./").rstrip("/") + "/"
    assert any(name.startswith(prefix) for name in names), f"appearance pi.themes path missing: {theme_path}"

production = {
    name: content.decode("utf-8", errors="replace")
    for name, content in members.items()
    if "/extensions/" in name
    and name.endswith(".ts")
    and "/tests/" not in name
    and "/benchmarks/" not in name
}
def packages_with(pattern):
    return {
        name.split("/extensions/", 1)[1].split("/", 1)[0]
        for name, source in production.items()
        if pattern.search(source)
    }
assert packages_with(__import__("re").compile(r"\.setHeader\s*\(")) == {"appearance"}, "setHeader owner is not appearance-only"
assert packages_with(__import__("re").compile(r"\.setEditorComponent\s*\(")) == {"appearance"}, "setEditorComponent owner is not appearance-only"
assert packages_with(__import__("re").compile(r"\.setFooter\s*\(")) == {"statusline"}, "setFooter owner is not statusline-only"
appearance_sources = "\n".join(source for name, source in production.items() if "/extensions/appearance/" in name)
assert not __import__("re").search(r"\.setStatus\s*\(", appearance_sources), "appearance must not call setStatus"
for literal, owner in (
    ("terrific-pi:taskboard", "taskboard"),
    ("terrific-pi:appearance-shortcuts", "appearance"),
):
    owners = {
        name.split("/extensions/", 1)[1].split("/", 1)[0]
        for name, source in production.items()
        if literal in source
    }
    assert owners == {owner}, f"widget key {literal} is not owned only by {owner}: {owners}"
compat_name = next(name for name in production if name.endswith("/extensions/presentation/lib/compat/index.ts"))
targets = __import__("re").findall(r"patchPrototypeMethod\s*\(\s*([A-Za-z]+Component\.prototype)", production[compat_name])
assert targets == ["UserMessageComponent.prototype", "ToolExecutionComponent.prototype"], f"unexpected presentation patch targets: {targets}"

assert not any("pi-tool-display/config.json" in name or "pi-compact-transcript/config.json" in name for name in names), "retired renderer config shipped"
assert "source_root=" not in manifest and "/home/" not in manifest, "manifest leaked a local source path"
PY

HOST_PI_PACKAGE="$ROOT/extensions/appearance/node_modules/@earendil-works/pi-coding-agent"
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

NATIVE_AGENT="$TMP/native-agent"
NATIVE_PROJECT="$TMP/native-project"
NATIVE_BACKUP="$NATIVE_AGENT/backups/terrific-native-v1-baseline"
mkdir -p "$NATIVE_AGENT" "$NATIVE_PROJECT"
python3 - "$NATIVE_AGENT" <<'PY'
import json, sys
from pathlib import Path
agent = Path(sys.argv[1])
packages = [
    "../vendor/terrific-pi/extensions/taskboard",
    "../vendor/terrific-pi/extensions/presentation",
    "../vendor/terrific-pi/extensions/statusline",
    "../vendor/terrific-pi/extensions/mode",
    "../vendor/terrific-pi/extensions/btw",
]
(agent / "settings.json").write_text(json.dumps({"packages": packages, "theme": "dark"}, indent=2) + "\n", encoding="utf-8")
(agent / "terrific.json").write_text(json.dumps({"appearance": {"profile": "off"}}, indent=2) + "\n", encoding="utf-8")
PY
install -d -m 700 "$NATIVE_BACKUP"
: >"$NATIVE_BACKUP/SHA256SUMS"
: >"$NATIVE_BACKUP/ABSENT_FILES"
for name in settings.json terrific.json statusline.json; do
	if [[ -f "$NATIVE_AGENT/$name" ]]; then
		cp -a "$NATIVE_AGENT/$name" "$NATIVE_BACKUP/$name"
		( cd "$NATIVE_BACKUP" && sha256sum "$name" ) >>"$NATIVE_BACKUP/SHA256SUMS"
	else
		printf '%s\n' "$name" >>"$NATIVE_BACKUP/ABSENT_FILES"
	fi
done
[[ "$(wc -l <"$NATIVE_BACKUP/SHA256SUMS")" -eq 2 ]] || { echo "rollback baseline present-file count mismatch" >&2; exit 1; }
[[ "$(cat "$NATIVE_BACKUP/ABSENT_FILES")" == "statusline.json" ]] || { echo "rollback baseline absent-file record mismatch" >&2; exit 1; }
python3 - "$NATIVE_AGENT" <<'PY'
import json, sys
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
(agent / "terrific.json").write_text(json.dumps({"appearance": {"profile": "terrific-native-v1"}}, indent=2) + "\n", encoding="utf-8")
(agent / "statusline.json").write_text(json.dumps({"layout": "terrific", "iconMode": "plain"}, indent=2) + "\n", encoding="utf-8")
PY
mkdir -p "$NATIVE_AGENT/../vendor"
ln -s "$RESTORE_PI_HOME/vendor/terrific-pi" "$NATIVE_AGENT/../vendor/terrific-pi"
cat >"$TMP/native-integration.mjs" <<'JS'
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [agentDir, projectDir, installedRoot, piModule] = process.argv.slice(2);
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(piModule));
const settings = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  settingsManager: settings,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
});
const expectedPackages = ["taskboard", "presentation", "appearance", "statusline", "mode", "btw"];
function assertResources(currentLoader, packages, expectedThemeCount, label) {
  const extensionResult = currentLoader.getExtensions();
  const themeResult = currentLoader.getThemes();
  assert.deepEqual(extensionResult.errors, [], `${label} extension diagnostics: ${JSON.stringify(extensionResult.errors)}`);
  assert.deepEqual(themeResult.diagnostics, [], `${label} theme diagnostics: ${JSON.stringify(themeResult.diagnostics)}`);
  const extensionPaths = extensionResult.extensions.map((item) => item.path);
  assert.equal(extensionPaths.length, packages.length, `${label} extension count`);
  assert.equal(new Set(extensionPaths).size, extensionPaths.length, `${label} duplicate extension resource paths`);
  assert.deepEqual(extensionPaths.map((path) => path.split("/extensions/")[1].split("/")[0]), packages, `${label} extension order`);
  const terrificThemes = themeResult.themes.filter((theme) => theme.name === "terrific-night");
  assert.equal(terrificThemes.length, expectedThemeCount, `${label} terrific-night theme count`);
  const themePaths = themeResult.themes.map((theme) => theme.path).filter(Boolean);
  assert.equal(new Set(themePaths).size, themePaths.length, `${label} duplicate theme resource paths`);
}
for (let cycle = 1; cycle <= 10; cycle++) {
  await loader.reload();
  assertResources(loader, expectedPackages, 1, `reload cycle ${cycle}`);
  console.log(`Pi 0.81.1 six-package loader reload cycle ${cycle}/10 passed`);
}
const globalSettings = settings.getGlobalSettings();
assert.equal(globalSettings.theme, "terrific-night");
assert.equal(globalSettings.editorPaddingX, 1);
assert.equal(globalSettings.outputPad, 1);
assert.deepEqual(JSON.parse(await readFile(join(agentDir, "terrific.json"), "utf8")), { appearance: { profile: "terrific-native-v1" } });
assert.deepEqual(JSON.parse(await readFile(join(agentDir, "statusline.json"), "utf8")), { layout: "terrific", iconMode: "plain" });

const parserSpecs = [
  ["appearance", "lib/config.ts", "readAppearanceConfig"],
  ["presentation", "lib/profile.ts", "readTerrificNativeProfile"],
  ["statusline", "lib/appearance-profile.ts", "readAppearanceProfile"],
  ["taskboard", "lib/appearance-profile.ts", "readAppearanceProfile"],
  ["mode", "lib/appearance-profile.ts", "readAppearanceProfile"],
  ["btw", "lib/appearance-profile.ts", "readAppearanceProfile"],
];
const parsers = await Promise.all(parserSpecs.map(async ([pkg, file, exported]) => {
  const module = await import(pathToFileURL(join(installedRoot, "extensions", pkg, file)));
  return [pkg, module[exported]];
}));
const vectors = [
  [undefined, false, false, false],
  ["{}", false, false, false],
  ['{"appearance":{"profile":"terrific-native-v1"}}', true, false, false],
  ['{"appearance":{"profile":"off"}}', false, false, false],
  ['{"appearance":{"profile":7}}', false, false, false],
  ['{"appearance":"on"}', false, true, false],
  ["{", false, true, false],
  ["{}", false, false, true],
];
const vectorRoot = resolve(agentDir, "..", "parser-vectors");
for (const [index, [source, active, error, projectOverride]] of vectors.entries()) {
  const globalDir = join(vectorRoot, `global-${index + 1}`);
  const cwd = join(vectorRoot, `project-${index + 1}`);
  await rm(globalDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await mkdir(globalDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  if (source !== undefined) await writeFile(join(globalDir, "terrific.json"), source + "\n");
  if (projectOverride) await writeFile(join(cwd, ".pi", "terrific.json"), '{"appearance":{"profile":"terrific-native-v1"}}\n');
  process.chdir(cwd);
  const results = parsers.map(([pkg, parser]) => {
    const result = parser(globalDir);
    return [pkg, result.active, Boolean(result.error)];
  });
  assert.ok(results.every(([, gotActive, gotError]) => gotActive === active && gotError === error), `profile vector ${index + 1} diverged: ${JSON.stringify(results)}`);
}
console.log("Pi 0.81.1 native loader 10-cycle gate and six parser vectors passed");
JS
node --experimental-strip-types "$TMP/native-integration.mjs" \
	"$NATIVE_AGENT" "$NATIVE_PROJECT" "$RESTORE_PI_HOME/vendor/terrific-pi" \
	"$HOST_PI_PACKAGE/dist/index.js"

while read -r _ name; do
	cp -a "$NATIVE_BACKUP/$name" "$NATIVE_AGENT/$name"
done <"$NATIVE_BACKUP/SHA256SUMS"
while read -r name; do
	[[ -n "$name" ]] && rm -f "$NATIVE_AGENT/$name"
done <"$NATIVE_BACKUP/ABSENT_FILES"
( cd "$NATIVE_AGENT" && sha256sum -c "$NATIVE_BACKUP/SHA256SUMS" ) >/dev/null
while read -r name; do
	[[ -z "$name" || ! -e "$NATIVE_AGENT/$name" ]] || { echo "rollback failed to remove baseline-absent file: $name" >&2; exit 1; }
done <"$NATIVE_BACKUP/ABSENT_FILES"
echo "TEMP-HOME rollback hash round-trip passed: SHA256SUMS exact; ABSENT_FILES deletion exact"

cat >"$TMP/native-rollback.mjs" <<'JS'
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [agentDir, projectDir, installedRoot, piModule] = process.argv.slice(2);
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(piModule));
const rollbackPackages = ["taskboard", "presentation", "statusline", "mode", "btw"];
const expectedSettings = {
  packages: rollbackPackages.map((pkg) => `../vendor/terrific-pi/extensions/${pkg}`),
  theme: "dark",
};
const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  settingsManager: manager,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
});
await loader.reload();
const extensionResult = loader.getExtensions();
const themeResult = loader.getThemes();
assert.deepEqual(extensionResult.errors, [], `rollback extension diagnostics: ${JSON.stringify(extensionResult.errors)}`);
assert.deepEqual(themeResult.diagnostics, [], `rollback theme diagnostics: ${JSON.stringify(themeResult.diagnostics)}`);
const extensionPaths = extensionResult.extensions.map((item) => item.path);
assert.equal(extensionPaths.length, 5, "rollback extension count");
assert.equal(new Set(extensionPaths).size, 5, "rollback duplicate extension resource paths");
assert.deepEqual(extensionPaths.map((item) => item.split("/extensions/")[1].split("/")[0]), rollbackPackages, "rollback extension order");
assert.equal(themeResult.themes.filter((theme) => theme.name === "terrific-night").length, 0, "rollback retained terrific-night theme");
const settings = manager.getGlobalSettings();
assert.equal(settings.theme, "dark", "rollback builtin theme");
assert.equal(manager.getEditorPaddingX(), 0, "rollback editorPaddingX default");
assert.equal(manager.getOutputPad(), 1, "rollback outputPad default");
assert.ok(!("editorPaddingX" in settings), "rollback settings retained editorPaddingX");
assert.ok(!("outputPad" in settings), "rollback settings retained outputPad");
assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), expectedSettings, "rollback settings baseline");
assert.deepEqual(JSON.parse(await readFile(join(agentDir, "terrific.json"), "utf8")), { appearance: { profile: "off" } }, "rollback terrific baseline");
await assert.rejects(stat(join(agentDir, "statusline.json")), (error) => error?.code === "ENOENT", "rollback statusline baseline absence");
const parserSpecs = [
  ["presentation", "lib/profile.ts", "readTerrificNativeProfile"],
  ["statusline", "lib/appearance-profile.ts", "readAppearanceProfile"],
  ["taskboard", "lib/appearance-profile.ts", "readAppearanceProfile"],
  ["mode", "lib/appearance-profile.ts", "readAppearanceProfile"],
  ["btw", "lib/appearance-profile.ts", "readAppearanceProfile"],
];
const inactive = await Promise.all(parserSpecs.map(async ([pkg, file, exported]) => {
  const module = await import(pathToFileURL(join(installedRoot, "extensions", pkg, file)));
  return [pkg, module[exported](agentDir)];
}));
assert.ok(inactive.every(([, result]) => result.active === false && result.error === undefined), `rollback parser state: ${JSON.stringify(inactive)}`);
console.log("TEMP-HOME restored baseline loader passed: no appearance/theme, five packages, default padding, five parsers inactive");
JS
node --experimental-strip-types "$TMP/native-rollback.mjs" \
	"$NATIVE_AGENT" "$NATIVE_PROJECT" "$RESTORE_PI_HOME/vendor/terrific-pi" \
	"$HOST_PI_PACKAGE/dist/index.js"

AUDIT_UI_OWNERS_SETTINGS="$ROOT/agent/settings.packages.example.json" "$ROOT/scripts/audit-ui-owners.sh"
echo "proposed Terrific native settings owner audit passed"

echo "install smoke passed"
