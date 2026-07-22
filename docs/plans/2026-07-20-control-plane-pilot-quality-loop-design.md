# Pilot 工作流外壳设计

> 状态：**讨论稿（Draft / Round 4）**，未批准实施
>
> 创建：2026-07-20
>
> 最近讨论：2026-07-21
>
> 目的：沉淀 Pilot 辅助驾驶系统的目标、外部证据、Pi 原生架构、候选实现和未决问题，供多轮讨论持续修订
>
> 关系：本文件取代 [`2026-07-18-docs-flow-subagents-plan.md`](./2026-07-18-docs-flow-subagents-plan.md) 的产品方向；在本设计获批前，不修改现有插件、命令和用户配置

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

## 2. Round 4 架构修正

### 2.1 产品名与双激活入口

**已确认**：插件名为 `pilot`，唯一 slash namespace 为 `/pilot`。Pilot 有且只有两种接管方式：

1. `/mode auto`：Pilot 自动激活并逐 prompt 接管；fresh install 默认 AUTO，因此默认由 Pilot 接管。
2. `/mode ask|plan|edit`：Pilot 默认不接管，主 Pi 按锁定模式直接工作；裸 `/pilot` 手动激活当前 session，直到 `/pilot off` 或 session 结束。

激活状态保持最小：

```text
pilotActive = modePolicy === "auto" || manualPilotActive
activationSource = "auto" | "manual" | "inactive"
effectiveRoute = modePolicy === "auto" ? auxiliaryRouter(prompt) : modePolicy
```

状态转换：

- 进入 AUTO：Pilot 立即以 `activationSource=auto` 接管。
- 从 AUTO 切到 ASK/PLAN/EDIT：在 idle/paused/human Gate 时结束全局接管；child 正在运行时阻止切换，要求先 wait、pause 或 cancel。
- 锁定模式下执行 `/pilot`：设置 `manualPilotActive=true` 并打开 Manager。
- 手动激活后在 ASK/PLAN/EDIT 之间切换：Pilot 保持激活，route 随 mode 更新；这允许 PLAN 完成后切 EDIT 再执行 Work。
- 手动激活后切 AUTO：activation source 转为 `auto`，不保留第二层 manual override。
- `/pilot off` 只关闭 manual activation，并且只在 idle/paused/human Gate 生效；运行中必须先 wait、pause 或 cancel。AUTO 下要求切换 `/mode ask|plan|edit`，不增加“auto 但暂停 Pilot”的第三状态。
- 裸 `/pilot` 以及 `work/review/stage/resume` 可在锁定模式下建立 manual activation；`status/off/pause/cancel` 只操作现有状态，不隐式激活。

旧草案中的 `/sidecar` 与 `/peer` 均不提供兼容 alias。

### 2.2 Mode 既是 direct mode，也是 Pilot route policy

**已确认**：Pilot 吸收当前 `mode` 插件；`/mode` 命令、工具权限和 `mode` status key 继续保留。Pilot fresh install 的默认 policy 为 `auto`。

| Policy | Pilot inactive | Pilot active | Status |
|--------|----------------|--------------|--------|
| `ask` | 主 Pi read-only 回答/分析 | Pilot 接管但固定 ASK；不产生写权限 | `ASK` |
| `plan` | 主 Pi 在当前上下文直接规划 | Pilot 使用 isolated Planner，停在 `ready_for_work` | `PLAN` |
| `edit` | 主 Pi 使用现有 baseline tools 直接写入 | Pilot adaptive preflight，写入前停在 Work Gate | `EDIT` |
| `auto` | 不存在 inactive 状态 | Auxiliary Router 每条分类为 ASK/PLAN/EDIT | idle `AUTO`；运行时 `AUTO→ROUTING/ASK/PLAN/EDIT` |

Direct ASK/PLAN 不能只靠相同 read-only tool list 区分：Pilot package 必须在 `before_agent_start` 注入 mode-specific role contract；ASK 回答/分析，PLAN 只产出计划，EDIT 保持普通 coding agent。manual EDIT 且 Pilot inactive 时，主 Pi 保留当前直接写入能力，不创建 Bundle、不运行 Work Gate，也不承诺 Pilot Review Kernel。

Pilot active 时的 route 定义：

- ASK：无 mutation intent；主会话 read-only 回答，不创建 Bundle，除非显式运行独立 stage。
- PLAN：创建或绑定 Work Bundle，启动 isolated Planner；不写项目文件。
- EDIT：只表达实现意图；Pilot 完成 adaptive preflight 后展示 Execution Envelope，不能直接写入。
- AUTO：调用 Auxiliary `pilot_router`；输出 `route`、`confidence`、`reasons` 和初始 `riskFlags`。低置信度、调用失败或 schema 无效时进入 PLAN。

Planner 的精确关联回答、Manager selector 和 Gate confirmation 不经过 AUTO Router。AUTO 的 effective route 只作用于当前 prompt；配置仍保持 `auto`，下一条普通 prompt 重新分类。

### 2.3 统一工作流

```text
mode=auto:
  ordinary prompt -> Pilot active -> Auxiliary pilot_router
  -> ASK direct answer
  -> PLAN isolated planning -> ready_for_work
  -> EDIT adaptive preflight -> ready_for_work -> Work Gate

mode=ask|plan|edit:
  Pilot inactive -> main Pi handles prompt directly with locked tools/role
  /pilot -> manual activation -> subsequent prompts use fixed Pilot route
  /pilot off -> return to direct locked mode

/pilot work [bundle] while Pilot active + route EDIT:
  -> display and validate Execution Envelope digest
  -> explicit Authorize
  -> primary-solo | worktree-solo | worktree-team
  -> implement -> verify -> Review Kernel -> conditional QA
  -> fix -> re-review，直到 pass / needs_decision / exhausted
  -> execution receipt

commit/push intent -> Git checkpoint -> explicit confirm -> git_finalize
```

### 2.4 产品定位

**已确认**：这是可显式接管、可退出的辅助驾驶。Mode 决定 direct role 或 Pilot route；Pilot 只在 AUTO 或 manual activation 时拥有 workflow state、specialists、权限闭包和 stop conditions。

系统自动处理：AUTO 路由、仓库事实、规划深度、按需 research/spec/interface、topology、验证、独立 review、条件 QA、fix/re-review 和证据追踪。

人类保留：切换 direct/Pilot 的控制权、手工 mode 锁定权、目标与产品取舍、Work Gate 写入批准权、`needs_decision` 决策权以及 commit/push 批准权。

## 3. 核心设计原则

### 3.1 Workflow 不是 Agent

**已确认**：Planner、Ralph-like persistence 和 Team 都被建模为 Pilot workflow；单个 child agent 不拥有整个流程。

- Pilot inactive 时主 Pi 保持现有 direct ASK/PLAN/EDIT 角色；Pilot active 时主会话只承担 ASK responder、UI、Control Plane 和 Human Gates。
- Pilot runtime 只在 active 时拦截路由、保存 workflow state 并执行 gate。
- 隔离的 Planner child 负责 interview 与 plan synthesis。
- Researcher、Architect、Critic、Interface Designer 是 Pilot 按需调用的 specialists；Planner 不自行获得无限编排权。
- Worker 负责写入，但不拥有最终 pass 判定。
- Review Kernel 与 Worker 独立；Reviewer fresh、read-only，QA 不得写产品源码。

### 3.2 组合与独立调用必须共用实现

**已确认**：任一环节都可以在普通会话中独立运行。

因此完整 workflow 和独立命令必须调用同一个 `runStage()`，不能出现：

```text
完整流程的一套 research 实现
/pilot stage research 的另一套 research 实现
```

### 3.3 一个 Canonical Work Bundle

Requirements、Research、Spec、Interface、Handoff、Execution 和 Review 必须属于同一个 Work Bundle，由 manifest 建立可追踪关系。

所有 `canRun`、`canSkip`、`ready_for_work` 和 `pass` 判定都基于同一契约，不能由“发现了某个名字相似的 Markdown”推断完成。

### 3.4 人工 Gate，自动阶段

用户授权一个阶段后，系统自动运行到下一个人类 Gate。中间不要求用户为了“继续 review”而发送无信息量的第二条回复。

### 3.5 Direct EDIT 与 Pilot EDIT 明确分离

- Pilot inactive + manual EDIT：主 Pi 直接写入，这是用户明确保留的 escape hatch；Pilot 不追踪、不 review，也不声称 pass。
- Pilot active + manual EDIT：所有项目写入只授予经过 `/pilot work` Gate 的 child writer。
- AUTO→EDIT：Pilot 已自动激活，仍必须经过 Work Gate。
- Pilot active + manual ASK/PLAN：`/pilot work` 必须阻止，直到用户切换 `/mode edit`；manual activation 在锁定模式切换后保持。

Mode/activation source 必须写入 Execution Envelope，防止 direct 与 Pilot authority 混淆。

### 3.6 有界循环

“直到 pass”不等于无限循环。任何 persistence loop 都必须有：

- 最大迭代数。
- 时间/调用预算。
- 可解释状态。
- `needs_decision`。
- `exhausted`。
- 用户 `cancel`。

## 4. 典型用户路径

### 4.1 默认 AUTO

```text
解释这个模块为什么使用 append-only state
  -> Pilot auto-active -> auxiliary pilot_router -> AUTO→ASK
  -> 主会话 read-only 回答，不创建 Bundle

我想重构 provider 配置，先不要改代码
  -> AUTO→PLAN -> isolated Planner -> handoff -> ready_for_work

修复 statusline 错误标签并补测试
  -> AUTO→EDIT -> tiny preflight -> ready_for_work
  -> /pilot work -> Authorize -> Worker -> review -> receipt
```

### 4.2 Manual direct mode

```text
/mode edit
修正这个标签
  -> Pilot 自动退出
  -> 主 Pi 直接写入，保持现有 edit mode 体验
  -> 无 Bundle / Work Gate / Pilot pass
```

ASK/PLAN 同理由主 Pi 直接处理；statusline 只显示锁定 mode，不显示 Pilot phase。

### 4.3 Manual Pilot session

```text
/mode plan
/pilot                       # manual activation + Manager
设计 provider 迁移方案
  -> isolated Planner -> ready_for_work

/mode edit                   # manual activation 保持
/pilot work -> Authorize
  -> primary-solo 或 worktree-solo -> review -> receipt

/pilot off                   # 返回 direct EDIT
```

### 4.4 Solo isolation

```text
AUTO→EDIT or manual Pilot EDIT
  -> tiny/standard localized -> primary-solo
  -> complex/high_risk or long-running -> worktree-solo
  -> worktree unavailable while isolation=required -> needs_decision
```

### 4.5 并行开发

```text
final triage = worktree_team_candidate
  -> two independent writer lanes + non-overlapping ownership
  -> Work Gate 展示 topology=worktree-team 和每个 lane scope
  -> parallel workers in isolated worktrees
  -> ephemeral lane commits -> Integrator applies commit diffs unstaged
  -> global review + conditional QA -> receipt
```

任一并行 writer 条件不成立时退化为 solo topology；read-only specialists 仍可并行。

### 4.6 临时独立能力

```text
/pilot stage research <question>
/pilot stage interface <spec-or-bundle>
/pilot review <target>
```

独立 stage 可以创建新 Bundle，也可以显式读取已有 Bundle/文件；不能静默绑定一个不明确的“最新文件”，也不能隐式启动 Work。

## 5. OMX 源码调研

调研基线：`Yeachan-Heo/oh-my-codex` commit `435d4a9cc982ffaf83fabbfbb8711ae6c178ffca`（2026-07-19）。

### 5.1 值得抽取的核心

#### Leader workflow + specialist agents

OMX 的 Plan 在同一个 leader workflow 中选择 Interview、Direct、Consensus 和 Review；Consensus 使用顺序的 Planner -> Architect -> Critic，并限制 re-review 轮数：

- [`skills/plan/SKILL.md#L43-L90`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/plan/SKILL.md#L43-L90)
- [`skills/plan/SKILL.md#L212-L229`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/skills/plan/SKILL.md#L212-L229)

可抽取：

- Leader workflow 拥有 interactive planning；在 Pi 中由 Pilot runtime + isolated Planner child 承担，而不是污染主模型上下文。
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

Pilot 只服务当前明确的 Copilot 流程，不复制 OMX 的大量模式、同义触发词和自动 keyword activation。

#### 不移植 completion promise

坚持循环由 runtime state 和 evidence gate 驱动，不依赖模型输出特定完成短语。

#### 不复制 OMX 当前 artifact 分裂

OMX 当前 planning complete 主要从 PRD + matching test spec 推导：

- [`src/planning/artifacts.ts#L98-L115`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/planning/artifacts.ts#L98-L115)

其 issue #827 也明确指出 `deep-interview -> ralplan -> execution` 之间仍缺统一 canonical bundle 和强 runtime binding：

- [Issue #827: Unify deep-interview -> ralplan artifact contract](https://github.com/Yeachan-Heo/oh-my-codex/issues/827)

Pi 版应从第一版就避免同类问题。

### 5.3 名称边界

OMX 当前 `omx sidecar` 是 Team 状态的只读 watch/dashboard，不是 workflow shell：

- [`src/sidecar/index.ts#L6-L15`](https://github.com/Yeachan-Heo/oh-my-codex/blob/435d4a9cc982ffaf83fabbfbb8711ae6c178ffca/src/sidecar/index.ts#L6-L15)

本设计使用 `/pilot`，避免复用 OMX `sidecar` 的 dashboard 语义，也避免与旧草案名称长期并存。本地仓库、Pi 本体和已安装 packages 未发现 `/pilot` 冲突；社区存在同名但无关的 [espennilsen/pilot](https://github.com/espennilsen/pilot) 桌面项目，因此若未来公开发布 npm package，应使用 scoped package name，repo 目录和 slash command 仍保持 `pilot`。

## 6. Pi 原生架构

### 6.1 单一 Pilot Package

**已确认**：最终 mode/workflow 产品面只安装 `extensions/pilot`；共享 `extensions/auxiliary` 继续独立存在。Pilot 在同一个 entry 中注册 `/pilot` 和 `/mode`，吸收现有 mode 配置、工具策略、session persistence 和 presentation/status 接线。

```text
extensions/pilot/
  extensions/pilot.ts       # /pilot + /mode + Pi hooks
  lib/activation.ts         # auto/manual/inactive state
  lib/mode.ts               # direct tools + Pilot fixed route
  lib/aux-router.ts         # auxiliary pilot_router adapter + schema
  lib/state.ts              # run/phase/router state
  lib/artifacts.ts          # Work Bundle contract
  lib/stages.ts             # fixed registry + runStage()
  lib/triage.ts             # final task depth + risk upgrades
  lib/gates.ts              # ready/work/pass/needs_decision
  lib/routing.ts            # primary-solo/worktree-solo/worktree-team
  lib/review.ts             # Review Kernel + conditional QA
  agents/                   # planner/specialist/reviewer profiles
  skills/                   # interview/planning/execution contracts
  templates/                # requirements/spec/interface/handoff
  tests/
```

`lib/stages.ts` 只是固定 registry，不是通用 DAG 平台。Pilot 不实现第二套模型 runtime 或 subagent scheduler。

### 6.2 复用 Auxiliary `pilot_router`

**已确认**：AUTO 分类复用现有 AuxiliaryRuntime、配置合并、模型解析、认证、fallback、timeout、usage/cost entry 和 active status。Pilot 只提供 router prompt、固定 JSON schema 与路由解释。

新增 task scene：

```json
{
  "auxiliary": {
    "tasks": {
      "pilot_router": {
        "thinking": "off",
        "timeoutMs": 10000,
        "maxOutputTokens": 128,
        "maxRetries": 0
      }
    }
  }
}
```

- `pilot_router.model` 未配置时继承 `auxiliary.default.model` 和 fallback；用户可单独覆盖。
- 显式 `useAuxiliary=false` 时沿用 auxiliary 现有语义，使用 current model；这不是 silent fallback。
- Router system prompt 把用户文本视为 untrusted classification data，只允许固定 JSON；用户内容不能改写 schema、tools、fallback 或 authority。
- Pilot 通过 versioned internal call contract 请求 `pilot_router`，不能调用 `aux_summarize` 冒充分流，也不能直接 import 一份独立 runtime 造成双重 usage/status。
- Auxiliary disabled、internal bridge unavailable、timeout、invalid schema 或 low confidence 时，Pilot fail-safe 到 PLAN；不静默改用另一个模型。
- Auxiliary 仍只是 task-scoped execution substrate；逐 prompt 分类语义属于 Pilot。

内部 call contract 的传输形式列入 Phase 0 spike，但必须复用同一个 `AuxiliaryRuntime.call()` 和 `terrific-pi:auxiliary-usage-v1` 证据链。

### 6.3 B\*：双激活 + 隔离 Planner Child

**已确认**：只有 `mode=auto` 或 `manualPilotActive=true` 时 Pilot 才接管。锁定模式且 Pilot inactive 时，主 Pi 保持现有 direct ASK/PLAN/EDIT 行为。

```text
Main Pi session
  inactive = direct locked-mode agent
  active   = ASK responder + UI + Control Plane + Human Gates

Pilot activation
  = mode===auto || manualPilotActive

Pilot runtime
  = auxiliary route + workflow state + Work Bundle + orchestration

Planner / Specialists / Worker / Review Kernel
  = only while Pilot active, under stage and Envelope contracts
```

交互路径：

1. Session start 读取 mode policy；AUTO 自动激活，锁定模式默认 inactive。
2. Pilot inactive 时普通 prompt 不被 Pilot 拦截，由现有 mode tools/role 交给主 Pi；manual EDIT 可直接写。
3. 锁定模式下裸 `/pilot` 写入 session-scoped manual activation entry 并打开 Manager；`/pilot off` 追加 deactivation entry。
4. Manual activation 在 ASK/PLAN/EDIT 之间切换时保持；从 AUTO 安全切到锁定模式时 manual flag 重置为 false。
5. Pilot active + AUTO 时，普通 prompt 先调用 Auxiliary Router；active + locked mode 时不调用 classifier，effective route 等于 mode。
6. Active ASK 放行主模型但强制 read-only；active PLAN/EDIT 返回 `handled` 并创建或绑定 Bundle。
7. Planner `ask_user` 回答优先于普通 route，并以 `runId + generation + pendingRequestId` 精确关联。
8. Planner 只能返回有限 structured action；Pilot 决定 specialists、stage、Gate 和 stop condition。

**持久性原则**：Planner session 是可丢弃的上下文缓存，Canonical Work Bundle 才是事实来源。

- 正常路径优先 resume 同一个 Planner，保持访谈连贯。
- 每轮确认的需求、答案、决策和 stage result 都先写入 Bundle，再继续。
- Planner session 丢失或 resume 不可用时，从 Bundle 启动 fresh Planner 恢复。
- 不允许只有 child transcript 知道、Bundle 中不存在的已批准决策。

**A 降级路径**：只有 Planner relay/resume 不可用时，Pilot 才可提出由主模型临时承担 Planner。该降级会增加主上下文，必须先明确告知用户并获得同意，不能静默切换。

### 6.4 Pi hooks 的职责

Pi 0.80.10 已提供候选扩展事件；AUTO routing 仍需 Phase 0 验证 Auxiliary call 完成后“ASK 放行或 PLAN/EDIT handled”的精确时序。

| Pi surface | Pilot 职责 |
|------------|-----------|
| `registerCommand` | 同一 package 注册 `/pilot ...`、`/pilot off` 和 `/mode ...` |
| `input` | 先处理 correlated Planner answer；inactive 时放行；active locked route 或 AUTO 时接管 |
| `before_agent_start` | inactive 时注入 ASK/PLAN/EDIT direct role + tools；active ASK 注入 read-only；active PLAN/EDIT 不启动主模型 |
| `tool_call` | 仅对 Pilot-active workflow 阻止越过 route/Gate；不伪装监管 direct EDIT |
| `tool_execution_end` | 记录父会话看到的 subagent 结果；不能假设能看到 child 内部每次工具调用 |
| `message_end` | 防止 active workflow 提前宣告完成；inactive direct mode 不套 Pilot completion contract |
| `agent_end` / `agent_settled` | 结束 AUTO turn authority，保留 lastRoute 供 status，安排下一阶段或 gate |
| `session_start` / `session_shutdown` | 恢复 mode、manual activation entry 和 active run；AUTO lastRoute 不写入 policy |
| `setStatus` | `mode` 显示 policy/route；`pilot` 仅在 manual idle 或有 workflow phase/Bundle 时显示 |

模型负责推理；extension 负责状态、权限和 stop gate。避免只靠 prompt 自律。

**强制边界**：父 Pi extension hooks 只覆盖父会话，不能作为 child runtime 内部工具调用的审计器。Child 写权限必须由以下机制共同约束：

- 固定、可校验的 agent profile 与 tool allowlist。
- 明确 cwd、writer scope 和（适用时）隔离 worktree。
- 执行前 baseline 与执行后实际 diff/hash 对账。
- 子代理返回 changed files / validation evidence，但不能只相信其自述。
- profile、cwd、writer scope 或 baseline 发生变化时，Work Gate 授权失效。

在完成 child permission/enforcement spike 前，Pilot execution 仍是架构 Blocker，不能只靠父 hooks 宣称权限安全。

### 6.5 复用 pi-subagents

能力状态必须区分“包提供”与“Pilot 已验证”：

| 能力 | 当前状态 |
|------|----------|
| Auxiliary task runtime/config/usage | 已验证；`pilot_router` task 与跨 extension internal call 待 spike |
| foreground single-agent delegation | 已验证，可供 Planner 与 planning specialists 使用 |
| Pi `input` interception + `handled` | 官方 API 已确认；inactive pass-through、Aux async route、ASK 放行/Pilot 接管时序待 spike |
| foreground child detach 等待 supervisor reply | 包提供；Pilot relay integration 待 spike |
| Planner resume / fresh recovery | 包提供 resume；Bundle rehydration contract 待实现 |
| fresh read-only specialists | profile 可实现；Pilot 专用权限仍需验证 |
| Worker resume | 包提供，Pilot integration 未验证，Phase 1 Work 前置 spike |
| single worktree | 包提供；`worktree-solo` integration 未验证，Phase 3 前置 spike |
| parallel/worktree | 包提供；`worktree-team` integration 未验证，Phase 6 前置 spike |
| detached/background | 当前受 `typebox/compile` 故障阻塞；不阻塞 foreground Planner relay |
| intercom/needs_decision | 包提供，Pilot ownership/UX 未验证 |

目标用法：

- AUTO Router：Auxiliary `pilot_router` one-shot call，无工具；失败时 PLAN-safe fallback。
- Planner：foreground isolated child；正常 resume，失败时由 Work Bundle fresh recovery。
- Research/Architect/Critic/Interface/Reviewer：fresh、read-only agent，由 Pilot 调用。
- Solo Worker：根据 isolation policy 在 primary tree 或 dedicated worktree 中运行。
- Parallel writers：只允许 `worktree-team`；shared tree 始终最多一个 writer。
- Review Kernel：默认一个 fresh Reviewer，风险触发 Architect lane 或独立 QA。
- Direct locked mode：不调用 pi-subagents，不套 Pilot Gate/receipt。
- Pilot 不实现自己的模型进程、队列、RPC、tmux runtime 或第二套 subagent 调度器。

## 7. Stage Registry

### 7.1 Stage Contract

建议最小接口：

```ts
interface PilotStage<I, O> {
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
| `work` | Ready handoff + approved Envelope | Execution evidence | 是，仍需 Work Gate |
| `review` | Goal + artifacts + changes | Pass/fail/decision verdict | 是 |
| `qa` | Risk flags + runnable target | Behavior evidence + pass/fail | 是 |
| `commit-checkpoint` | Approved intent + staged diff | Landing-vs-intent report | 是，Git only |

`activate`、`fix`、`verify`、`integrate` 和 `mode-route` 是 workflow internal actions，不作为独立 public stage 承诺。所有 Public Stage 都必须能通过 generic `/pilot stage <id>` 调用；V1 只为高频 `review` 提供 convenience command。

### 7.3 Full Workflows

完整流程只是 stage composition：

```text
activation:
  AUTO -> Pilot active -> auxiliary route
  locked + /pilot -> Pilot manual active -> fixed route
  locked + inactive -> direct Pi, no Pilot workflow

plan (Pilot active only):
  intake -> provisional triage -> interview?
  -> final triage -> research? -> spec? -> interface?
  -> plan-review? -> handoff

work:
  validate execution envelope -> route primary-solo/worktree-solo/worktree-team
  -> work -> verify -> review -> architecture lane?
  -> adversarial QA? -> internal fix/review loop -> completion audit

commit:
  commit-checkpoint -> human confirm -> git_finalize
```

## 8. Planning Workflow

### 8.1 Intake

Pilot active 的 PLAN route 或 EDIT preflight 接管 prompt 后：

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
  "needsArchitectureReview": false,
  "needsAdversarialQA": false,
  "executionRecommendation": "primary_solo | worktree_solo | worktree_team_candidate",
  "isolation": "none | preferred | required",
  "isolationReasons": [],
  "riskFlags": [],
  "reasons": []
}
```

确定性规则只能升级，不能降级：

- auth/security/permissions/secrets、public API/protocol、多模块共享契约：至少增加 architecture review。
- runtime/stateful/CLI、cancel/resume、外部服务交互：增加 risk-derived adversarial QA。
- UI behavior：增加 Interface Spec；实现后运行 Playwright 与视觉/可访问性检查。
- schema/data migration、destructive、production/deployment、compliance/PII/payment：升级为 `high_risk` 并要求明确 decision。
- `tiny/standard` 且 localized：默认 `primary_solo`。
- `complex` Git task：默认 `worktree_solo + isolation=preferred`。
- `high_risk`、long-running/cross-session/background、dependency upgrade、migration code 或 broad refactor：`worktree_solo + isolation=required`。
- 两个以上可独立 writer lane：`worktree_team_candidate`；是否并行仍由 Work Gate 前 topology validation 决定。
- 非 Git 或任务依赖当前相关 dirty changes：只能 `primary_solo`；若同时要求 isolation，进入 `needs_decision`。

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
tiny/standard: no plan-review by default
complex:       Planner -> fresh Architect -> Planner revise
high_risk:     Planner -> fresh Architect + fresh Critic -> Planner revise
               -> 最多 2 轮
```

不为形式运行 consensus。Critic 只在 `high_risk` 或 Architect 明确要求第二视角时加入。

## 9. Canonical Work Bundle

### 9.1 目录与发布边界

**已确认**：Bundle 只属于 Pilot-active workflow，必须跨 session 持久，并由 primary/worktree-solo/team 共享且不污染 Git status。

```text
Git project:     <git-common-dir>/pilot/runs/<run-id>/
Non-Git project: <cwd>/.pi/pilot/runs/<run-id>/

<run-id>/
  manifest.json
  requirements.md
  decisions.md            # confirmed Q&A/decisions only; no hidden reasoning
  research.md             # optional
  spec.md                 # optional for tiny tasks
  interface.md            # optional
  handoff.md              # work 前必需
  execution.json          # work 后生成
  receipt.json            # terminal state 后生成并跨 session 保留
  reviews/
    plan-01.json
    implementation-01.json
    architecture-01.json  # optional
    qa-01.json            # optional
```

Git 路径通过 `git rev-parse --git-common-dir` 解析，因此 primary tree 和所有 linked worktrees 共享同一 Bundle，也不会产生 untracked `.pi/pilot`。正式项目文档只在用户明确执行 publish action 或项目现有规范要求时写入既有 `docs/`；Pilot 不自动发布 interview、runtime review 或 transcript。

### 9.2 Manifest

建议最小结构：

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "cwd": "...",
  "originalPrompt": "...",
  "modePolicy": "ask | plan | edit | auto",
  "pilotActivation": "auto | manual",
  "effectiveRoute": "plan | edit",
  "routeDecision": {},
  "workIntent": null,
  "status": "planning | ready_for_work | working | reviewing | qa | passed | blocked | exhausted | cancelled",
  "phase": "interview | research | spec | interface | handoff | work | review | qa | fix",
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
  "executionRecommendation": "primary_solo | worktree_solo | worktree_team_candidate",
  "isolation": "none | preferred | required",
  "executionTopology": null,
  "worktreePlan": null,
  "executionEnvelope": null,
  "authorizationDigest": null,
  "iterations": {
    "planReview": 0,
    "workReview": 0,
    "qa": 0
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

`/pilot work` 不能只批准一个 Handoff 文件；它批准的是完整 **Execution Envelope**：

```text
Execution Envelope =
  Work Bundle manifest version + original route
  + Pilot activation source + mode policy/effective route at authorization
  + explicit workIntent=EDIT
  + requirements/spec/interface/handoff artifact hashes
  + cwd realpath
  + repository/file baseline fingerprint
  + selected primary-solo/worktree-solo/worktree-team topology
  + isolation level and reasons
  + writer/integrator profiles and versions
  + each writer scope and lane ownership
  + worktree base refs/paths when isolated
  + ephemeral commit and unstaged integration policy
  + validation/review/QA obligations
```

用户输入 `/pilot work` 时，AUTO 已 active；锁定模式下该 workflow command 先建立 manual activation。随后检查 route：manual ASK/PLAN 立即阻止；manual EDIT 保持 `EDIT`；AUTO 确定性更新为 `AUTO→EDIT`。通过前置检查后，Pilot 才记录 `workIntent=EDIT` 并生成 `authorizationDigest`。原 Bundle 可以来自 PLAN 或 EDIT route，但 activation、EDIT route 和 `/pilot work` 本身都不是最终写授权；只有 TUI `Authorize` 或 headless exact-digest confirmation 才授权对应 child writer。

上述任一输入发生变化，旧授权立即失效，必须重新展示差异并再次批准。这用于避免 route、plan 展示后到实际执行之间的 TOCTOU。

### 10.2 Solo Topology 判定

| Topology | 默认条件 |
|----------|----------|
| `primary-solo` | 非 Git；tiny/standard localized；任务依赖当前相关 dirty changes |
| `worktree-solo` | Git complex/high_risk；long-running/cross-session；dependency/migration/broad refactor；用户明确要求隔离 |

Dirty rules：

- Relevant dirty changes 位于 approved write scope：不自动 stash、commit、copy 或 patch 到 worktree；使用 `primary-solo`，并把 dirty baseline 绑定 Envelope。
- Dirty changes 与任务无关且可证明 scope 不重叠：允许从 approved base 创建 `worktree-solo`；集成前必须重新验证 target baseline。
- `isolation=required` 但 worktree unavailable、base 不可证明或相关 dirty state 无法安全迁移：进入 `needs_decision`，不能静默降级。
- `isolation=preferred` 创建失败：展示 topology 差异并重新授权后才可退到 `primary-solo`。

两种 solo topology 共用同一 Worker/review loop：

```text
worker iteration -> targeted verification -> Review Kernel
  -> pass
  -> findings -> resume same worker -> re-verify
  -> needs_decision -> human
```

普通 fix 优先 resume 原 Worker。只有 resume/transport 失败或上下文损坏时才交给 fresh Fix Worker；profile、scope、topology 或 base 变化必须重新授权。

### 10.3 Worktree Solo Lifecycle

```text
Pilot Control Plane
  -> create dedicated worktree + ephemeral branch from approved base
  -> one Worker implements and commits transport artifact
  -> worktree-local verification + Review Kernel/fix loop
  -> git apply --check -> apply approved commit diff to target unstaged
  -> target baseline recheck + global verification + Completion Audit
  -> retain worktree until receipt/landing recovery no longer needs it
```

Worktree commit 不等于 landing commit，不 push、不直接落目标分支。Integrator 必须先验证 target index 未被 Pilot 修改，再执行 checked unstaged apply；若 baseline/index 变化或 patch conflict，停止并进入 `needs_decision`。

### 10.4 Worktree Team 判定

**已确认**：任何并行 writer 都必须位于独立 Git worktree；不存在 shared-tree multi-writer topology。Read-only specialists 不计 writer，可在当前树并行。

只有同时满足以下条件才选择 `worktree-team`：

- Target worktree clean，且所有 lane 以同一 approved base ref 创建。
- 至少两个可独立交付的 writer lane；每个 lane 有独立 acceptance、write scope 和 validation。
- 文件/模块 ownership 不重叠，也不共同修改 central registry、lockfile、schema/migration entry 或生成产物。
- Worktree 创建、路径隔离和 child cwd/profile 强制均通过 Phase 0/Team spike。
- 单一 Integrator、集成顺序、冲突策略和全局验证路径已经写入 Envelope。

任一条件不成立就退化为 `primary-solo` 或 `worktree-solo + parallel read-only specialists`，不能以“并行更快”为理由降低隔离要求。

### 10.5 Pi-native Worktree Team

```text
Pilot Control Plane
  -> create one worktree per approved writer lane
  -> parallel workers produce commits on ephemeral lane branches
  -> lane-local verification + evidence
  -> Integrator checks and applies commit diffs to target unstaged
  -> global verification -> Review Kernel -> conditional QA
  -> keep worktrees until receipt/landing recovery no longer needs them
```

Lane commit 只是隔离分支上的 transport artifact，不是用户批准的 landing commit。所有 ephemeral commits 禁止 push；Integrator 先 `git apply --check`，再把 binary-capable commit diff 应用为 target working-tree 的 unstaged changes。冲突或 index 非预期变化进入 `needs_decision`。最终 stage/commit/push 仍由用户与独立 Git Gate 控制。

Phase 1 先交付 `primary-solo`；`worktree-solo` 在 Team 前实现并复用同一 isolation/integration primitives。

## 11. Ralph-like Persistence

### 11.1 正确所有者

用户体验上可以称为“Worker 自我循环”，但架构上循环必须属于 Pilot runtime：

```text
Pilot owns stop condition
Worker owns implementation
Review Kernel owns quality verdict
Human owns decisions
```

Worker 不能同时拥有写入权和 pass 判定权。

### 11.2 Loop

```text
Iteration 1:
  Worker -> verify -> implementation review
  -> architecture lane? -> adversarial QA?

Review Kernel:
  pass            -> completion audit
  fail            -> findings -> same Worker resume
  needs_decision  -> human gate

Iteration N:
  Fix -> verify -> rerun required review/QA only
```

### 11.3 Completion Audit

Pass 需要：

- 每项目标/验收条件映射到 artifact 或 evidence。
- 实际 changed files 与 Worker 声明一致。
- 要求的验证命令有新鲜结果。
- Required review lanes 的 verdict 均为 pass。
- `needsAdversarialQA=true` 时 QA verdict 为 pass。
- 无 unresolved required finding。
- 无未批准 scope drift。

### 11.4 Stop Conditions

建议默认：

- Implementation review 最多 3 轮。
- Transport failure 不自动无限重试。
- 同一根因最多 3 次修复尝试。
- `needs_decision` 立即暂停。
- 达到预算进入 `exhausted`，不伪装 pass。
- 用户 `/pilot cancel` 发出取消请求并立即停止新调度；正在运行的 child 必须等待 cancel/terminal acknowledgement。
- 取消后的已落盘变更默认保留并报告，不自动回滚；迟到 response 以 run generation/request id 去重，不能重新启动后续阶段。

## 12. 独立能力入口

### 12.1 V1 命令面

```text
/pilot                                  # manual activate + open Manager; AUTO only opens Manager
/pilot off                              # end manual activation; AUTO requires mode switch
/pilot work [bundle]                    # activate if needed, then display Work Gate
/pilot work --confirm <digest>          # headless/RPC exact-digest confirmation
/pilot review [target]                  # activate if needed; frequent independent review
/pilot stage <id> [input]               # activate if needed; every Public Stage including qa
/pilot status|pause|resume|cancel       # lifecycle control; status does not activate
/mode ask|plan|edit|auto|config         # direct mode + Pilot route policy
```

V1 不提供 `interview/research/spec/interface/handoff` convenience aliases。裸命令和 `work/review/stage/resume` 可建立 manual activation；`status/off/pause/cancel` 不激活。AUTO 下 Pilot 已激活。

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
- 不得隐式触发 `/pilot work`。
- Review 可以审查任意显式 target，不要求先运行 Plan。
- 独立 `/pilot review` 默认只审明确 target；workflow review 默认只审 Execution Envelope 授权后的 delta。

## 13. Review Kernel

### 13.1 分层而非固定全套

| Lane | 触发 | 职责 |
|------|------|------|
| Implementation Reviewer | 所有 Work | correctness、tests、security、scope、maintainability |
| Architecture Reviewer | `needsArchitectureReview` | shared contracts、boundary、migration、design counterexample |
| Behavior QA | `needsAdversarialQA` 或 UI behavior | 运行 risk-derived scenarios、browser/CLI/service probes |
| Document Reviewer | document artifact | render、format、content contract、cross-artifact consistency |
| Completion Audit | 所有 Work | deterministic acceptance-to-evidence reconciliation |

默认只启动一个 fresh Implementation Reviewer。Architecture lane 和 QA 按 triage flags 添加；不复制 OMX 的重复双 review，也不对所有任务运行固定 UltraQA 矩阵。

### 13.2 QA 策略

QA 根据实际风险生成最少必要场景，例如 malformed input、cancel/resume、stale state、dirty worktree、hung command 或 UI responsive state。首次失败回到 Worker；修复后重跑 baseline、失败场景和受影响场景。QA 最多 2 轮，仍失败进入 `needs_decision` 或 `exhausted`。

### 13.3 权限

Reviewer 必须 fresh、independent、read-only。Behavior QA 可以执行测试、浏览器和临时 scratch harness，但不能修改产品源码；Worker 是唯一修复者。当前 builtin reviewer 暴露 `edit/write`，不能直接作为 Gate，必须新建或收紧 Pilot profiles。

### 13.4 Verdict

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

任何 required lane 缺失、解析失败或证据过期都视为 Gate failure，不视为 pass。

## 14. 人类 Gate

只保留以下人类决策点；commit 与 push 分别绑定各自授权载荷：

| Gate | 触发 | 人类动作 |
|------|------|----------|
| Planning start | Pilot active + PLAN/EDIT prompt 或 Manager start | direct mode 不创建 Bundle；active route 才进入 planning/preflight |
| Work start | Pilot active + EDIT 下 `/pilot work` -> TUI `Authorize` | ASK/PLAN hard-block；审阅并批准 Envelope digest 与 child 写入 |
| Decision | `needs_decision` | 选择范围、风险或产品取舍 |
| Commit landing | commit intent | 批准 staged fingerprint 与 commit |
| Push landing | push intent | 批准 remote、branch/upstream 与 commit range |

普通 research、Architect/Critic review、implementation review/fix 不要求无意义确认。

## 15. Git 与非 Git

### 15.1 Git

- 仅 Pilot-active workflow 记录 approved base、baseline 和 changed files；direct mode 修改不冒充 Pilot 产出。
- Solo 根据 isolation policy 使用 primary tree 或 dedicated worktree；所有 parallel writer lane 必须使用 isolated worktrees，shared tree 始终最多一个 writer。
- Ephemeral solo/lane commits 只用于 worktree transport，禁止 push；target integration 必须保持 changes unstaged，不允许自动修改 index。
- Commit checkpoint 以 approved goal、scope、non-goals、acceptance 和 decisions 为权威，对 staged diff 重新做 reconciliation；Handoff 不是需求权威。
- staged fingerprint 改变后旧确认失效。

### 15.2 非 Git

- 只允许一个 writer。
- `/pilot work` 前对声明 writer scope 内的既有文件建立有界 backup manifest，并记录执行中新建文件。
- scope 过大、不可枚举或备份失败时，阻止执行并请求用户缩小范围或明确接受“无自动恢复点”。
- 用父层 mutation record、文件前后 hash/mtime、实际目录对账和 Worker 声明交叉验证。
- `cancel`、`failed`、`exhausted` 默认保留部分修改并报告；恢复必须由用户明确选择，避免覆盖并发改动。
- Completion review 仍可运行。
- Git checkpoint 不适用。

## 16. 已确认交互设计

### 16.1 原则

**已确认**采用轻量聊天式：

- 平时沿用 Pi 的普通聊天编辑器，不建立第二套全屏应用。
- Footer 始终保留 `mode` badge；AUTO idle 由 `AUTO` 表达，`pilot` phase 只在 manual activation 或 active Bundle 时显示。
- Planner 每轮只展示一个问题；精确关联回答由 Pilot 转发，不触发 Mode Router 或主模型。
- 只有 Manager、危险 Gate 和 bounded choice 使用 TUI overlay。
- 不设置常驻右侧面板，不复制 `pi-subagents` 已有进度面板。
- 不把 child 的完整日志、thinking 或 routine progress 刷入主聊天区。

### 16.2 Planning 问答

Pilot active 的 PLAN route 或 EDIT preflight 才启动 Planner。Planner 返回 `ask_user` 后，Pilot 使用 editor 上方 widget 显示：

```text
Pilot · Interview 2

这个插件应该只影响新请求，还是允许切换正在运行的会话？

回答将发送给 Planner
```

交互规则：

- 自由文本继续使用 Pi 原生 editor，保持中文 IME、历史和已有键位行为。
- 只有 `awaiting_user + pendingRequestId` 精确匹配时，`input` hook 才返回 `handled`。
- 有限选项使用 `SelectList`；自由文本不强制进入 modal。
- 提交后 question widget 关闭，Footer 切到 `plan:thinking` 或实际 stage。
- `/pilot pause` 暂停当前 Planner answer interception，Planner state 和 activation 保留；要返回 direct mode，manual activation 使用 `/pilot off`，AUTO 则切换 `/mode ask|plan|edit`。
- `/pilot resume` 恢复路由并重新显示同一个 pending question。
- `/pilot cancel` 请求取消当前 workflow，不把它解释为问题答案。

Research、Architect、Critic 只产生阶段摘要，例如：

```text
Pilot · Research complete
3 sources accepted · 1 assumption unresolved
Next: architecture
```

### 16.3 按需 Manager

裸 `/pilot` 在锁定模式下先 manual activate，再打开 overlay manager；AUTO 下只打开 Manager。`Esc` 只关闭 overlay，不退出 activation。

无 active Bundle 时显示 mode policy、activation source 和最近 AUTO effective route，并只提供：

- Start goal（严格使用当前 active route；ASK 时隐藏写入 workflow）。
- Change mode。
- Deactivate（仅 manual activation）。
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
Pilot · Ready for work

Goal       模型路由插件
Route      AUTO→EDIT
Activation auto
Tier       complex
Topology   worktree-solo
Isolation  preferred
Artifacts  requirements · research · spec · handoff
Risks      1 accepted · 0 unresolved
Bundle     <git-common-dir>/pilot/runs/<run-id>
```

用户显式输入 `/pilot work` 后，Pilot 计算并展示 Execution Envelope：

```text
Authorize Pilot Work

cwd          /home/lcc/project
topology     worktree-solo
isolation    preferred
writer       worker
write scope  extensions/model-router/**
validation   npm test
baseline     38d71a...
digest       a91c42...

> Authorize
  Cancel
```

**已确认**：`/pilot work` 只打开 Gate；在 TUI 中选择 `Authorize` 才是实际写入授权。Envelope 任一字段变化都会关闭旧弹窗并使旧 digest 失效。

Headless/RPC 环境不伪造确认：第一次 `/pilot work` 只输出 Envelope 和 digest；必须使用 `/pilot work --confirm <digest>`，验证未变化后才执行。

### 16.5 执行反馈与完成

执行期间复用 `pi-subagents` 进度，只额外显示 Pilot gate/iteration：

```text
work:primary-solo · implement
work:worktree-solo · implement
work:review 1/3
work:fix 1/3
```

- `fail` findings 自动送回 Worker，不要求用户回复“继续”。
- `needs_decision` 使用 bounded selector 或单问题 widget 打断用户。
- `cancel`、`failed`、`exhausted` 必须显示已落盘变更和恢复信息。
- `pass` 后输出 changed files、验证结果、review 轮次和 execution receipt path。

### 16.6 Mode + Activation

**已确认**：Mode policy、Pilot activation 和 scoped write authorization 是三层不同状态。

- `/mode auto` 自动激活 Pilot；尚无 route 时显示 `AUTO`，分类中显示 `AUTO→ROUTING`，完成后显示 `AUTO→ASK|PLAN|EDIT`。
- `/mode ask|plan|edit` 默认停用 Pilot，主 Pi 使用现有 locked tools；manual EDIT 恢复 baseline tools 并允许 direct write。
- 锁定模式下 `/pilot` 或 workflow command 建立 manual activation；此后 route 固定为当前 mode，不调用 Auxiliary Router。
- Manual activation 在 ASK/PLAN/EDIT 切换间保持；从 AUTO 只在 idle/paused/Gate 安全切出并回到 inactive，AUTO 下 `/pilot off` 被拒绝并提示切 mode。
- Pilot active ASK 强制 read-only；active PLAN/EDIT 的写入只存在于经过 Envelope Gate 的 child profile。
- Manual ASK/PLAN 下 `/pilot work` 被阻止；manual EDIT 或 AUTO→EDIT 才可打开 Work Gate。
- Manual mode switch 发送 presentation event；AUTO 每次 route 只更新 status，避免刷屏。

### 16.7 HUD

Statusline 使用两个现有扩展状态槽位，不建立新 dashboard：

```text
mode:  ASK | PLAN | EDIT | AUTO | AUTO→ROUTING | AUTO→ASK | AUTO→PLAN | AUTO→EDIT
pilot: manual | plan:interview | plan:research | plan:review 1/2 | ready
       work:primary-solo | work:worktree-solo | work:team 2/3
       work:review 1/3 | qa 1/2 | blocked | passed
```

`mode` widget 继续由 statusline 专用 badge 渲染；`modeTone` 解析箭头后的 effective route。Pilot inactive 时不设置 `pilot` status；manual active idle 显示 `pilot:manual`，AUTO idle 只靠 `AUTO→...` 表达接管。`mode` 从 generic progress 排除，`pilot` 保留为 workflow phase。只有 pending question 或短期阶段信息使用 `setWidget`。

### 16.8 Context

- Pilot active 时主 Pi 只保留 Control Plane 状态、Human Gates 和用户可见结果；inactive direct mode 保持普通主会话上下文。
- `input` hook 优先级固定为 correlated Planner answer -> slash command -> activation check -> route。
- Pilot inactive 时普通 prompt 直接交给主 Pi；active ASK 启动主模型，active PLAN/EDIT 返回 `handled`。
- Planner 回答与 AUTO route 必须验证不会双启动；manual activation entry、session restore 和 transcript 行为列入 Phase 0 spike。
- 完整 Planner/Worker/Reviewer transcript 不回注主模型上下文。
- 主模型上下文只在需要 Control Plane 推理时接收 artifact path、摘要、findings、证据和风险。
- Planner session 是缓存；所有已批准需求与决策必须进入 Bundle，子代理不能依赖隐藏对话作为唯一事实。

## 17. Legacy 插件吸收与彻底移除

### 17.1 可复用能力先迁入 Pilot namespace

实现期间只迁移已验证且仍需要的代码：Artifact Contract、safe relative paths、overwrite protection、planning agents、`project-docs` skill、模板以及 model/thinking/timeout override。所有 package name、status key、schema id、prompt 文案、artifact path 和测试 fixture 都改为 `pilot` 语义，不能继续依赖旧 package 才可运行。

固定文档流水线、旧 state machine、vault-specific product surface、reminder/configurator 和 `/docsflow` manager 不迁移。

### 17.2 最终安装面

**已确认**：改造完成后，mode/workflow 产品面只安装 `extensions/pilot`；现有 `extensions/auxiliary` 继续作为共享 task runtime，不并入 Pilot。

- 删除 `extensions/docsflow/`，不保留 `/docsflow` deprecated alias。
- 删除 standalone `extensions/mode/`；`/mode` 由 Pilot package 注册。
- `settings.json` packages 用一个 `../vendor/terrific-pi/extensions/pilot` 替换旧 `mode` 与 `docsflow` 两项；现有 `auxiliary` package 保留。
- 从 managed `terrific.json` 移除 `docsflow` config；保留 top-level `mode.default` / `mode.persistPerSession`，增加 `mode.routingVersion: 1` 并改由 Pilot package 读写。
- Fresh install 与 managed snapshot 使用 `mode.default=auto`。旧配置没有 `routingVersion: 1` 时不能把 legacy `edit` 静默解释为新 manual EDIT；TUI 首次启动要求选择 AUTO（推荐）或保留为人工锁，headless 仅以 session AUTO 运行并报告待迁移，不自动改文件。
- Auxiliary 增加 `pilot_router` task/config UI/internal call 与文档；README、CAPABILITIES、snapshot、statusline 接线、agents/chains/skills 和测试不得再登记 docsflow package、slash command 或 status key。
- 不删除用户已有 `./docsflow/` 文档和 `.pi/docsflow/` 状态；它们成为只读 legacy data，可由显式 import 工具迁移，但 Pilot runtime 不再读取或写入。

切换可以在开发分支分步完成，但正式验收时不允许两个 package 或两个 slash surface 共存。

## 18. 分阶段落地建议

### Phase 0：Runtime Spikes

- 验证 `pilotActive = auto || manual`：AUTO 自动接管、锁定模式 direct pass-through、`/pilot`/`off`、safe-gate deactivation、mode transitions 和 session restore。
- 验证 Auxiliary `pilot_router` internal call、route inheritance、usage/cost 单次记账、timeout/schema failure -> PLAN；禁止双 runtime 和 silent main fallback。
- 验证 `input -> handled` 后同一 prompt 只启动 ASK main 或 PLAN/EDIT Pilot 其中一条路径。
- 验证 inactive ASK/PLAN 的 role contract 与 read-only tools、manual EDIT baseline tools/direct write，且 Pilot 不生成虚假 Bundle/receipt。
- 验证 foreground Planner detach/reply、resume、fresh recovery、stale answer correlation 和 transcript 行为。
- 验证 child profile/tool allowlist/cwd/write scope 强制、baseline reconciliation、Worker resume/cancel/stale response。
- 验证 worktree-solo/team create、dirty non-overlap、cwd isolation、ephemeral commits、`git apply --check`、unstaged integration、target drift 和 cleanup recovery。

AUTO/Aux spike 失败则 `/mode auto` 不发布；permission spike 失败则 Pilot Work 不发布；worktree-solo/team spike 可分别阻塞对应 topology，不阻塞 `primary-solo`。

### Phase 1：Activation + Primary Solo Vertical Slice

- 新建 Pilot package，吸收 `/mode`，实现 direct locked modes、AUTO activation、manual `/pilot`/`off`、session persistence 和 status。
- 为 Auxiliary 增加 `pilot_router` scene、配置 UI 和 versioned internal call；Pilot 不自建模型 runtime。
- 实现 Manager、Pilot-active prompt route、Planner relay 和 Canonical Work Bundle。
- 交付一条 Git `primary-solo` 纵向链路：route -> plan/preflight -> Work Gate -> Worker -> verify -> one fresh Reviewer -> receipt。
- 实现 TUI Authorize 与 headless exact-digest confirmation 的同一验证函数。
- 不先铺满所有 stages；先证明目标、权限、证据和恢复能端到端闭环。

### Phase 2：Adaptive Planning + Review Kernel

- 实现 provisional/final triage、tiny/standard/complex/high_risk 和 deterministic risk upgrades。
- 迁入并改名所需 planning agents/skills/templates；Research、Spec、Interface 和 Handoff 共用 `runStage()`。
- 实现 Architecture lane、Behavior QA、document review、Completion Audit 和 non-Git bounded backup。
- 实现 `/pilot stage <id>` 与高频 `/pilot review`；不增加其余 convenience aliases。

### Phase 3：Worktree Solo

- 实现 preferred/required isolation、dirty scope 判定、approved base、ephemeral commit、target drift check 和 unstaged diff integration。
- Worktree-local review 后对 target 运行 global verification 和 Completion Audit。
- Required isolation 失败进入 `needs_decision`；preferred downgrade 必须重新授权。

### Phase 4：Legacy Cutover

- 完成 Pilot 对 mode、activation、Auxiliary router、planning、primary/worktree solo 的 parity tests。
- 更新 settings/snapshot/README/CAPABILITIES/statusline/auxiliary 接线。
- 删除 standalone mode、整个 docsflow package、旧 chains/status/config 和所有 `/docsflow` 注册。
- 验证 clean install 默认 AUTO、legacy mode migration、headless pending-migration、`/pilot`、`/mode`、未知 `/peer`/`/docsflow` 以及 legacy data 不被删除。

### Phase 5：Git Checkpoint

- Commit Gate 绑定 staged fingerprint、approved intent 和新鲜验证证据。
- Push Gate 额外绑定 remote、branch/upstream 和待推送 commit range。
- payload 变化使旧确认失效；禁止 force push；仍由 `git_finalize` 执行普通 commit/normal push。

### Phase 6：Worktree Team

- 只支持 clean target、两个以上独立 lanes、non-overlap ownership、每 lane worktree/profile/scope/validation 和 single Integrator。
- Lane-local evidence、unstaged diff integration、global Review Kernel 和 Completion Audit 全部通过才完成。
- Team 条件失败退到已重新授权的 `primary-solo` 或 `worktree-solo`。

### Phase 7：Background 与 Future Goal

- 修复 `pi-subagents` async `typebox/compile` 依赖后再实现 wake/resume/cancel 和跨 session worker runtime。
- Future Goal automation 只能复用同一 Router、Planner、Bundle、Worker、Review Kernel 和 Git Gates，不建立第二套引擎。

该阶段不阻塞 foreground Pilot 价值。

## 19. 验收场景

### 19.1 Activation + Mode Routing

- Fresh install AUTO：Pilot 自动 active，连续 prompts 分别显示 `AUTO→ASK|PLAN|EDIT`。
- `/mode ask|plan|edit`：Pilot 自动 inactive，普通 prompt 不调用 classifier/subagent，主 Pi 使用现有 direct mode。
- 锁定模式 `/pilot` 后 manual active；在 PLAN→EDIT 切换时保持，`/pilot off` 后恢复 direct mode。
- AUTO 下 `/pilot off` 被拒绝并提示切 mode；从 AUTO 切到锁定模式只在 idle/paused/Gate 生效，运行中要求 wait、pause 或 cancel。
- Auxiliary `pilot_router` 继承 default 或使用 task override；usage 只记一次，failure/invalid/low confidence -> PLAN。
- 同一 prompt 不得同时启动主模型与 Pilot child；legacy EDIT 未迁移前不被静默解释为新 manual lock。

### 19.2 Direct 与 Pilot EDIT

- Manual EDIT + Pilot inactive：主 Pi 可以直接写，且不生成 Pilot Bundle、Gate、review 或 receipt。
- Pilot active EDIT/AUTO→EDIT：进入 adaptive preflight；未 Authorize 前无项目写入。
- Tiny Pilot task 不触发 broad research/interface，使用 `primary-solo` + targeted verification + fresh review。

### 19.3 Worktree Solo

- Git complex/high-risk、long-running、dependency/migration/broad refactor 选择 `worktree-solo`，并绑定 isolation reason。
- Related dirty changes 使用 `primary-solo`；unrelated dirty 只有在证明 scope non-overlap 后才允许 worktree。
- Required isolation unavailable 或 target baseline drift 进入 `needs_decision`，不静默降级/集成。
- Ephemeral commit 不 push；`git apply --check` 后把 diff 以 unstaged changes 应用，再运行 target verification 和 Completion Audit。

### 19.4 Complex / High-risk

- 自动识别 research、architecture、interface 和 QA flags。
- Complex 默认一个 Architect；high-risk 才加入 Critic。
- Handoff 可由 fresh Worker 无隐藏 transcript 执行。

### 19.5 Runtime / Frontend QA

- Stateful/CLI 场景生成 risk-derived adversarial scenarios，最多 2 轮。
- UI 场景生成 Interface Spec，并运行 Playwright、responsive 和可访问性检查。
- QA 只能提交 evidence/findings，修复仍由 Worker 完成。

### 19.6 Independent Stage

- `/pilot stage research` 或 `/pilot review <target>` 可独立运行，不自动生成 Spec、启动 Worker或扩大 review scope。

### 19.7 Non-Git Artifact

- 只允许一个 writer；bounded backup、前后 hash 和 document-specific review 完整。
- 不出现 Git-only 假设，失败后恢复由用户明确选择。

### 19.8 Worktree Team

- Target dirty、ownership overlap、shared central file 或 worktree failure 自动退化为重新授权的 solo topology。
- 每个 writer 位于独立 worktree；shared tree 最多一个 writer。
- Lane commits 不 push/不落目标分支；unstaged diff integration 后运行 global review/QA。

### 19.9 Legacy Cutover

- 最终 packages 以 `pilot` 替换旧 mode/docsflow 项，保留 auxiliary；`/pilot`、`/mode` 和 `pilot_router` 可用。
- `/sidecar`、`/peer`、`/docsflow` 和 standalone mode package 均不存在。
- README、CAPABILITIES、snapshot、status keys 和配置无 docsflow product surface。
- 既有 docsflow 文档与状态未被删除。

## 20. 风险与假设

| 风险 | 状态 | 处理 |
|------|------|------|
| Activation/mode 状态漂移 | Phase 0 Blocker | 只保留 `modePolicy + manualPilotActive`；固定 transitions、session entries 和 status assertions |
| AUTO hook 时序与双启动 | Phase 0 Blocker | 验证 Aux call 后 ASK 放行或 PLAN/EDIT handled；失败则不发布 AUTO |
| Auxiliary bridge 不可用 | Phase 0 Blocker | versioned internal call；disabled/timeout/schema failure -> PLAN，不 silent fallback main |
| Router 误判 | 固有风险 | structured schema、low-confidence -> PLAN；用户切 locked mode 重提，EDIT 仍有 Work Gate |
| Direct EDIT 绕过 Pilot Gate | 已接受 | 只在 Pilot inactive + manual EDIT；HUD 不显示 Pilot，禁止生成虚假 Bundle/receipt/pass |
| Mode 旧语义变化 | 已识别 | fresh default AUTO；legacy config 用 `routingVersion: 1` 一次性迁移，不能静默把旧 EDIT 当人工锁 |
| Planner relay/resume | Phase 0 Blocker | foreground detach/reply + Bundle recovery + stale correlation spike |
| Child 工具不可完全观察 | 架构 Blocker | profile/tool/cwd/scope 强制 + baseline reconciliation；失败则不发布 Work |
| Work Gate TOCTOU | 已控制 | Envelope 绑定 route、artifacts、baseline、topology、profiles、scopes 和 obligations |
| Reviewer tools 过宽 | 已验证 | Pilot 专用 read-only reviewer；QA 可执行但不能 edit/write product source |
| QA 成本膨胀 | 已控制 | risk-triggered scenarios、最多 2 轮，不运行固定全矩阵 |
| 非 Git 部分修改 | 高 | bounded backup manifest + 明确恢复选择 |
| Worktree Solo 集成风险 | 高 | isolation reason、dirty scope proof、ephemeral commit、apply check、target drift、unstaged integration |
| Worktree Team 集成风险 | 高 | clean target、non-overlap、single Integrator、global verification、no-stage/no-commit apply |
| Async runner 依赖故障 | 已验证 | foreground 路径绕开；background 延后 |
| Legacy 切换遗漏 | 已识别 | parity + clean/upgrade install tests；最终无 alias，用户旧数据不删除 |
| 无限 persistence loop | 已控制 | review/QA/root-cause iterations、budget、timeout、decision、exhausted |

## 21. 已确认决策记录

| ID | 决策 |
|----|------|
| D001 | Pilot inactive 时主 Pi 保持 direct ASK/PLAN/EDIT；Pilot active 时主会话只做 ASK responder、UI、Control Plane 和 Gates |
| D002 | 产品与 repo package 名为 Pilot/pilot，唯一产品 namespace 为 `/pilot`；不保留 `/sidecar` 或 `/peer` alias |
| D003 | 改造完成后彻底删除 docsflow package、slash/status/config surface，不保留 alias |
| D004 | 仅把仍需的 docsflow 代码迁入并改名为 Pilot modules；旧 runtime 不保留 |
| D005 | AUTO 自动激活 Pilot 并逐 prompt 路由；ASK/PLAN/EDIT 默认停用 Pilot，并由主 Pi direct 处理 |
| D006 | Statusline 显示 locked mode 或 `AUTO→route`；`pilot` phase 仅在 manual activation 或 active Bundle 时出现 |
| D007 | Pilot package 吸收 `/mode`；迁移完成后删除 standalone mode package |
| D008 | PLAN/EDIT 使用 adaptive planning；tiny 只生成 minimal handoff |
| D009 | Pilot active EDIT 不授权写入；ASK/PLAN 阻止 Work，manual active EDIT 或 AUTO→EDIT 仍需 exact Envelope Gate |
| D010 | Worker fix loop 由 Pilot 控制，直到 pass 或明确 terminal state |
| D011 | 每个 Public Stage 共用 `runStage()`，V1 只保留 generic stage 和 review alias |
| D012 | Review Kernel 默认单审，风险触发 Architecture lane 或 Behavior QA |
| D013 | Git 与非 Git 都支持 completion review；receipt 跨 session 保留 |
| D014 | Commit/push 保留独立人类确认 checkpoint |
| D015 | 复用 pi-subagents，不移植 OMX tmux/team runtime |
| D016 | 这是辅助驾驶，不是完全自动驾驶 |
| D017 | 采用 B\*：Pilot 路由 isolated Planner，主上下文不承载 planning transcript |
| D018 | Planner session 是可丢弃缓存，Canonical Work Bundle 是唯一 durable truth |
| D019 | 主模型 Planner fallback 仅在 relay/resume 不可用且用户明确同意时允许 |
| D020 | 采用聊天式 UX：mode badge + compact Pilot phase + on-demand Manager，无常驻 dashboard |
| D021 | Work Gate 使用 TUI Authorize 或 headless exact digest；payload 变化使授权失效 |
| D022 | Planner 回答用原生 editor；pause/resume 是输入路由逃生口 |
| D023 | 所有 parallel writers 必须使用独立 worktrees；shared tree 始终最多一个 writer |
| D024 | Team 仅在 clean target、独立 lanes、non-overlap 和 single Integrator 条件全满足时启用 |
| D025 | Git Bundle 位于 `<git-common-dir>/pilot/runs/`，非 Git 位于 `<cwd>/.pi/pilot/runs/`；正式 docs 仅显式或按项目规范发布 |
| D026 | 使用 tiny/standard/complex/high_risk 四级；planning review 最多 2 轮，work review 最多 3 轮，QA 最多 2 轮 |
| D027 | 普通修复优先 resume 原 Worker；仅 resume/transport 失败时 fresh handoff，authority 变化需重授权 |
| D028 | Workflow review 默认只覆盖授权 delta；显式 `/pilot review <target>` 才审其他修改 |
| D029 | Git intent 以 approved goal/scope/non-goals/acceptance/decisions 为准，Handoff 不是需求权威 |
| D030 | Pilot fresh default 为 AUTO；legacy mode config 必须经 `routingVersion: 1` 迁移，不能静默继承旧 EDIT 语义 |
| D031 | 锁定模式下 `/pilot` 手动激活 session；manual activation 跨锁定模式保持，`off`/AUTO退出只在 idle/paused/Gate 生效 |
| D032 | AUTO Router 复用 Auxiliary `pilot_router` scene；默认继承 auxiliary.default，可单独覆盖，不另建模型 runtime |
| D033 | Solo/team worktrees 允许 ephemeral commits 作为 transport artifacts，禁止 push；target 只接收 checked unstaged diff，不自动 stage/commit |
| D034 | Solo 使用 primary/worktree 判定：complex/high-risk/long-running 等触发 worktree，required isolation 失败进入 decision |
| D035 | Manual EDIT + Pilot inactive 允许主 Pi 直接写入，明确不提供 Pilot Gate/review/receipt 保证 |

## 22. 剩余实现问题

1. Auxiliary 与 Pilot 的 versioned internal call transport 采用 event/service 哪种形式；必须复用同一 Runtime/usage 链。
2. Phase 0 中 `input` hook 能否在 Auxiliary call 后可靠放行 ASK 或 `handled` PLAN/EDIT。
3. Pilot publish action 使用 Manager 选择还是 `/pilot stage publish`；默认不发布已冻结。
4. Worktree cleanup 的显式 UX 与保留期限；默认不自动删除已冻结。
5. Legacy docsflow data 是否需要一次性显式 import；无论是否提供都不得自动删除或继续运行旧 workflow。
6. Background runtime 何时修复并启用；不阻塞 foreground Pilot。

当前用户侧架构决策已冻结；下一步应先完成 Phase 0 spike 设计与验收命令，再请求实施批准。
