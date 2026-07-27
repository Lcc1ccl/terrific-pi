# Pilot 人机共驾 Copilot 需求与实现计划

> 状态：**Copilot 全量验收完成**
>
> 创建：2026-07-20
>
> 范围修订：2026-07-23
>
> 本版取代本文此前的 AUTO-first、通用 Stage、Worktree Team、Background/Future Goal 路线。历史 Git 记录保留旧方案；本文是当前 Pilot 唯一需求基线。

## 1. 目标

Pilot 是一个显式启用、单次授权、单写者的人机共驾 Copilot。

人类负责：

- 决定何时由 Pilot 接管。
- 提出目标并审阅 goal、scope、non-goals、acceptance 与 risks。
- 批准当前精确 Execution Envelope。
- 在 Reviewer 不通过、出现决策项或执行失败后决定下一步。
- 自行管理 stage、commit、push、rollback 与最终交付。

Pilot 负责：

- 把一个明确目标整理为可执行的 requirements 与 handoff。
- 在写入前绑定并展示权限、范围、验证脚本与 Git baseline。
- 只启动一个受限前台 Worker。
- 运行已授权的验证命令。
- 把实际 Git diff 交给独立只读 Reviewer。
- 对 acceptance 与 evidence 做确定性对账，并持久化 terminal receipt。

成功标准：在没有当前人工授权时不产生项目写入；在授权范围内完成一次实现、验证和独立审查；任何不确定、越界或失败均停止并把真实现场交还人类。

## 2. 产品边界

### 2.1 In Scope

- 可信 Git 仓库。
- Work Gate 时 worktree 与 index 均 clean。
- 一个 foreground `primary-solo` Worker。
- existing approved write roots。
- `npm|pnpm|yarn|bun test` 或 `run <script>` 验证。
- TUI confirmation 与 headless exact-digest confirmation。
- session activation restore、status、cancel、off。
- Bundle、Envelope、actual delta、Review 与 receipt。

### 2.2 Out of Scope

- 默认接管、AUTO prompt router 或自动意图分类。
- YOLO、无人值守 goal execution、Future Goal generation。
- 自动 fix/re-review loop。
- generic `/pilot stage`、Research/Spec/Interface DAG 或 workflow marketplace。
- Worktree Solo、Worktree Team、parallel writers、Integrator。
- background/cross-session Worker runtime。
- non-Git execution、dirty-tree migration、自动 backup/restore。
- Pilot stage、commit、push、stash、reset、revert 或 rollback。
- 吸收、替换或删除 standalone `mode` 与 `docsflow`。

既有 Auxiliary `pilot_router` bridge 可作为未调用的历史技术资产保留，但 Pilot 产品运行时不得请求它，也不得因它自动激活。

## 3. 核心工作流

```text
ordinary prompt while inactive
  -> main Pi / standalone mode handles it directly

/pilot
  -> manual activation, no project write

next user goal
  -> Pilot intercepts exactly this goal
  -> create Canonical Bundle
  -> fresh read-only Planner
  -> requirements.md + handoff.md
  -> ready_for_work or needs_decision

/pilot work
  -> require trusted project
  -> require clean Git worktree/index
  -> preflight pinned Worker + Reviewer profiles
  -> resolve package.json script text
  -> build content-addressed Execution Envelope
  -> disclose complete plan + scripts + authority + digest
  -> no write

TUI Authorize or /pilot work --confirm <digest>
  -> recompute Envelope and require exact digest
  -> one constrained Worker
  -> reconcile actual Git delta with Worker report and write roots
  -> run declared verification
  -> require verification not to mutate the authorized delta
  -> capture exact Git diff
  -> one fresh read-only Reviewer
  -> exact acceptance-to-evidence audit
  -> passed receipt

any failure / fail / needs_decision / cancel / drift
  -> stop
  -> recapture final baseline and changed files
  -> non-passed receipt
  -> findings returned to human
```

## 4. Functional Requirements

### R1. Manual Activation Only

- Pilot startup state is inactive.
- Only bare `/pilot` establishes manual activation.
- Pilot does not register `/mode`.
- Pilot does not call Auxiliary routing.
- Legacy session entries with `modePolicy=auto` must not reactivate Pilot.
- While inactive, ordinary prompts pass through unchanged.

### R2. Parent Mutation Closure

While manual Pilot is active, or while an authorized execution still owns a delegated child after session-tree navigation, parent-session tools other than the fixed read-only set are blocked. Project mutation belongs only to the authorized Worker. This is defense in depth; active implementation goals are intercepted before the main model starts.

### R3. Canonical Bundle

Git Bundle root:

```text
<git-common-dir>/pilot/runs/<run-id>/
```

Required artifacts:

```text
manifest.json
requirements.md
handoff.md
execution.json
reviews/implementation-01.json
receipt.json
```

Writes are atomic. A Bundle-wide exclusive lock plus manifest revision prevents stale concurrent updates. Every artifact ref includes path, SHA-256 and byte count; terminal state and its receipt ref are committed under one lock. Bundle paths reject symlink components, use private directories, and do not pollute project Git status.

### R4. Planner Contract

Planner is fresh and read-only. It returns exactly:

```text
goal
scope[]
nonGoals[]
acceptance[]
writeRoots[]
verificationCommands[]
risks[]
needsDecision?
```

Ambiguous goals and credentials, security/permissions, schema/data migration, destructive operations, production/deployment, compliance/PII or payment work must return `needsDecision` rather than an executable handoff.

### R5. Informed Work Gate

The Gate must show, before confirmation:

- Goal.
- Approved scope.
- Non-goals.
- Acceptance criteria.
- Risks.
- Canonical cwd.
- `primary-solo` topology.
- Worker identity and absolute write roots.
- Every verification command, its fixed 15-minute deadline and resolved `package.json` script text.
- Git baseline digest.
- Exact Envelope digest.

TUI and headless use the same summary and the same Envelope builder.

### R6. Trusted Clean-Git Boundary

- `/pilot work` is blocked unless `ctx.isProjectTrusted()` is true.
- Worktree and index must be clean at Gate time and still match at launch time.
- Missing/invalid `package.json` or a missing declared script blocks the Gate.
- Authorized validation executes trusted project code; Pilot is not an OS sandbox.

### R7. Exact Authorization

The Envelope digest binds:

- Run ID and Bundle revision.
- Manual activation and EDIT intent.
- Requirements/handoff artifact refs.
- Canonical cwd.
- Git head, index tree, status and diff hashes.
- Pinned Worker/Reviewer definition hashes.
- Delegation policy digests.
- Allowed tools and write roots.
- Verification commands, the fixed per-command deadline, the complete root `package.json` hash, and every applicable pre/main/post lifecycle script.

Any change invalidates the old confirmation. The first headless `/pilot work` only prints the digest; only `--confirm <digest>` can launch Work.

### R8. Single Constrained Worker

- Exactly one foreground Worker launch per authorized attempt.
- Tools: `read`, `grep`, `find`, `ls`, `edit`, `write`.
- No `bash`, Git landing tools, delegation or undeclared capabilities.
- Runtime preflight policy must still exactly match the authorized profile, cwd, tools and write roots.
- Pilot owns task-bound one-shot policy grants and sends only the fixed `pi-subagents` public V1 foreground request. Because fixed V1 uses profile tools as the child registry allowlist, the Worker profile declares the six fixed tools; before the first model turn, the globally loaded Pilot extension must reduce the active set to the four read-only bootstrap tools, atomically consume the capability, and revalidate profile/cwd/task/tools/write roots before re-enabling `edit` and `write`. Invalid, missing or replayed capabilities remain fully blocked by the loaded guard.
- User, nearest-project, configured-package (`file:`, npm, Git shorthand/SCP/raw protocol URL), local/global npm and symlink profile shadows plus user/project profile overrides fail preflight.
- Worker may not modify the index.
- Actual changed files must be inside write roots and exactly match Worker reporting.

### R9. Verification Disclosure and Integrity

- Only the constrained package-manager command grammar is accepted.
- The complete root `package.json` hash and every applicable pre/main/post lifecycle script are shown to the user and included in the digest, then rechecked after Worker completion and immediately before every command.
- Every command has the Gate-disclosed 15-minute deadline and receives fresh stdout, stderr, exit code and duration evidence. Cancellation, deadline and spawn termination evidence is retained with `exitCode: null`.
- Non-zero exit blocks pass.
- Verification may not alter the post-Worker delta or index. If it does, the run fails and the changed final state is recorded.

### R10. Independent Diff Review

- Reviewer is fresh and read-only.
- Reviewer receives requirements, handoff, observed changed files, exact Git diff, Worker report and verification evidence.
- Review diff includes tracked modifications/deletions and untracked additions; evidence over 256 KiB stops for human handling.
- Reviewer cannot write, execute shell commands or delegate.

Reviewer returns:

```text
verdict: pass | fail | needs_decision
findings[]
validationGaps[]
scopeDrift[]
residualRisks[]
evidence[]
acceptanceEvidence[]
```

Each `acceptanceEvidence` item contains the exact approved criterion and non-empty evidence. A pass is accepted only when criteria form an exact one-to-one set and findings, validation gaps and scope drift are empty.

### R11. Human Return on Failure

- No automatic fix or retry.
- Reviewer `fail`/`needs_decision`, validation failure, acceptance mismatch, scope drift, policy drift or cancellation terminates the attempt.
- Reviewer findings are displayed directly to the human.
- Before a failure receipt is written, Pilot recaptures final baseline and changed files.
- Partial unstaged project changes are preserved and reported; Pilot never rolls them back automatically.

### R12. Lifecycle Commands

```text
/pilot
/pilot status
/pilot cancel
/pilot work
/pilot work --confirm <digest>
/pilot off
```

`cancel` aborts a running controller or marks a ready, unauthorized Bundle cancelled with a planning receipt. A delegated child keeps execution ownership until its correlated terminal response arrives. Validation cancellation or deadline expiry terminates the complete process group before returning. `off` is allowed only when idle and no workflow controller is active.

### R13. Package Coexistence

Normal offline install includes all three independent packages:

```text
extensions/mode
extensions/pilot
extensions/docsflow
```

Pilot has no `/mode` command, so command ownership is unambiguous. Installation itself does not activate Pilot. Existing mode config and docsflow data are unchanged.

## 5. Permission Model

| Actor | Read | Project write | Shell | Pass authority |
|------|------|---------------|-------|----------------|
| Main Pi while Pilot inactive | standalone mode decides | standalone mode decides | standalone mode decides | none |
| Main Pi while Pilot active | fixed read-only tools | blocked | blocked | none |
| Planner | yes | no | no | no |
| Worker | yes | approved roots only | no | no |
| Reviewer | yes | no | no | review verdict only |
| Pilot runtime | Bundle + Git observation | Bundle artifacts; validation subprocess | allowlisted package command only | deterministic final reconciliation |
| Human | all decisions | authorizes one Envelope | owns manual actions | final product decision |

## 6. State and Recovery

- Planner/Worker/Reviewer child sessions are execution details; Bundle is durable truth.
- `activeRequest.id + generation` identifies the current child request.
- Session/tree restore only restores explicit manual activation and a valid Bundle entry bound to the current canonical cwd and Git common directory.
- Session/tree invalidation uses a generation fence; an executing workflow remains the sole owner and keeps parent mutation closed even if the selected branch restores inactive, until any delegated child reaches its correlated terminal response, then recaptures the final delta and writes the terminal receipt.
- Fixed public V1 treats `started` as a terminal-response obligation. If that external contract is broken, Pilot fails closed: it retains execution ownership, exposes `terminal response pending` in status, and does not write a potentially stale terminal receipt.
- Legacy AUTO entries restore inactive.
- Terminal statuses: `passed`, `blocked`, `failed`, `cancelled`.
- A terminal Bundle remains inspectable through its files; starting a new goal creates a new run.

## 7. Acceptance Checklist

### Automated

- [x] Inactive startup passes ordinary input through and does not register `/mode`.
- [x] Explicit `/pilot` activates; legacy AUTO entry does not.
- [x] Active parent mutation tools are blocked.
- [x] Bundle path, atomic writes, hashes and revision checks pass.
- [x] Planner rejects path traversal, arbitrary commands and malformed contracts.
- [x] Untrusted project cannot open an executable Work Gate.
- [x] Gate discloses requirements, risks, package scripts and digest.
- [x] Missing/invalid package script blocks Gate.
- [x] No delegated Worker launch or consumable Worker capability occurs before exact authorization; Gate-only policy probes are discarded.
- [x] Baseline, profile, policy, scope, tool or script drift invalidates authorization.
- [x] Worker delta/index/scope reconciliation passes and scope drift blocks.
- [x] Verification failure or mutation cannot pass and final failure state is recaptured.
- [x] Reviewer receives actual Git diff.
- [x] Acceptance evidence mismatch cannot pass.
- [x] Failed review launches no retry and displays findings.
- [x] Ready Bundle cancel writes cancelled manifest and receipt without Worker launch.
- [x] Success and every terminal failure write a receipt.
- [x] Pilot typecheck and full test suite pass.
- [x] Offline pack/install smoke includes Pilot while preserving mode/docsflow.
- [x] Repository diff has no whitespace errors or forbidden secret artifacts.

### TUI Runtime

- [x] `/reload` loads Pilot without duplicate command warnings.
- [x] Startup shows no Pilot phase until `/pilot`.
- [x] `/pilot work` confirm dialog renders the complete plan legibly at normal and narrow terminal widths.
- [x] Cancel/Esc from the confirm dialog launches no Worker.
- [x] Authorize starts one visible subagent flow and ends with a concise result/receipt path.
- [x] `/pilot off` returns to ordinary mode behavior.

### Automated Evidence Map

| Requirement | Concrete implementation/artifact | Verification evidence |
|---|---|---|
| R1 | `lib/activation.ts`, `extensions/pilot.ts`; Pilot owns only `/pilot` and never invokes Auxiliary routing | `activation.test.ts`, `input-routing.test.ts` |
| R2 | Parent input/tool closure in `extensions/pilot.ts`, including cross-branch execution ownership | `input-routing.test.ts`; inactive-branch owner cases in `phase1-primary-solo.integration.test.ts` |
| R3 | `lib/bundle.ts`, `lib/bundle-session.ts`; canonical manifest, requirements, handoff, execution, review and receipt refs | `bundle.test.ts`, `bundle-session.test.ts`; symlink/CAS/tamper/terminal-transaction cases |
| R4 | `agents/pilot-planner.md`, `lib/planning.ts`; strict result schema and terminal `needsDecision` | `planning.test.ts`; needs-decision integration case |
| R5 | Shared `envelopeSummary()` and `buildExecutionEnvelope()` in `extensions/pilot.ts` / `lib/envelope.ts` | Gate disclosure test, including byte-identical TUI/headless summary and zero Worker launch |
| R6 | Trust check in `prepareEnvelope()`; clean baseline/script resolution in `lib/envelope.ts`; launch recheck in `lib/primary-solo.ts` | untrusted integration test; clean/dirty/package-script/baseline-drift tests |
| R7 | Content-addressed Envelope in `lib/envelope.ts`; exact confirmation and policy reconciliation in `extensions/pilot.ts` / `lib/primary-solo.ts` | `envelope.test.ts`, authorization/drift cases in `primary-solo.test.ts` |
| R8 | `lib/delegation.ts`, `lib/worker-policy.ts`, six-tool registry in `agents/pilot-worker.md`; pre-turn read-only reduction, one-shot capability and write-root guard | profile/source/symlink/override tests; invalid-capability full block; fixed `bd32df2` six-tool `@task.md` cross-process test; Worker index/scope tests |
| R9 | Restricted grammar/disclosure in `lib/planning.ts` / `lib/envelope.ts`; process-tree runner in `lib/review.ts` | lifecycle/hash tests; non-zero/mutation/cancel/deadline tests; termination evidence receipt test |
| R10 | Exact diff capture and fresh Reviewer flow in `lib/primary-solo.ts`; strict contract in `lib/review.ts` | tracked, untracked, newline, literal-pathspec, malformed review and acceptance-evidence tests |
| R11 | Non-passed reconciliation in `lib/primary-solo.ts`; atomic receipts in `lib/receipt.ts`; findings surfaced by `extensions/pilot.ts` | failed-review/no-retry integration; final-delta and terminal-receipt tests |
| R12 | Command lifecycle, generation fence, owner/HUD status in `extensions/pilot.ts`; correlated cancel in `lib/delegation.ts` | ready cancel, cross-tree owner, terminal-pending, process-group cancel and safe-off tests |
| R13 | `package.json`, `snapshot/agent/settings.json`, coexistence wiring and `scripts/test-install.sh` | `coexistence.test.ts`; temporary offline archive/install test with installed-payload Pilot suite |

Recorded automated commands:

```text
npm --prefix extensions/pilot run check  # typecheck + 91/91 tests, 13 suites
./scripts/test-install.sh                 # archive/install assertions + installed-payload 91/91 tests
npm pack ./extensions/pilot --dry-run --json  # 18 runtime files, all profiles/entry/libs present
git diff --check && bash -n scripts/test-install.sh scripts/pack.sh scripts/install.sh
```

Secret and forbidden-artifact scans returned no findings. Independent final read-only reviews reported no remaining Critical/Important blocker. Windows `taskkill` behavior is not claimed as executed evidence in this WSL run; the POSIX/WSL process-group path is covered.

Real TUI evidence used Pi 0.82.0 in a 120×40 and 80×40 isolated `tmux` PTY over `<TEMP_PROJECT>`:

- startup and `/reload` showed no Pilot phase or duplicate command warning;
- `/pilot` added `manual`, while `/pilot off` removed it and an ordinary prompt returned directly from the main session;
- the full Gate remained wrapped and non-overlapping at both widths;
- Esc returned `Pilot Work authorization cancelled`, left Git clean and produced no `execution.json`;
- authorized run `a4638b1a-f011-4a8d-b1ca-381ad6e22758` showed `work:primary-solo`, launched one Worker (`fab5d2bf`) and one Reviewer (`d82a624e`), changed only the two approved unstaged files, passed `npm test`, and wrote a passed receipt plus all six canonical artifacts.

## 8. Delivery Phases

### C1: Copilot Core

Manual activation, Bundle, informed exact Work Gate, trusted clean-Git primary-solo, actual-diff review, acceptance audit, terminal receipts and failure-to-human behavior.

### C2: Opt-in Release

Install Pilot beside mode/docsflow, update repository capability docs, run package checks and offline install smoke, then perform the manual TUI checklist.

### Deferred, Not Committed

Only real usage evidence may reopen dirty-tree support or worktree-solo. AUTO, automatic fix loops, team, background, Future Goal and Git landing require a new approved requirements document; they are not later phases of this plan.

## 9. Decision Record

| ID | Decision |
|----|----------|
| C001 | Pilot is manual human-in-the-loop Copilot, not an autonomy platform |
| C002 | Fresh/default state is inactive; `/pilot` is the only activation path |
| C003 | Standalone mode and docsflow remain independent |
| C004 | One clean-Git primary-solo Worker is the only topology |
| C005 | Exact Work Gate and content-addressed authority are mandatory |
| C006 | Package script text is disclosed and bound before execution |
| C007 | Fresh Reviewer receives actual diff and maps every acceptance item to evidence |
| C008 | Any failed review returns to human; Pilot never auto-fixes |
| C009 | Pilot never stages, commits, pushes or rolls back project changes |
| C010 | Worktree/team/background/AUTO are out of scope, not hidden follow-up commitments |

## 10. Rollback

- Remove `../vendor/terrific-pi/extensions/pilot` from packages and reload Pi.
- Standalone mode and docsflow require no restoration because Pilot never replaces them.
- Pilot-created project changes are unstaged; rollback is a separate explicit human Git decision.
- Bundle data under `<git-common-dir>/pilot/runs/` can remain for audit and does not affect project status.
