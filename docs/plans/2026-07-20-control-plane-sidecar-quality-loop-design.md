# Sidecar Copilot 工作流外壳设计

> 状态：**讨论稿（Draft / Round 2）**，未批准实施
>
> 创建：2026-07-20
>
> 最近讨论：2026-07-21
>
> 目的：沉淀 Sidecar 辅助驾驶系统的目标、外部证据、Pi 原生架构、候选实现和未决问题，供多轮讨论持续修订
>
> 关系：本文件重新定义 [`2026-07-18-docs-flow-subagents-plan.md`](./2026-07-18-docs-flow-subagents-plan.md) 中 Docsflow 与 Sidecar 的边界；在本设计获批前，不修改旧实现和用户配置

## 1. 文档约定

本文使用以下标签，避免把建议写成已批准事实：

| 标签 | 含义 |
|------|------|
| **已确认** | 用户已经明确表达，或已有代码/运行证据支持 |
| **建议** | 当前推荐方案，仍可修改 |
| **待确认** | 会影响实现边界，需要后续决策 |
| **暂缓** | 有价值，但不属于当前阶段 |
| **不做** | 已明确排除 |
| **已推翻** | 旧讨论中的结论已被新需求替代 |

## 2. Round 2 架构修正

### 2.1 已推翻的旧模型

旧模型把 Docsflow 和 Sidecar 视为两个平级入口：

```text
/docsflow -> Planner artifacts
/sidecar -> Worker
```

这会迫使用户先进入一套独立文档流程，再进入执行流程；也使 interview、research、spec、interface、handoff 各自形成孤立产品面。

**已推翻**：Docsflow 不应继续作为独立工作流插件存在。

### 2.2 新模型

**已确认**：Sidecar 是统一的 Copilot workflow shell。Docsflow 只保留为 Sidecar 内部可组合的 planning stages、agents、skills、templates 和 artifact validation。

```text
/new
  -> /sidecar plan <first prompt>
       -> Sidecar 启动隔离的 Planner child
       -> input router 拦截普通回答并转发，主模型不参与 planning turns
       -> Planner + Human：多轮澄清
       -> structured triage：判断需求等级、风险和需要的 stages
       -> tiny：完善需求 -> plan/handoff
       -> complex：research -> architecture/spec
       -> UI：按需 interface spec
       -> plan review -> engineering handoff
       -> ready_for_work（停止，不自动写代码）

  -> /sidecar work [bundle]
       -> validate approved Execution Envelope digest
       -> solo worker 或 bounded agent team
       -> implement -> verify -> independent review
       -> fix -> re-review，直到 pass / needs_decision / exhausted
       -> execution receipt

  -> commit/push intent
       -> Git checkpoint review
       -> 用户明确确认
       -> git_finalize
```

### 2.3 产品定位

**已确认**：这是辅助驾驶，不是完全自动驾驶。

系统自动处理：

- 仓库事实收集。
- 按需外部 research。
- 规划阶段选择。
- Architect/Critic 规划评审。
- Worker 执行后的验证、review、fix 和 re-review。
- 状态、证据和 artifact 追踪。

人类保留：

- 目标与产品取舍。
- `/sidecar plan` 规划启动权。
- `/sidecar work` 写入启动权。
- `needs_decision` 决策权。
- commit/push 批准权。

## 3. 核心设计原则

### 3.1 Workflow 不是 Agent

**已确认**：Planner、Ralph-like persistence 和 Team 都被建模为 Sidecar workflow；单个 child agent 不拥有整个流程。

- 主 Pi 会话只提供 UI、Control Plane 和 Human Gates。
- Sidecar runtime 拦截并路由 planning input，保存状态并执行 gate。
- 隔离的 Planner child 负责 interview 与 plan synthesis。
- Researcher、Architect、Critic、Interface Designer 是 Sidecar 按需调用的 specialists；Planner 不自行获得无限编排权。
- Worker 负责写入，但不拥有最终 pass 判定。
- Reviewer 独立、fresh、read-only。

### 3.2 组合与独立调用必须共用实现

**已确认**：任一环节都可以在普通会话中独立运行。

因此完整 workflow 和独立命令必须调用同一个 `runStage()`，不能出现：

```text
完整流程的一套 research 实现
/sidecar research 的另一套 research 实现
```

### 3.3 一个 Canonical Work Bundle

Requirements、Research、Spec、Interface、Handoff、Execution 和 Review 必须属于同一个 Work Bundle，由 manifest 建立可追踪关系。

所有 `canRun`、`canSkip`、`ready_for_work` 和 `pass` 判定都基于同一契约，不能由“发现了某个名字相似的 Markdown”推断完成。

### 3.4 人工 Gate，自动阶段

用户授权一个阶段后，系统自动运行到下一个人类 Gate。中间不要求用户为了“继续 review”而发送无信息量的第二条回复。

### 3.5 有界循环

“直到 pass”不等于无限循环。任何 persistence loop 都必须有：

- 最大迭代数。
- 时间/调用预算。
- 可解释状态。
- `needs_decision`。
- `exhausted`。
- 用户 `cancel`。

## 4. 典型用户路径

### 4.1 新插件开发

```text
/new

/sidecar plan 我想开发一个新的插件，目标是……

Sidecar + isolated Planner child:
  1. Planner 读取当前仓库和适用文档
  2. Planner 只向用户询问不可从代码获得的判断
  3. Sidecar 每轮只中继一个高价值问题和回答
  4. Planner 输出 structured triage / stage request
  5. Sidecar 按需运行 research / architect / interface / critic
  6. Planner 生成 Work Bundle 和 handoff
  7. 停在 ready_for_work；主模型未承载 planning transcript

用户继续讨论和修改方案

/sidecar work

Sidecar:
  1. 绑定当前 Execution Envelope digest
  2. 选择 solo 或 team topology
  3. 自动执行、验证、review、fix、re-review
  4. pass 后返回 Control Plane
```

### 4.2 细微需求

```text
/sidecar plan 修正 statusline 中的一个错误标签
  -> repo inspection
  -> 判定 tiny/low-risk
  -> 不启动 broad research
  -> 完善目标、非目标和验收
  -> 直接生成 plan + handoff
```

细微任务仍生成最小 handoff，但不强制 PRD、架构文档和 Interface Spec。

### 4.3 临时独立能力

```text
/sidecar interview <idea>
/sidecar research <question>
/sidecar spec <input>
/sidecar interface <spec-or-bundle>
/sidecar handoff <input>
/sidecar review <target>
```

独立 stage 可以创建新 Bundle，也可以显式读取已有 Bundle/文件；不能静默绑定一个不明确的“最新文件”。

## 5. OMX 源码调研

调研基线：`Yeachan-Heo/oh-my-codex` commit `435d4a9cc982ffaf83fabbfbb8711ae6c178ffca`（2026-07-19）。

### 5.1 值得抽取的核心

#### Leader workflow + specialist agents

OMX 的 Plan 在同一个 leader workflow 中选择 Interview、Direct、Consensus 和 Review；Consensus 使用顺序的 Planner -> Architect -> Critic，并限制 re-review 轮数：

- [`skills/plan/SKILL.md#L43-L90`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/plan/SKILL.md#L43-L90)
- [`skills/plan/SKILL.md#L212-L229`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/plan/SKILL.md#L212-L229)

可抽取：

- Leader workflow 拥有 interactive planning；在 Pi 中由 Sidecar runtime + isolated Planner child 承担，而不是污染主模型上下文。
- 专家角色顺序评审，不能自批。
- 高风险任务提升规划强度。
- 达到上限后返回人类，而不是伪造 consensus。

#### Deep interview 的问题策略

OMX Deep Interview 强调：每轮一个问题、先查代码事实、只问人类判断、按需 research、明确 Non-goals 和 Decision Boundaries：

- [`skills/deep-interview/SKILL.md#L29-L85`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/deep-interview/SKILL.md#L29-L85)
- [`skills/deep-interview/SKILL.md#L297-L311`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/deep-interview/SKILL.md#L297-L311)

可抽取：

- 一次只问一个最高价值问题。
- 不询问可从仓库发现的事实。
- 澄清目标、边界、成功标准和决策权限。
- readiness gate 满足后停止追问。

#### 可组合 Stage Contract

OMX Pipeline 把 stage 统一为 `name + run(ctx) + canSkip(ctx)`，并把前序 artifacts 传给后序：

- [`src/pipeline/types.ts#L16-L68`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/pipeline/types.ts#L16-L68)
- [`src/pipeline/orchestrator.ts#L35-L145`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/pipeline/orchestrator.ts#L35-L145)

可抽取：

- 一致 stage interface。
- 顺序 artifact handoff。
- 每阶段持久化状态。
- 条件跳过和 resume。
- 质量失败后有界回环。

#### Completion audit 不能只看模型承诺

OMX Ralph 的 completion audit 要求 passing verdict、需求 checklist 和 verification evidence：

- [`src/ralph/completion-audit.ts#L74-L107`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/ralph/completion-audit.ts#L74-L107)

可抽取：

- 完成判定必须映射目标到 artifact/evidence。
- 不能把“测试通过”单独当作整个目标完成。
- 不能由 Worker 自己宣告 pass。

#### Team 只在真正需要持久协调时使用

OMX 明确区分 bounded native subagents 与 tmux Team：

- [`skills/team/SKILL.md#L8-L16`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/team/SKILL.md#L8-L16)
- [`skills/team/SKILL.md#L63-L80`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/team/SKILL.md#L63-L80)

可抽取：

- Team 必须有 shared truth、ownership、handoff 和 verification。
- Leader 拥有总体目标；Worker 只回报 lane evidence。
- 小型并行直接使用 native subagents，不建持久队伍。

### 5.2 不应照搬的部分

#### 不移植 OMX 的 tmux Team runtime

OMX Team 需要 pane、mailbox、heartbeat、inbox、dispatch queue 和独立 CLI session：

- [`skills/team/SKILL.md#L150-L181`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/team/SKILL.md#L150-L181)

Pi 已安装 `pi-subagents`，具备 foreground/background、parallel、chain、worktree、resume 和 intercom。复制 tmux/mailbox 会形成第二套 runtime。

#### 不移植 prompt 字数分类器

OMX 自己注明 task-size gate 在其运行面主要是 advisory，可能因长上下文、prompt injection 或模型混乱失效；其分类又大量依赖字数和关键词：

- [`src/hooks/task-size-detector.ts#L1-L15`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/hooks/task-size-detector.ts#L1-L15)
- [`src/hooks/task-size-detector.ts#L142-L180`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/hooks/task-size-detector.ts#L142-L180)

短 prompt 也可能是迁移、安全或数据任务。Pi 版应使用 structured triage + deterministic risk upgrade，不能用字数决定是否深入规划。

#### 不移植 mode zoo 和 keyword router

Sidecar 只服务当前明确的 Copilot 流程，不复制 OMX 的大量模式、同义触发词和自动 keyword activation。

#### 不移植 completion promise

坚持循环由 runtime state 和 evidence gate 驱动，不依赖模型输出特定完成短语。

#### 不复制 OMX 当前 artifact 分裂

OMX 当前 planning complete 主要从 PRD + matching test spec 推导：

- [`src/planning/artifacts.ts#L98-L115`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/planning/artifacts.ts#L98-L115)

其 issue #827 也明确指出 `deep-interview -> ralplan -> execution` 之间仍缺统一 canonical bundle 和强 runtime binding：

- [Issue #827: Unify deep-interview -> ralplan artifact contract](https://github.com/Yeachan-Heo/oh-my-codex/issues/827)

Pi 版应从第一版就避免同类问题。

### 5.3 名称差异

OMX 当前 `omx sidecar` 是 Team 状态的只读 watch/dashboard，不是 workflow shell：

- [`src/sidecar/index.ts#L6-L15`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/sidecar/index.ts#L6-L15)

本文 `/sidecar` 的语义以用户需求为准：它是 Pi 中的 Copilot cockpit/workflow shell。

## 6. Pi 原生架构

### 6.1 单一 Sidecar Extension

**建议**建立一个 `sidecar` extension，单一职责是“人工控制的工作流外壳”。

```text
extensions/sidecar/
  extensions/sidecar.ts      # slash UX + Pi hooks
  lib/state.ts               # run/phase state
  lib/artifacts.ts           # Work Bundle contract
  lib/stages.ts              # stage registry + runStage()
  lib/triage.ts              # structured classification + risk upgrades
  lib/gates.ts               # ready/work/pass/needs_decision
  lib/routing.ts             # solo/team topology
  agents/                    # planner specialists / reviewer profiles
  skills/                    # interview, planning, execution contracts
  templates/                 # requirements/spec/interface/handoff
  tests/
```

这里的 `lib/stages.ts` 只是固定 stage registry，不是通用 DAG 平台。

### 6.2 B\*：隔离 Planner Child

**已确认**：`/sidecar plan` 启动独立 Planner child。主 Pi 会话保持为 UI/Control Plane，不切换为 Planner model role。

```text
Main Pi session
  = UI + Control Plane + Human Gates

Sidecar runtime
  = input router + workflow state + Work Bundle + stage orchestration

Planner child
  = isolated interview context + planning synthesis

Specialists
  = Sidecar 按 Planner 的 structured request 调用
```

交互路径：

1. `/sidecar plan` 由 extension command 处理，不启动主模型。
2. Planner 返回 `ask_user` 时，Sidecar 在主 UI 显示一个问题。
3. 只有 manifest 处于 `awaiting_user` 且存在唯一 `pendingRequestId` 时，Pi `input` event 才拦截用户普通回答；转发给对应 Planner run 后返回 `handled`，跳过主模型。
4. 无 pending request、run/generation 不匹配或输入是 extension command 时，不得吞掉普通输入；stale answer 必须拒绝并提示当前问题。
5. Planner 可以返回有限 action：`ask_user`、`request_research`、`request_architect`、`request_interface`、`revise_plan`、`ready_for_review`、`ready_for_work`、`needs_decision`。
6. Sidecar 而不是 Planner child 决定是否调用 specialist、推进 stage 或停在人类 Gate。

**持久性原则**：Planner session 是可丢弃的上下文缓存，Canonical Work Bundle 才是事实来源。

- 正常路径优先 resume 同一个 Planner，保持访谈连贯。
- 每轮确认的需求、答案、决策和 stage result 都先写入 Bundle，再继续。
- Planner session 丢失或 resume 不可用时，从 Bundle 启动 fresh Planner 恢复。
- 不允许只有 child transcript 知道、Bundle 中不存在的已批准决策。

**A 降级路径**：只有 Planner relay/resume 不可用时，Sidecar 才可提出由主模型临时承担 Planner。该降级会增加主上下文，必须先明确告知用户并获得同意，不能静默切换。

### 6.3 Pi hooks 的职责

Pi 0.80.10 已提供所需扩展事件。建议映射：

| Pi surface | Sidecar 职责 |
|------------|----------------|
| `registerCommand` | `/sidecar ...` 入口；command handler 跳过主模型 |
| `input` | Active Planner 时拦截普通回答、关联 run/request、转发后返回 `handled` |
| `before_agent_start` | 非 planning-relay turns 注入 active phase、Bundle、Control Plane 角色和 gate |
| `tool_call` | 阻止越权写入或错误阶段工具调用 |
| `tool_execution_end` | 记录父会话看到的 subagent 调用结果；不能假设能看到 child 内部每次工具调用 |
| `message_end` | 防止 active workflow 提前宣告完成 |
| `agent_end` / `agent_settled` | 安排安全的下一阶段或回到人类 gate |
| `session_start` / `session_shutdown` | 恢复/保存当前 run 绑定 |
| `setStatus` | 紧凑 HUD |

模型负责推理；extension 负责状态、权限和 stop gate。避免只靠 prompt 自律。

**强制边界**：父 Pi extension hooks 只覆盖父会话，不能作为 child runtime 内部工具调用的审计器。Child 写权限必须由以下机制共同约束：

- 固定、可校验的 agent profile 与 tool allowlist。
- 明确 cwd、writer scope 和（适用时）隔离 worktree。
- 执行前 baseline 与执行后实际 diff/hash 对账。
- 子代理返回 changed files / validation evidence，但不能只相信其自述。
- profile、cwd、writer scope 或 baseline 发生变化时，Work Gate 授权失效。

在完成 child permission/enforcement spike 前，Sidecar execution 仍是架构 Blocker，不能只靠父 hooks 宣称权限安全。

### 6.4 复用 pi-subagents

能力状态必须区分“包提供”与“Sidecar 已验证”：

| 能力 | 当前状态 |
|------|----------|
| foreground single-agent delegation | 已验证，可供 Planner 与 planning specialists 使用 |
| Pi `input` interception + `handled` | 官方 extension API 已确认；Sidecar session-log 行为待 spike |
| foreground child detach 等待 supervisor reply | 包提供；Sidecar relay integration 待 spike |
| Planner resume / fresh recovery | 包提供 resume；Bundle rehydration contract 待实现 |
| fresh read-only specialists | profile 可实现；Sidecar 专用权限仍需验证 |
| Worker resume | 包提供，Sidecar integration 未验证，Phase 3 前置 spike |
| parallel/worktree | 包提供，Sidecar integration 未验证 |
| detached/background | 当前受 `typebox/compile` 故障阻塞；不阻塞 foreground Planner relay |
| intercom/needs_decision | 包提供，Sidecar ownership/UX 未验证 |

目标用法：

- Planner：foreground isolated child；正常 resume，失败时由 Work Bundle fresh recovery。
- Research/Architect/Critic/Interface/Reviewer：fresh、read-only agent，由 Sidecar 调用。
- Solo Worker：一个可 resume 的 writer session；若 spike 不通过，不进入自动 fix loop 实现。
- Team Candidate：`parallel` + 明确 reads/outputs；满足条件时才使用 worktree。
- 独立评审：fresh reviewer + dynamic skills。
- Sidecar 不实现自己的模型进程、队列、RPC 或 tmux runtime。

## 7. Stage Registry

### 7.1 Stage Contract

建议最小接口：

```ts
interface SidecarStage<I, O> {
  id: StageId;
  canRun(bundle: WorkBundle, input?: I): StageDecision;
  run(ctx: StageContext<I>): Promise<StageResult<O>>;
}

interface StageResult<T> {
  status: "completed" | "needs_input" | "blocked" | "failed" | "skipped";
  artifacts: ArtifactRef[];
  output?: T;
  evidence: EvidenceRef[];
  recommendedNext?: StageId;
  reason?: string;
}
```

不加入任意表达式、动态插件市场、图编辑器和通用 workflow DSL。

### 7.2 Public Stages 与 Internal Actions

| Public Stage | 输入 | 输出 | 可独立运行 |
|--------------|------|------|------------|
| `intake` | 首个 prompt | Goal + initial facts | 是 |
| `triage` | Requirements + repo facts | Tier/flags/stage plan | 是，可 provisional/final 两次运行 |
| `interview` | Goal/Requirements | Requirements | 是 |
| `research` | Research question/Requirements | Evidence brief | 是 |
| `spec` | Requirements + evidence | Architecture/Product Spec | 是 |
| `interface` | UI-relevant spec | Interface Spec | 是 |
| `plan-review` | Current plan/spec | Architect + Critic verdict | 是 |
| `handoff` | Approved planning artifacts | Engineering Handoff | 是 |
| `work` | Ready handoff | Execution evidence | 是 |
| `review` | Goal + artifacts + changes | Pass/fail/decision verdict | 是 |
| `commit-checkpoint` | Original goal + staged diff | Landing-vs-intent report | 是，Git only |

`fix`、`verify`、`integrate` 和 `route` 是 workflow internal actions，不作为独立 public stage 承诺。所有 Public Stage 都必须能通过 generic `/sidecar stage <id>` 调用；常用 stage 另提供短命令。

### 7.3 Full Workflows

完整流程只是 stage composition：

```text
plan:
  intake -> provisional triage -> interview?
  -> final triage -> research? -> spec? -> interface?
  -> plan-review? -> handoff

work:
  validate execution envelope -> route solo/team
  -> work -> verify -> review -> internal fix/review loop

commit:
  commit-checkpoint -> human confirm -> git_finalize
```

## 8. Planning Workflow

### 8.1 Intake

`/sidecar plan <prompt>` 后：

1. 记录原始 prompt，不覆盖。
2. 读取适用 `AGENTS.md`、README、相关 docs 和代码入口。
3. 区分：
   - 可从代码确认的事实。
   - 需要用户确认的推断。
   - 只能由用户做出的决策。
4. 建立 Requirements draft。

### 8.2 Interview

每轮只问一个最高价值问题。优先顺序：

1. 目标和期望结果。
2. Scope / Non-goals。
3. 决策边界。
4. 约束和兼容性。
5. 可验证成功标准。
6. 风险接受和取舍。

如果现有 prompt 已足够，不为满足形式强行提问。

### 8.3 Structured Triage

Triage 运行两次：

1. **Provisional triage**：intake 和 repo preflight 后，决定是否需要 interview、先调查哪些事实。
2. **Final triage**：interview 结束后，冻结 planning depth、risk flags 和推荐 execution topology。

建议输出：

```json
{
  "tier": "tiny | standard | complex | high_risk",
  "ambiguity": "low | medium | high",
  "needsInterview": false,
  "needsResearch": false,
  "needsArchitecture": false,
  "needsInterface": false,
  "needsPlanReview": false,
  "executionRecommendation": "solo | team_candidate",
  "riskFlags": [],
  "reasons": []
}
```

确定性规则只能升级，不能降级：

- auth/security/permissions/secrets。
- schema/data migration。
- destructive operations。
- public API/protocol changes。
- production/deployment/infra。
- compliance/PII/payment。
- 多模块共享契约。

### 8.4 Planning Depth

| Tier | 默认路径 |
|------|----------|
| `tiny` | repo facts -> requirements -> handoff |
| `standard` | requirements -> plan/spec -> handoff |
| `complex` | requirements -> targeted research? -> architecture/spec -> plan review -> handoff |
| `high_risk` | deep interview -> evidence -> alternatives/ADR -> Architect -> Critic -> handoff + explicit risks |

UI flag 与 tier 正交：只要真正涉及用户界面，就按需运行 `interface`。

### 8.5 Planning Review

建议简化 OMX RALPLAN：

```text
Planner draft
  -> Architect：可行性、边界、替代方案、架构风险
  -> Critic：完整性、验收、验证、scope drift
  -> Planner revise
  -> 最多 2 轮
```

不是所有任务都运行 consensus。`tiny` 默认不运行；`complex/high_risk` 才运行。

## 9. Canonical Work Bundle

### 9.1 建议目录

路径尚未冻结。建议先使用项目本地隐藏状态目录：

```text
.pi/sidecar/runs/<run-id>/
  manifest.json
  requirements.md
  decisions.md            # confirmed Q&A/decisions only; no hidden reasoning
  research.md             # optional
  spec.md                 # optional for tiny tasks
  interface.md            # optional
  handoff.md              # work 前必需
  execution.json          # work 后生成
  reviews/
    plan-01.json
    implementation-01.json
```

需要成为正式项目文档的内容，再由对应 stage 写入项目既有 `docs/` 位置。避免所有临时 interview 都污染公开文档。

### 9.2 Manifest

建议最小结构：

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "cwd": "...",
  "originalPrompt": "...",
  "status": "planning | ready_for_work | working | reviewing | passed | blocked | exhausted | cancelled",
  "phase": "interview | research | spec | interface | handoff | work | review | fix",
  "triage": {},
  "selectedStages": [],
  "planner": {
    "state": "idle | running | awaiting_user | recovering | completed | failed",
    "runId": null,
    "sessionId": null,
    "generation": 0,
    "pendingRequestId": null
  },
  "artifacts": {},
  "handoffFingerprint": "...",
  "executionRecommendation": "solo | team_candidate",
  "executionTopology": null,
  "executionEnvelope": null,
  "authorizationDigest": null,
  "iterations": {
    "planReview": 0,
    "workReview": 0
  },
  "needsDecision": null
}
```

### 9.3 Ready-for-work Gate

`ready_for_work` 至少要求：

- Goal 明确。
- Approved scope 与 non-goals 明确。
- 验收条件可验证。
- 风险和待决事项已列出。
- Handoff 存在并通过 schema validation。
- Handoff fingerprint 已写入 manifest。
- `needsDecision` 为空。

## 10. Execution Workflow

### 10.1 第二个人工 Gate

`/sidecar work` 不能只批准一个 Handoff 文件；它批准的是完整 **Execution Envelope**：

```text
Execution Envelope =
  Work Bundle manifest version
  + requirements/spec/interface/handoff artifact hashes
  + cwd realpath
  + repository/file baseline fingerprint
  + selected solo/team topology
  + writer agent profile/version
  + writer scope
  + validation obligations
```

Sidecar 对该闭包生成 `authorizationDigest`，用户执行 `/sidecar work` 表示批准该 digest 并授权写入。

上述任一输入发生变化，旧授权立即失效，必须重新展示差异并再次执行 `/sidecar work`。这用于避免 plan 展示后到实际执行之间的 TOCTOU。

### 10.2 Solo Worker

默认选择 solo，条件包括：

- 一个主要写入面。
- 任务高度耦合。
- 非 Git 项目。
- dirty worktree。
- 无法证明 lane ownership 不重叠。
- Team 收益不足以覆盖协调成本。

流程：

```text
worker iteration
  -> targeted verification
  -> independent review
  -> pass
     or findings -> resume same worker -> re-verify
     or needs_decision -> human
```

### 10.3 Team Candidate

只有同时满足以下条件才允许多 writer team：

- 至少两个可独立推进的 lane。
- 文件/模块 ownership 可明确且不重叠。
- Git worktree clean。
- worktree 能正常创建。
- Integration owner 和最终验证路径已定义。

否则退化为：

```text
one writer + parallel read-only specialists
```

### 10.4 Pi-native Team

不移植 OMX tmux Team。建议：

```text
Sidecar Control Plane
  -> parallel workers in isolated worktrees
  -> collect evidence
  -> one integrator/worker applies or merges approved changes
  -> global review
```

首版只交付 solo。Team contract 可以先进入 Handoff，但 runtime 放到后续 Phase，避免在基础 gate 未稳定前引入最大风险面。

## 11. Ralph-like Persistence

### 11.1 正确所有者

用户体验上可以称为“Worker 自我循环”，但架构上循环必须属于 Sidecar runtime：

```text
Sidecar owns stop condition
Worker owns implementation
Reviewer owns quality verdict
Human owns decisions
```

Worker 不能同时拥有写入权和 pass 判定权。

### 11.2 Loop

```text
Iteration 1:
  Worker -> verify -> Reviewer

Reviewer:
  pass            -> completion audit
  fail            -> findings -> same Worker resume
  needs_decision  -> human gate

Iteration N:
  Fix -> verify -> Reviewer
```

### 11.3 Completion Audit

Pass 需要：

- 每项目标/验收条件映射到 artifact 或 evidence。
- 实际 changed files 与 Worker 声明一致。
- 要求的验证命令有新鲜结果。
- Reviewer verdict 为 pass。
- 无 unresolved required finding。
- 无未批准 scope drift。

### 11.4 Stop Conditions

建议默认：

- Implementation review 最多 3 轮。
- Transport failure 不自动无限重试。
- 同一根因最多 3 次修复尝试。
- `needs_decision` 立即暂停。
- 达到预算进入 `exhausted`，不伪装 pass。
- 用户 `/sidecar cancel` 发出取消请求并立即停止新调度；正在运行的 child 必须等待 cancel/terminal acknowledgement。
- 取消后的已落盘变更默认保留并报告，不自动回滚；迟到 response 以 run generation/request id 去重，不能重新启动后续阶段。

## 12. 独立能力入口

### 12.1 建议命令面

```text
/sidecar                         # open on-demand manager
/sidecar plan <goal>             # adaptive planning workflow
/sidecar work [bundle]           # inspect Execution Envelope; TUI Authorize 才执行
/sidecar work --confirm <digest> # headless/RPC exact-digest confirmation
/sidecar stage <id> [input]      # 任一 Public Stage 的统一入口
/sidecar interview [input]       # convenience alias
/sidecar research <question>     # convenience alias
/sidecar spec [input]            # convenience alias
/sidecar interface [input]       # convenience alias
/sidecar handoff [input]         # convenience alias
/sidecar review [target]         # convenience alias
/sidecar status                  # current run and gate
/sidecar pause                   # pause input routing; keep Planner state
/sidecar resume                  # resume routing and redisplay pending question
/sidecar cancel                  # request cancel + stop new scheduling
```

`intake`、`triage`、`plan-review` 和 `commit-checkpoint` 等较少使用的 Public Stage 仍可通过 `/sidecar stage <id>` 独立调用。不为每个 stage 新建 top-level plugin 或 slash namespace。

### 12.2 输入解析

每个命令必须明示以下之一：

- 当前 active Bundle。
- 指定 Bundle ID/path。
- 显式原始输入。

若同时存在多个候选，要求用户选择；不能猜“最新的应该就是这个”。

### 12.3 输出行为

独立 stage：

- 可以只返回 artifact，不自动运行下游。
- 可以更新所属 Bundle 的 manifest。
- 不得隐式触发 `/sidecar work`。
- Review 可以审查任意显式 target，不要求先运行 Plan。

## 13. Reviewer 设计

### 13.1 一个 Reviewer，动态 skills

| Target | Skills |
|--------|--------|
| Code/config/tests | `code-review` |
| Web UI | `code-review` + `web-design-guidelines` + Playwright（按需） |
| Markdown/spec/handoff | contract + goal consistency |
| DOCX/PDF/PPTX/XLSX | 对应 document skill |
| Mixed artifacts | 按主要风险选择最少必要组合 |

### 13.2 权限

Reviewer 必须 fresh、read-only。当前 installed builtin reviewer profile 暴露 `edit/write`，不能直接作为强质量 Gate 使用；需要 Sidecar 专用 reviewer profile 或收紧工具配置。

### 13.3 Verdict

```json
{
  "verdict": "pass | fail | needs_decision",
  "findings": [],
  "validationGaps": [],
  "scopeDrift": [],
  "residualRisks": [],
  "evidence": []
}
```

解析失败视为 Gate failure，不视为 pass。

## 14. 人类 Gate

只保留以下人类决策点；commit 与 push 分别绑定各自授权载荷：

| Gate | 触发 | 人类动作 |
|------|------|----------|
| Planning start | `/sidecar plan` | 授权进入规划对话 |
| Work start | `/sidecar work` -> TUI `Authorize` | 审阅并批准 Execution Envelope digest 与写入；command 本身不直接执行 |
| Decision | `needs_decision` | 选择范围、风险或产品取舍 |
| Commit landing | commit intent | 批准 staged fingerprint 与 commit |
| Push landing | push intent | 批准 remote、branch/upstream 与 commit range |

普通 research、Architect/Critic review、implementation review/fix 不要求无意义确认。

## 15. Git 与非 Git

### 15.1 Git

- Sidecar 记录 baseline 和 changed files。
- Team multi-writer 只在 clean Git + worktree 下允许。
- Commit checkpoint 对 staged diff 重新做 goal reconciliation。
- staged fingerprint 改变后旧确认失效。

### 15.2 非 Git

- 只允许一个 writer。
- `/sidecar work` 前对声明 writer scope 内的既有文件建立有界 backup manifest，并记录执行中新建文件。
- scope 过大、不可枚举或备份失败时，阻止执行并请求用户缩小范围或明确接受“无自动恢复点”。
- 用父层 mutation record、文件前后 hash/mtime、实际目录对账和 Worker 声明交叉验证。
- `cancel`、`failed`、`exhausted` 默认保留部分修改并报告；恢复必须由用户明确选择，避免覆盖并发改动。
- Completion review 仍可运行。
- Git checkpoint 不适用。

## 16. 已确认交互设计

### 16.1 原则

**已确认**采用轻量聊天式：

- 平时沿用 Pi 的普通聊天编辑器，不建立第二套全屏应用。
- Footer 常驻一个紧凑 Sidecar phase；详细状态只在用户打开 `/sidecar` 时显示。
- Planner 每轮只展示一个问题；普通回答由 Sidecar 路由，不触发主模型。
- 只有 Manager、危险 Gate 和 bounded choice 使用 TUI overlay。
- 不设置常驻右侧面板，不复制 `pi-subagents` 已有进度面板。
- 不把 child 的完整日志、thinking 或 routine progress 刷入主聊天区。

### 16.2 Planning 问答

`/sidecar plan <goal>` 由 command handler 启动 Planner。Planner 返回 `ask_user` 后，Sidecar 使用 editor 上方 widget 显示：

```text
Sidecar · Interview 2

这个插件应该只影响新请求，还是允许切换正在运行的会话？

回答将发送给 Planner
```

交互规则：

- 自由文本继续使用 Pi 原生 editor，保持中文 IME、历史和已有键位行为。
- 只有 `awaiting_user + pendingRequestId` 精确匹配时，`input` hook 才返回 `handled`。
- 有限选项使用 `SelectList`；自由文本不强制进入 modal。
- 提交后 question widget 关闭，Footer 切到 `plan:thinking` 或实际 stage。
- `/sidecar pause` 暂停回答路由，让普通输入重新进入主会话；Planner state 保留。
- `/sidecar resume` 恢复路由并重新显示同一个 pending question。
- `/sidecar cancel` 请求取消当前 workflow，不把它解释为问题答案。

Research、Architect、Critic 只产生阶段摘要，例如：

```text
Sidecar · Research complete
3 sources accepted · 1 assumption unresolved
Next: architecture
```

### 16.3 按需 Manager

裸 `/sidecar` 打开 overlay manager；`Esc` 关闭后恢复普通编辑器。

无 active Bundle 时只提供：

- Start plan。
- Resume bundle。
- Run independent stage。

有 active Bundle 时显示：

- run ID、phase、tier、gate 和当前 topology。
- pending question / needs_decision。
- artifact paths 与最近验证状态。
- Planner/Worker/Reviewer lifecycle 摘要。
- 当前合法操作：View、Pause/Resume、Cancel；只有达到相应 Gate 才显示 Work/Commit/Push。

Manager 使用 Pi `SelectList` 和标准 theme，不做自定义 dashboard framework；窄终端下使用全宽 modal，不显示右侧 overlay。

### 16.4 Ready 与 Work Gate

Planning 完成后在主聊天区留下持久摘要，但停止调度：

```text
Sidecar · Ready for work

Goal       模型路由插件
Tier       complex
Topology   solo
Artifacts  requirements · research · spec · handoff
Risks      1 accepted · 0 unresolved
Bundle     .pi/sidecar/runs/<run-id>
```

用户显式输入 `/sidecar work` 后，Sidecar 计算并展示 Execution Envelope：

```text
Authorize Sidecar Work

cwd          /home/lcc/project
topology     solo
writer       worker
write scope  extensions/model-router/**
validation   npm test
baseline     38d71a...
digest       a91c42...

> Authorize
  Cancel
```

**已确认**：`/sidecar work` 只打开 Gate；在 TUI 中选择 `Authorize` 才是实际写入授权。Envelope 任一字段变化都会关闭旧弹窗并使旧 digest 失效。

Headless/RPC 环境不伪造确认：第一次 `/sidecar work` 只输出 Envelope 和 digest；必须使用 `/sidecar work --confirm <digest>`，验证未变化后才执行。

### 16.5 执行反馈与完成

执行期间复用 `pi-subagents` 进度，只额外显示 Sidecar gate/iteration：

```text
work:solo · implement
work:review 1/3
work:fix 1/3
```

- `fail` findings 自动送回 Worker，不要求用户回复“继续”。
- `needs_decision` 使用 bounded selector 或单问题 widget 打断用户。
- `cancel`、`failed`、`exhausted` 必须显示已落盘变更和恢复信息。
- `pass` 后输出 changed files、验证结果、review 轮次和 execution receipt path。

### 16.6 Mode

Sidecar 自己定义 workflow role，不把所有语义塞进现有 `/mode`。

**仍待确认**：当当前 `/mode` 是 plan/ask 时，Sidecar Work Gate 是否可以授予仅限 Execution Envelope 的 child 写权限。未确认前，不能静默覆盖 `/mode`；Manager/Gate 必须显示冲突并阻止 `Authorize`。

### 16.7 HUD

Footer 只显示紧凑状态：

```text
plan:interview
plan:thinking
plan:research
plan:review 1/2
ready
work:solo 1/3
work:review 1/3
blocked
passed
```

使用 `setStatus`；只有 pending question 或需要短期展示的阶段信息才使用 `setWidget`。不设置常驻右侧面板。

### 16.8 Context

- 主 Pi 会话只保留 Control Plane 状态、Human Gates 和用户可见结果。
- Active Planner 的普通回答由 `input` hook 返回 `handled`，不启动主模型；其 session transcript 落盘行为列入 Phase 0 spike。
- 完整 Planner/Worker/Reviewer transcript 不回注主模型上下文。
- 主模型上下文只在需要 Control Plane 推理时接收 artifact path、摘要、findings、证据和风险。
- Planner session 是缓存；所有已批准需求与决策必须进入 Bundle，子代理不能依赖隐藏对话作为唯一事实。

## 17. Docsflow 迁移

### 17.1 保留

从当前 `extensions/docsflow` 复用：

- Artifact Contract validation。
- safe relative artifact paths。
- draft 避免覆盖语义。
- `research-analyst`。
- `product-architect`。
- `interface-designer`。
- `delivery-reviewer` 的 handoff 能力。
- `project-docs` skill 和模板。
- model/thinking/timeout override 逻辑。

### 17.2 吸收或重构

- 固定 `research -> product -> interface -> delivery` 改为 stage registry。
- Docsflow state 合并进 Work Bundle manifest。
- `/docsflow` HUD 合并为 Sidecar phase。
- Engineering Handoff 强化为 work gate contract。

### 17.3 最终移除独立产品面

**建议迁移路径**：

1. Sidecar 先复用现有 docsflow modules。
2. `/docsflow` 暂时保留 deprecated alias，指向 `/sidecar plan` 或独立 stage manager。
3. 完成配置迁移与兼容测试。
4. 从 `settings.json` packages 中移除 standalone docsflow。
5. 最后删除独立 extension 入口，不删除仍被 Sidecar 使用的 agents/skills/templates。

不能直接删除现有插件，因为已有配置、README、状态和用户习惯需要迁移。

## 18. 分阶段落地建议

### Phase 0：讨论冻结与 Runtime Spikes

- B\* 已冻结：isolated Planner child + Sidecar input relay + Work Bundle truth。
- 冻结命令面、Public Stage 范围与 generic stage 入口。
- 冻结 Work Bundle 路径、manifest v1 和 Execution Envelope。
- 冻结 Human Gates。
- 验证 `input -> handled` 后主模型未启动及 session transcript 行为。
- 验证 foreground Planner detach/reply、resume、fresh recovery 和 stale answer correlation。
- 验证 child agent profile/tool allowlist/cwd 是否可被 runtime 强制。
- 验证父层能获得哪些 child execution evidence，并明确不可观察边界。
- 验证 Worker resume、cancel acknowledgement 和 stale response 去重。

任一执行 spike 不通过，都不阻塞 Planning Shell，但阻塞 `/sidecar work`。

### Phase 1：Planning Shell

- 新建 Sidecar extension skeleton。
- 仅实现 `/sidecar plan|status|cancel` 和 planning Public Stages。
- 实现 Planner child launcher、active-input router 和 structured actions。
- 实现 question widget、compact Footer、按需 Manager、pause/resume 和 headless fallback。
- 实现 Planner resume + Work Bundle fresh recovery。
- 吸收 provisional triage -> interview? -> final triage -> handoff。
- 复用 docsflow read-only agents，由 Sidecar 调用而非 Planner 自主 fanout。
- 支持 tiny 与 complex 两条 planning path。
- 输出 canonical Work Bundle。
- A 仅作为显式授权的降级路径。
- 不在 Phase 1 实现写入执行状态机。

### Phase 2：Independent Stages

- `/sidecar interview|research|spec|interface|handoff|review`。
- 所有入口复用同一 `runStage()`。
- 完成 stage contract 和 artifact tests。

### Phase 3：Solo Work + Persistence

前置：Phase 0 的 child permission、resume、cancel spikes 全部通过。

- `/sidecar work` 展示 Execution Envelope；TUI `Authorize` 或 headless exact-digest confirmation 才批准。
- 一个受 profile/cwd/writer-scope 约束的 Worker。
- independent read-only Reviewer。
- resume Worker -> fix -> re-review。
- Completion audit。
- 非 Git backup manifest 与恢复说明。
- Git 与非 Git样本验证。

### Phase 4：Git Checkpoint

- Commit Gate：绑定 staged fingerprint、目标、验证证据和 commit intent。
- Push Gate：额外绑定 remote、branch/upstream 和待推送 commit range。
- commit 或 push 载荷变化后旧确认失效。
- 明确禁止 force push；仍由 `git_finalize` 只执行普通 commit/normal push。
- landing-vs-intent review 与 explicit confirm。

### Phase 5：Team Candidate

- 只支持 clean Git/worktree。
- 明确 lane ownership。
- parallel workers + single integrator。
- global review。
- 非 Git/dirty 自动退化为 solo。

### Phase 6：Background/Persistent Runtime

- 修复 `pi-subagents` async `typebox/compile` 依赖。
- 后台 wake/resume/cancel。
- 跨 session 绑定和恢复。

该阶段不阻塞 foreground Copilot 价值。

## 19. 验收场景

### 19.1 Tiny Plugin Fix

- 不触发 broad research/interface。
- 最多一次必要澄清。
- 生成最小 handoff。
- Solo Worker + review 通过。

### 19.2 Complex New Plugin

- 自动识别架构与生态调研需要。
- Research 有来源。
- Spec 含边界、替代方案和 ADR。
- 无 UI 时不生成 Interface Spec。
- Handoff 可由 fresh Worker 无猜测执行。

### 19.3 Frontend Plugin

- Triage 识别 `needsInterface`。
- 生成 Interface Spec。
- Execution review 按需运行 Playwright。

### 19.4 Independent Research

- `/sidecar research` 可在普通会话单独运行。
- 不自动生成 Spec 或启动 Worker。

### 19.5 Non-Git Artifact

- Solo writer。
- 文件变更证据完整。
- Independent review 可 pass。
- 不出现 Git-only 假设。

### 19.6 Team Candidate

- dirty worktree 时自动退化 solo。
- ownership overlap 时自动退化 solo。
- clean + independent lanes 才启动 worktrees。
- Integration 后运行全局 review。

## 20. 风险与假设

| 风险 | 状态 | 处理 |
|------|------|------|
| Planner 角色边界 | 已确认 B\* | 主会话只做 UI/Control Plane；isolated Planner child 负责 planning |
| Planner input relay/resume | Phase 0 Blocker | `input handled` + foreground detach/reply + Bundle recovery spike |
| Child 内部工具无法由父 hooks 完整观察 | 架构 Blocker | profile/tool/cwd 强制 + baseline reconciliation spike |
| Work Gate 的 TOCTOU | 已识别 | 绑定完整 Execution Envelope digest |
| `pi-subagents resume` 在 extension shell 中的集成方式 | 架构 Blocker | 先做最小 solo resume/cancel spike |
| Sidecar 与 `/mode` 写权限冲突 | 待确认 | work command 明示授权范围 |
| Reviewer 当前 tools 过宽 | 已验证 | 新建/收紧 read-only profile |
| 非 Git 失败后的部分修改 | 高 | 有界 backup manifest + 明确恢复选择 |
| Team 多 writer 集成风险 | 高 | 延后到 Phase 5，默认 solo |
| Async runner 依赖故障 | 已验证 | foreground planning/solo spike 绕开；background 延后 |
| Artifact 路径污染项目 | 待确认 | runtime bundle 隐藏，正式 docs 按需发布 |
| TUI/headless Gate 语义分叉 | 已识别 | TUI Authorize 与 headless exact digest 共享同一验证函数 |
| 输入路由误吞普通消息 | 已识别 | 只接受 awaiting_user + pendingRequestId；pause/resume escape hatch |
| Triage 误判 | 固有风险 | provisional/final 两次 triage + risk only-upgrade + human work gate |
| 无限 persistence loop | 已控制 | iterations/budget/timeout/decision/exhausted |
| Docsflow 用户迁移 | 已知 | deprecated alias + 配置迁移，禁止直接删除 |

## 21. 已确认决策记录

| ID | 决策 |
|----|------|
| D001 | 人工主会话是 UI/Control Plane，不是 Planner 或常规 executor |
| D002 | Sidecar 是统一 Copilot workflow shell |
| D003 | Docsflow 不再独立作为最终插件产品面 |
| D004 | Docsflow 能力转为 Sidecar 内部可复用 stages/agents/skills/templates |
| D005 | `/sidecar plan` 自动执行适配任务等级的 planning workflow |
| D006 | 细微需求直接完善 requirements 并输出 plan/handoff |
| D007 | 复杂需求按需 research、architecture/spec 和 Interface Spec |
| D008 | 第二次显式 `/sidecar work` 才启动写入执行 |
| D009 | 执行按规模可为 Solo Worker 或 Agent Team |
| D010 | Worker 路径需要 Ralph-like persistence，直到 pass 或明确终止态 |
| D011 | 每个 stage 都可在普通会话中独立调用 |
| D012 | Reviewer 必须 fresh、独立且 read-only |
| D013 | Git 与非 Git 都支持 completion review |
| D014 | Commit/push 保留独立人类确认 checkpoint |
| D015 | 复用 pi-subagents，不移植 OMX tmux/team runtime |
| D016 | 这是辅助驾驶，不是全自动驾驶 |
| D017 | 采用 B\*：主 Pi 会话只做 UI/Control Plane，Sidecar 路由 isolated Planner child |
| D018 | Planner session 是可丢弃缓存，Canonical Work Bundle 是 planning 事实源 |
| D019 | A 仅是 relay/resume 不可用时、经用户明确同意的降级路径 |
| D020 | 采用轻量聊天式；Footer 常驻状态，裸 `/sidecar` 按需打开 Manager，不设常驻右侧面板 |
| D021 | `/sidecar work` 只打开 Execution Envelope Gate；TUI `Authorize` 或 headless exact digest 才实际授权 |
| D022 | Planner 普通回答使用原生 editor；pause/resume 是输入路由逃生口 |

## 22. 待讨论问题

按架构依赖排序：

1. **Work Bundle 默认放 `.pi/sidecar/runs/` 是否合适？哪些 artifact 应自动发布到项目 `docs/`？**
2. `tiny | standard | complex | high_risk` 四级是否足够？
3. Planning review 默认 2 轮、Implementation review 默认 3 轮是否合适？
4. 当前 `/mode` 为 plan/ask 时，是否允许 Work Gate 授予仅限 Execution Envelope 的 child 写权限？
5. Child permission/resume spikes 若不通过，是否接受先只交付 Planning Shell？
6. Solo fix loop 优先 resume 同一 Worker，失败时是否允许 fresh Fix Worker？
7. Team Candidate 的最低门槛是否要求 clean Git + worktree，还是允许 shared-tree one-writer team？
8. Execution receipt 是否必须跨 Pi session 持久化？
9. `/docsflow` deprecated alias 保留多久？
10. Git checkpoint 的原始目标以 Work Bundle 哪些字段为准？

下一轮建议只讨论问题 1：Work Bundle 的默认位置与正式文档发布边界。
