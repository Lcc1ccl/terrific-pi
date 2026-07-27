# pilot

Manual human-in-the-loop Copilot for Pi. Pilot is inactive after startup and only takes over after an explicit `/pilot` command.

```text
/pilot
  -> submit one implementation goal
  -> fresh read-only Planner creates requirements + handoff
  -> /pilot work shows the complete plan and exact Execution Envelope
  -> human Authorize / exact headless digest confirmation
  -> one constrained foreground Worker
  -> declared package-script verification
  -> fresh read-only Reviewer receives the actual Git diff
  -> passed or non-passed receipt; no automatic fix loop
```

The canonical Bundle lives under `<git-common-dir>/pilot/runs/<run-id>/`, outside the project worktree. It rejects symlinked path components and uses a Bundle-wide exclusive lock, atomic writes, artifact hashes, and manifest revisions for `requirements.md`, `handoff.md`, `execution.json`, reviewer evidence, and `receipt.json`. Terminal state and its receipt ref are committed under one lock.

## Product Boundary

- Explicit manual activation only. Pilot does not register `/mode`, call the Auxiliary AUTO router, or take over ordinary prompts while inactive. An already authorized execution remains the mutation owner across session-tree navigation, including branches that restore inactive.
- The standalone `mode` and `docsflow` packages remain independent and can be installed beside Pilot.
- Trusted Git repositories with a clean worktree and index only.
- One foreground `primary-solo` Writer with `read`, `grep`, `find`, `ls`, `edit`, and `write`, restricted to approved existing write roots by a one-shot Pilot policy and a fail-closed guard inside the Worker child process.
- Fresh Planner and Reviewer profiles are read-only. The Reviewer receives the exact observed Git diff and must map every approved acceptance criterion to evidence.
- The Work Gate discloses goal, scope, non-goals, acceptance, risks, write roots, resolved package scripts, the fixed 15-minute per-command verification deadline, Git baseline, policy-bound profiles, and the exact digest.
- Validation is restricted to `npm|pnpm|yarn|bun test` or `run <script>`. The complete root `package.json` hash, fixed deadline, and every applicable `pre`/main/`post` lifecycle script are disclosed, bound, and rechecked before each command. Cancellation or deadline expiry terminates the complete validation process group before returning and records `exitCode: null`, captured output, duration, and termination reason.
- Reviewer failure, missing acceptance evidence, scope drift, validation failure, cancellation, or policy drift stops the run and records the final observed delta. Pilot does not retry or fix automatically.
- Pilot never stages, commits, pushes, stashes, resets, or rolls back project changes.

Pilot owns constrained preflight and one-shot policy grants. It sends only the fixed `pi-subagents` public V1 foreground request. Because that runner uses profile tools as the child process registry allowlist, the package Worker declares the fixed six Worker tools. Before the first model turn, the globally loaded Pilot extension reduces the active set to the four read-only bootstrap tools, atomically consumes the task-bound capability inside `PI_SUBAGENT_CHILD=1`, rejects user/nearest-project/configured-package/local-or-global-npm profile shadows, symlink shadows, and user/project overrides, rechecks child identity, package profile hash, cwd, task, bootstrap tools, and canonical write roots, and only then re-enables `edit`/`write`. An invalid, missing, or replayed capability remains fully blocked by the loaded guard, and later runtime-added tools remain blocked by the policy allowlist. Cancellation retains execution ownership until the correlated child terminal response arrives. If a `started` public-V1 request never produces its required terminal response, Pilot deliberately remains fail-closed, reports the pending owner in `/pilot status`, and does not emit a stale terminal receipt. The offline package does not depend on unpublished or uncommitted `pi-subagents` launch-policy code.

The child policy constrains the trusted local Pi process model. It is not an OS sandbox against a hostile same-UID process or malicious code inside an authorized package script.

## Commands

```text
/pilot                         activate manual Copilot for this session
/pilot status                  show activation and active Bundle status
/pilot cancel                  cancel a running workflow or a ready, unauthorized Bundle
/pilot work                    display the complete Work Gate; never writes
/pilot work --confirm <digest> authorize the unchanged Envelope in headless mode
/pilot off                     deactivate when no workflow is running
```

In TUI mode, `/pilot work` uses `Authorize Pilot Work`; headless mode requires a second exact-digest command. Changing the project baseline, artifacts, profiles, tools, write roots, validation commands, or package scripts invalidates the previous digest.

## Install

Pilot is part of the normal terrific-pi offline install and coexists with the existing mode and docsflow packages:

```json
"../vendor/terrific-pi/extensions/mode",
"../vendor/terrific-pi/extensions/pilot",
"../vendor/terrific-pi/extensions/docsflow"
```

Installation does not activate Pilot. Run `/pilot` explicitly in a trusted, clean Git project.

## Verify

```bash
npm run check
```
