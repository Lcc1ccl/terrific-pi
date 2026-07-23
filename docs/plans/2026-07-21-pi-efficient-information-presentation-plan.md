# Pi 高效信息呈现完整实施方案

> 日期：2026-07-21
>
> 历史状态：本文件记录 2026-07-21 的 fork 组合方案。
>
> 2026-07-22 更新：该方案已由 `extensions/presentation` 的受控 native render compatibility layer 取代；`pi-tool-display`、`pi-compact-transcript` 不再是运行时依赖。当前实现与验收见 [2026-07-22-presentation-remediation-design.md](./2026-07-22-presentation-remediation-design.md) 与 package tests。
>
> 目标：在不复刻 Proma 三栏布局的前提下，用 pi 可定制能力尽可能复刻 Claude Code 的低噪音过程流，并保留 Proma 的任务里程碑、文件产物可见性和可回溯性
>
> 范围：外部 pi package 组合、`taskboard` 适配、一个新的 presentation 编排插件、配置快照/离线迁移和集成验证

## 1. 执行结论

以下为历史决策记录，保留用于说明为何当时采用 fork；不应再作为当前安装或实现指南：

```text
pi-tool-display@0.5.0 的薄补丁 fork
  └─ 负责 edit/write 的丰富 diff、展开态和原生 user message box

pi-compact-transcript@0.6.2 的薄补丁 fork
  └─ 负责工具单行化、连续同类合并、tool turn 动作摘要、Ctrl+O 回退原渲染

extensions/taskboard
  └─ 只负责多步任务目标、步骤、等待/阻塞、验证，不再重复工具活动

extensions/presentation（新增）
  ├─ 注入最终答案表达契约
  ├─ 渲染 workspace / model / mode / fast / skill 系统条
  └─ 自动生成文件产物回执

extensions/statusline
  └─ 继续只负责 model/context/cost/mode/state 等系统运行态；通过配置去掉重复工具计数
```

核心决策：

1. **不做 Proma 三栏、右侧文件树或 TUI split layout。**
2. **不从头实现 compact tool renderer。** 社区能力已超过 80%，按仓库规则直接复用。
3. **不强制最终答案走 `deliver_answer`/结构化工具。** 最终答案继续使用原生 assistant Markdown，避免被 compact tool renderer 当成工具行压缩。
4. **不在 `message_end` 改写模型答案。** 只在 `before_agent_start` 注入短契约，保留模型原文与审计一致性。
5. **不把工具历史塞进 statusline。** statusline 只显示当前系统态；历史动作由 compact transcript 留一行摘要。
6. **插件层先达到目标效果。** pi core 的公开 transcript decorator/group API 作为上游长期替代，不阻塞首版。

## 2. 用户可见目标态

### 2.1 分析任务

```text
● WORKSPACE · terrific-pi · main · rules 2
◆ 4× read extensions/taskboard/... {126 lines · 2s}
◆ grep "tool_execution" extensions {31 lines}
Read 4 files, ran 1 other tool · 5s

结论：当前最有效的改法是……

依据：……

| 方案 | 效果 | 边界 |
|------|------|------|
| ...  | ...  | ...  |
```

默认看不到：thinking 正文、完整工具输出、逐步“我接下来要做什么”、重复 token/cost 说明。

### 2.2 多文件实现任务

```text
● 修复用户表格 · 2/4 · 当前：接入 API · 18s
◆ 3× read src/users/... {244 lines · 3s}
◆ edit user-table.tsx {+93 -13}
◆ write deepclaude.ts {+47 -0}
◆ bash {18 lines · 4s}
Edited 2 files, read 3 files, ran 1 command · 28s
Files 2 · M user-table.tsx +93/-13 · A deepclaude.ts +47

结论：用户表格已接入 DeepClaude，并通过目标测试。
验证：npm test，42/42 通过。
风险：……
```

`Ctrl+O` 后恢复 pi 原始/`pi-tool-display` 的完整 read、bash、diff 和 process 细节。

### 2.3 错误与阻塞

```text
◆ bash {command failed · 12 lines · 3s}
Ran 2 commands, 1 failed · 6s
! Blocked · 2/4 · Need: 需要确认生产环境变量名
```

失败工具必须独占可见行；不得被 burst 合并隐藏。任务未验证时不得显示 completed。

## 3. 成功标准

| ID | 可测标准 |
|----|----------|
| S1 | 默认折叠态下，每个工具 burst 最多占 1 行；同一 tool turn 内相邻同名工具合并为 `N×`，每个工具块首行恰有一个空行 |
| S2 | `turn_end` 仅在某一业务类别聚合多个操作时保留 1 条动作批次摘要；单次、各类别一次、空 turn 和元数据工具不产生摘要 |
| S3 | `Ctrl+O` 展开后可查看原始工具细节，信息不得因 compact 展示丢失 |
| S4 | `hideThinkingBlock=true` 时不显示 thinking 内容、thought ticker 或 `Thinking...` 占位正文 |
| S5 | 有 `process_update` 时，HUD 默认只显示目标/进度/当前步骤/时间/阻塞；不重复当前工具行 |
| S6 | 每个包含成功文件变更的 tool turn 最多生成 1 条 UI-only 文件批次回执；失败写入不计入 |
| S7 | 系统条只在离散状态变化时出现；session restore/reload 不重复追加 |
| S8 | **提示驱动/人工验收：**最终答案第一句直接回答用户；不复述 HUD、动作摘要和文件回执 |
| S9 | 默认 transcript 高度较当前基线在标准实现 fixture 中下降至少 60% |
| S10 | 80、120、160 列下所有 collapsed 行不溢出、不错误换行 |
| S11 | TUI-only presentation entries 不进入 provider context，也不计入 `/context` 主消息体 |
| S12 | print/json/rpc 模式不崩溃；无 TUI 时退化为原生文本/事件流 |

## 4. 明确非目标

- 不实现 Proma 左会话栏、右文件栏或浮动侧栏。
- 不做 IDE 文件浏览器、项目索引器或 workspace watcher 服务。
- 不改模型推理协议，不截断发送给模型的工具结果。
- 不建立第二套任务状态机；任务状态继续由 `taskboard` 唯一负责。
- 不建立第二套 footer；系统常驻态继续由 `statusline` 唯一负责。
- 不把外部 package 源码复制进本仓重新维护。
- 不让 presentation 插件绕过 `/mode`、安全网或工具权限。
- 不把 npm 外部包 vendoring 进离线包；目标机仍按现有规则首次联网拉取 pin 包。

## 5. 已验证能力与生态决策

### 5.1 pi 官方能力

| 能力 | 证据 | 结论 |
|------|------|------|
| 覆盖内置工具并保留执行 | `registerTool()` 同名覆盖；render slot 可独立继承 | 可只改显示，不改模型上下文 |
| compact/expanded 双态 | `renderResult(..., { expanded })` + `app.tools.expand` | `Ctrl+O` 可作为统一下钻入口 |
| 完全自绘工具行 | `renderShell: "self"` | 可去除大背景 box |
| UI-only transcript entry | `appendEntry()` + `registerEntryRenderer()` | 系统条/文件回执不进入 LLM |
| 全局工具展开状态 | `getToolsExpanded()` / `setToolsExpanded()` | process HUD 可跟随 `Ctrl+O` |
| 最终提示约束 | `before_agent_start` 可修改 system prompt | 可实现答案契约，无需改写答案 |
| 生命周期 | `turn_end`、`before_agent_start`、`agent_settled`、tool events | `turn_end` 可在下一次模型调用前追加动作批次；`agent_settled` 只做最终状态/补充对账 |
| 跨插件通信 | `pi.events` | mode/fast 可发薄事件给 presentation |

pi 当前 `ToolExecutionComponent` 为每个 tool call 单独向 `chatContainer` 添加组件，因此纯公开 API 不能真正把多条历史 entry 合成一个宿主组件；`pi-compact-transcript` 通过当前 TUI prototype patch 实现 burst 合并。此方式属于 best effort 私有边界，需要版本 pin 和集成测试。

另一个已验证顺序约束：`agent_settled` 发生在最终 assistant message 已持久化/渲染之后，公开 `appendEntry()` 只能追加到答案后方。因此常规动作摘要与文件批次必须在 tool-bearing `turn_end` 落盘；`agent_settled` 只允许追加确实无法提前发现的补充 reconciliation receipt。

### 5.2 社区方案对照

| 方案 | 覆盖 | 缺口/风险 | 决策 |
|------|------|-----------|------|
| `pi-compact-transcript@0.6.2` | 单行工具、同类 burst 合并、失败独占、run summary、展开回原 renderer、custom tools | 使用 TUI 私有 prototype；默认 thought ticker；`process_update` 会被通用压缩；summary 在 `agent_end` | **主底座，做薄补丁 fork** |
| `pi-tool-display@0.5.0` | edit/write 丰富 diff、pending preview、宽度适配、user message box、per-tool ownership | 不合并历史工具；thinking labeling 与 MCP decoration 当前无法关闭；全工具 ownership 会影响展开策略 | **辅助底座，薄补丁后只接管 edit/write 与 user box** |
| 官方 `built-in-tool-renderer.ts` / `minimal-mode.ts` | 展示标准覆盖方式 | 示例级，不做 burst、summary、artifact ledger | 作为 API 参考，不新建同类包 |
| `pi-compact-tools` | 七个内置工具 compact renderer | 旧 `@mariozechner/*` namespace；不合并、不总结 | 不使用 |
| `pi-tool-codex` | 与 tool-display 高度重叠 | 仓库当前不可直接拉取；功能重复 | 不使用 |

外部源码基线：

- [`pi-compact-transcript` @ `abf969c`](https://github.com/avhagedorn/pi-compact-transcript/blob/abf969c69052cc69419a806fddc5b350ee7e57e0/extensions/compact-transcript.ts#L454-L627)：burst 合并与 ToolExecution prototype patch。
- [`pi-compact-transcript` summary](https://github.com/avhagedorn/pi-compact-transcript/blob/abf969c69052cc69419a806fddc5b350ee7e57e0/extensions/compact-transcript.ts#L743-L861)：UI-only summary 与 `agent_end` 触发。
- [`pi-tool-display` @ `91cef75`](https://github.com/MasuRii/pi-tool-display/blob/91cef7580078371f8dc49a8607222807ad6a424d/src/tool-overrides.ts#L1579-L1845)：按 tool ownership 注册 renderer，write 前读取旧内容并渲染 diff。
- [pi tool renderer middleware issue #3071](https://github.com/earendil-works/pi/issues/3071)：未来公开、可组合 renderer API 的跟踪入口。

## 6. 模块职责

### 6.1 `pi-compact-transcript`（外部 pin/fork）

负责：

- collapsed tool 行。
- 相邻同名工具 burst 合并。
- 运行/成功/失败状态符号和耗时。
- 每个含业务工具结果的 tool turn 动作批次摘要。
- collapsed 与原 renderer expanded 的切换。

不负责：

- 任务步骤。
- 文件产物账本。
- system/model/mode 条。
- 最终答案格式。

### 6.2 `pi-tool-display`（外部 pin/fork）

只接管：

- `edit`、`write` renderer。
- pending edit/write preview。
- expanded diff。
- native user message box。

不接管：

- `read`、`grep`、`find`、`ls`、`bash`，让展开态继续使用 pi 原生 renderer。
- `process_update` 和其他自定义工具。
- thinking block 标记和 MCP 自动 decoration（由薄补丁配置关闭）。
- transcript burst 或 run summary。

### 6.3 `taskboard`（现有插件）

继续负责：

- 三步以上任务的目标、步骤、状态、计时、usage。
- waiting/blocked/interrupted/completed 语义。
- `process_update` 历史 receipt；当前 snapshot 与可见 HUD 相同时隐藏 collapsed receipt，后续里程碑或 HUD 收起后恢复。
- full/expanded runtime panel。

新增边界：

- `activityMode: "full" | "task" | "off"`。
- 推荐 `task`：collapsed HUD 不显示工具活动；full/expanded 仍显示。
- presentation 启用时，模型不向 `process_update.artifacts` 重复提交普通 `file` artifact；测试、截图、URL、报告仍允许。

### 6.4 `presentation`（本仓新增插件）

一个关注点：**把不属于 tool/process/footer 的用户可见信息组织成低噪音 transcript。**

负责：

- 答案表达契约。
- workspace 与离散系统事件条。
- 文件变更自动回执。
- `/presentation` 配置管理与运行诊断。

不负责：

- tool 执行或 tool renderer。
- todo 状态。
- footer。
- 变更最终 assistant message。

### 6.5 `statusline`（现有插件）

不新增业务代码。通过默认配置移除 `toolActivity`，保留：

- model、path、branch、branch diff。
- context、token、cache、cost。
- session、mode、fast、environment、progress、state、duration。

`environment` 继续在每次 `before_agent_start` 反映动态 context files/skills/active tools；一次性 workspace 条不复制这些易过期计数。

`progress` 只承载没有专用 transcript/HUD 的扩展状态；`process`、`mode`、`fast` 等继续走现有 exclude。

## 7. 数据流

```text
user input
  │
  ├─ presentation/input ───────────────► validated skill invocation entry
  ├─ presentation/before_agent_start ─► workspace entry + per-run answer contract
  ├─ taskboard/before_agent_start ──► task tombstone / passive stage
  │
  ▼
assistant/tool stream
  ├─ pi-compact-transcript ────────────► collapsed tool rows / burst
  ├─ pi-tool-display ──────────────────► edit/write expanded renderer
  ├─ taskboard ─────────────────────► task HUD
  ├─ presentation artifact tracker ────► successful file mutation journal
  └─ statusline ───────────────────────► current runtime footer
  │
  ▼ tool-bearing turn_end（下一次模型调用前）
  ├─ compact transcript ───────────────► optional multi-operation summary + burst boundary
  └─ presentation ─────────────────────► one file-batch receipt if changed
  │
  ▼
assistant final Markdown
  └─ result first; no repeated process/tool/file narration
  │
  ▼ agent_settled
  ├─ taskboard ─────────────────────► waiting/interrupted/completed settle
  └─ presentation ─────────────────────► only supplemental Git reconciliation if needed
```

## 8. 配置契约

### 8.1 `settings.json`

推荐展示基线：

```json
{
  "hideThinkingBlock": true,
  "outputPad": 0,
  "quietStartup": true,
  "packages": [
    "git:git@github.com:Lcc1ccl/pi-tool-display@8dd8fcaa7a3307abac5ee05f735615d4eae394b1",
    "git:git@github.com:Lcc1ccl/pi-compact-transcript@1bad0d81c38ca0821710e466a8e76928bdc326ef",
    "../vendor/terrific-pi/extensions/presentation"
  ]
}
```

包顺序要求：

1. `pi-tool-display` 先注册 edit/write renderer。
2. patched compact transcript 后 patch transcript component，expanded 时回落到当前 renderer。
3. `presentation` 可在任意现有 terrific 插件之后加载，但建议放在 `taskboard` 后，便于命令/能力诊断。

当前两个 fork 以 SSH git exact pin 安装：目标机需具备 GitHub SSH 访问权限（或将 fork 改为公开后改用 HTTPS pin）。上游若合并并发版，再分别替换为精确 npm pin。

### 8.2 `terrific.json`

```json
{
  "taskboard": {
    "defaultViewMode": "compact",
    "activityMode": "task"
  },
  "presentation": {
    "enabled": true,
    "workspace": true,
    "systemEvents": true,
    "artifacts": true,
    "maxExpandedArtifacts": 8
  }
}
```

配置失败策略：

- 缺失或单个字段非法：回退 package default。
- 根 JSON 损坏或 `presentation` 不是对象：fail closed（`enabled=false`）、只通知一次、不写回、不覆盖兄弟段。
- `/presentation` 写配置沿用本仓临时文件 + rename + 保留兄弟段规范。

### 8.3 `pi-tool-display/config.json`

推荐 ownership：

```json
{
  "debug": false,
  "registerToolOverrides": {
    "read": false,
    "grep": false,
    "find": false,
    "ls": false,
    "bash": false,
    "edit": true,
    "write": true
  },
  "customToolOverrides": {},
  "enableNativeUserMessageBox": true,
  "enableThinkingLabels": false,
  "decorateMcpTools": false,
  "readOutputMode": "summary",
  "searchOutputMode": "count",
  "mcpOutputMode": "hidden",
  "previewLines": 8,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "summary",
  "bashCollapsedLines": 10,
  "diffViewMode": "auto",
  "diffIndicatorMode": "bars",
  "diffSplitMinWidth": 120,
  "diffCollapsedLines": 24,
  "diffWordWrap": true,
  "showTruncationHints": true,
  "showRtkCompactionHints": false
}
```

read/search/bash 字段保留为兼容值，但 ownership=false 时不生效。`enableThinkingLabels` 与 `decorateMcpTools` 是 Phase 1 对 tool-display 增加的薄配置；stock 0.5.0 尚不支持，未完成补丁前不得宣称“只接管 edit/write + user box”。

### 8.4 patched compact transcript 配置

在上游配置基础上补：

```json
{
  "enabled": true,
  "summaryScope": "tool-turn",
  "showThoughtTicker": false,
  "bashPreview": "name",
  "pathMode": "workspace-relative",
  "preserveTools": ["process_update"],
  "excludeFromSummary": ["process_update"]
}
```

语义：

- `summaryScope=tool-turn`：每个 `turn_end` 断开 burst；仅当 read/edit/command/other 中至少一类聚合多个操作时落一条摘要。单次调用与各类别一次不复述已可见工具行；摘要仍在宿主继续下一次模型调用前完成。
- `showThoughtTicker=false`：hidden thinking 不泄露标题行。
- `bashPreview=name`：collapsed 仅显示 `bash` 与结果/耗时；命令在 expanded 查看。
- `pathMode=workspace-relative`：工作区内相对路径；外部路径只显示 basename。
- `preserveTools`：`process_update` 使用自己的 borderless renderer。
- `excludeFromSummary`：元数据工具不计作业务工具。

## 9. Presentation 数据契约

### 9.1 UI-only entry

```ts
type PresentationTone = "info" | "success" | "warning" | "error" | "muted";

type PresentationSystemEntry = {
  version: 1;
  kind: "workspace" | "model" | "thinking" | "mode" | "fast" | "skill";
  tone: PresentationTone;
  label: string;
  message: string;
  detail?: string;
  timestamp: number;
  dedupeKey: string;
};
```

entry type：`presentation-system-v1`。

collapsed：一行；expanded：可附时间和 detail。entry 不进入 LLM context。

### 9.2 跨插件事件

```ts
type PresentationEvent = {
  version: 1;
  kind: "mode" | "fast";
  source: "user" | "startup" | "restore" | "system";
  tone: PresentationTone;
  label: string;
  message: string;
  dedupeKey: string;
  presentationHandled?: boolean;
};
```

事件名：`terrific-pi:presentation:event-v1`。

规则：

- `mode`、`fast` 只在用户显式修改成功后发送。
- startup/restore 事件默认不落 transcript。
- presentation 在 500ms 内按 `dedupeKey` 去重。
- presentation 仅在实际追加可见 TUI system entry 后把同一 event object 的 `presentationHandled` 设为 `true`；mode/fast 据此省略自身 toast。presentation 缺失、关闭、print 模式或去重时不确认，来源插件保留原反馈。
- model/thinking 不经过事件总线，presentation 直接监听官方事件并以 100ms debounce 合并。

### 9.3 Artifact receipt

```ts
type FileArtifact = {
  path: string;
  operation: "added" | "modified" | "deleted" | "unknown";
  additions?: number;
  deletions?: number;
  sources: string[];
  preExisting?: boolean;
};

type ArtifactReceipt = {
  version: 1;
  turnIndex: number | "settled-reconcile";
  files: FileArtifact[];
  successfulWrites: number;
  failedWrites: number;
  gitReconciled: boolean;
  startedAt: number;
  flushedAt: number;
};
```

entry type：`presentation-artifacts-v1`。

collapsed：

```text
Files 4 · M a.ts +12/-3 · A b.ts +41 · D old.ts · +1 more
```

expanded：每文件一行，最多 `maxExpandedArtifacts`；超出显示 `+N more`。不保存文件正文、bash command、URL query、secret 或绝对外部路径。

## 10. Artifact 归因算法

### 10.1 Settled batch 与 turn flush 边界

- 在 `before_agent_start` 建立 settled-batch journal；不要在 `agent_start` 重置，以覆盖 retry/auto-compact。
- 每个带 toolResults 的 `turn_end` 把该 turn 的成功文件变更聚合为一条 receipt，并把 Git baseline 前移到 flush 后状态。
- `agent_settled` 只对账尚未被显式工具捕获的 Git 变化；有补充时追加 `turnIndex="settled-reconcile"` receipt，无补充则不落条。
- 运行中的 steer/followUp 可能加入同一 settled batch，但仍按各自 tool turn 分批，不宣称“一条用户输入等于一个 journal”。
- 新的 `before_agent_start` 会先丢弃不完整的纯内存状态，再建立新 baseline。

### 10.2 显式文件工具

| 工具 | 开始时 | 成功结束时 | 失败时 |
|------|--------|------------|--------|
| `edit` | 保存 workspace-safe path | 从 `result.details.patch/diff` 计算精确 `+/-`；标 modified | 只增加 failedWrites，不记文件成功 |
| `write` | 读取是否存在及旧文本（仅 workspace 内普通文件，设大小上限） | 与新文本做 line diff；不存在标 added | 同上 |
| 其他自定义写工具 | 只有注册了 presentation adapter 才跟踪 | 使用 adapter 返回的 artifact | 默认不猜 |

### 10.3 Git reconciliation

在 Git workspace：

1. `before_agent_start` 记录 `git status --porcelain=v2 -z`、dirty path 的基线 numstat/存在性和流式 SHA-256；hash 不保存文件正文，也不受行数相同影响。
2. 每个 tool-bearing `turn_end` 取新状态、flush 差异并把它设为下一 turn baseline；`agent_settled` 做最后一次补充对账。
3. 显式工具 journal 为权威。
4. 新增的 dirty/deleted/untracked path 作为 bash/generator 补充 artifact。
5. 请求前已 dirty 的 path 只有 hash/存在性变化时才标 `preExisting=true`；无法精确归因时不伪造 `+/-`。
6. Git 命令失败时 `gitReconciled=false`，仍输出显式工具 artifact。

在非 Git workspace：只追踪显式 edit/write 与注册 adapter；不扫描/哈希整个工作区，不声称捕获 bash 的隐式文件变化。

### 10.4 安全边界

- workspace 外路径只显示 basename。
- symlink 解析后再判断 workspace 边界。
- baseline 单文件读取设大小上限；二进制文件只记 operation，不计算行数。
- 不运行 watcher，不保留文件内容到 session。
- 用户并发修改与 tool 修改无法区分时标 `preExisting/unknown`，不虚报精确统计。

## 11. 答案表达契约

presentation 在**每次** `before_agent_start` 返回带短规则的 `systemPrompt`；只在该次 chained prompt 字符串内检查并去重，不能依赖 session 级“一次注入”，因为下一次运行会从 base prompt 重建：

```text
Presentation contract:
- The runtime already displays tool calls, task progress, and changed files. Do not narrate or repeat them.
- Start the final response with the result, decision, or direct answer.
- Add only the evidence, verification, risks, and next action the user needs.
- Use a table only when comparison is materially easier than prose.
- If the user explicitly asks for a walkthrough, explanation, report, or raw command output, honor that request instead.
```

约束：

- 不解析或强制改写 final Markdown。
- “结论前置/不复述”是提示驱动目标，自动化只能验证 prompt 注入；最终效果必须用固定 fixture 人工验收。
- 不要求固定标题；短任务允许一两段自然语言。
- 不重复 global `AGENTS.md` 已覆盖的安全/验证规则。
- 用户显式要求详细解释时，详细回答优先。

## 12. 系统条规则

### 12.1 Workspace

首次 `before_agent_start`，若当前 branch 没有相同 workspace entry：

```text
● WORKSPACE · terrific-pi · main · rules 2
```

- `quietStartup=true` 后由此替代冗长 startup header。
- reload/resume/tree restore 不重复追加。
- branch 不可用时省略，不显示 `unknown`。

### 12.2 Model + thinking

- `model_select.source=restore` 不落条。
- 用户 `/model`、cycle、profile apply 后，将 100ms 内 model/thinking 事件合并：

```text
● Model → grok/grok-4.5 · thinking max
```

- 只有 thinking 改变时：`● Thinking → high`。
- 同一最终 model/thinking fingerprint 不重复。

### 12.3 Mode / fast

由现有插件显式 emit：

```text
● Mode → PLAN · read-only
● Fast → ON · active
● Fast → ON · waiting for compatible GPT model
```

只记录用户动作，不记录每次 `before_agent_start` refresh。

### 12.4 Skill

presentation 在 `input` 收到 `/skill:<name>` 时，用 `pi.getCommands()` 校验该名称确为当前可调用的 `source="skill"` 命令；校验成功后立即追加：

```text
● Skill(foo) · invoked
```

这不依赖后续 `before_agent_start`，因此 queued steer/followUp 不会留下 pending 状态。只覆盖显式 skill command；不推断模型是否“自动使用”某个 skill。

## 13. 分阶段实施

## Phase 0：兼容性与视觉基线

### 任务

1. 在临时 `PI_HOME` 安装：
   - `npm:pi-tool-display@0.5.0`
   - `npm:pi-compact-transcript@0.6.2`
2. 固定 pi 基线版本（当前开发环境 `0.80.10`）。
3. 记录 6 个 fixture 的原始 TUI transcript：分析、read burst、edit/write、bash error、process task、reload/resume。
4. 验证 load order：tool-display 先、compact transcript 后。
5. 确认 compact transcript 缺口：thought ticker、`process_update` 通用压缩、`agent_end` 摘要顺序/重复、bash command 暴露、prototype 卸载不完整。
6. 确认 tool-display 缺口：thinking labeling 和 MCP 自动 decoration 当前无关闭配置。

### 产物

- `docs/plans/fixtures/presentation/`：去 ANSI 或可审计的 TUI capture。
- compatibility note：pi/package/version/load order。

### Gate

- 两个 package 能在 pi 0.80.10 加载。
- `Ctrl+O` 能恢复 renderer。
- 缺口可由 Phase 1 的薄补丁覆盖，否则回退到“tool-display + presentation summary，不做 burst”。

## Phase 1：两个 renderer package 的薄补丁 fork

### 1A. Compact transcript

基于 `abf969c69052cc69419a806fddc5b350ee7e57e0`：

1. 增加配置读取与校验。
2. 将 summary 从 `agent_end` 改到 `turn_end`；仅某一业务类别聚合多个操作时落条，同时断开跨 turn burst，并让每个工具块首行恰有一个空行。
3. `preserveTools` 走原 renderer；默认包含 `process_update`，且不消耗下一 compact 工具块的首行间距。
4. `excludeFromSummary` 不参与 toolCount/categories；默认包含 `process_update`。
5. 增加 `showThoughtTicker=false`。
6. 增加 workspace-safe path formatter。
7. 增加 `bashPreview=name`。
8. edit 成功时读取 `result.details.diff`，collapsed 显示 `+/-`。
9. 保存被 patch 的 `ToolExecutionComponent`/`AssistantMessageComponent` 原始 property descriptor；reload/disable 时恢复 prototype、停止 timer、清理 symbol/global state。
10. 保持上游 graceful fallback：私有字段不存在时回落原 renderer。

### 1B. Tool Display

基于 `91cef7580078371f8dc49a8607222807ad6a424d`：

1. 增加 `enableThinkingLabels` 配置，false 时不注册 `message_update`/`message_end`/`context` thinking handlers。
2. 增加 `decorateMcpTools` 配置，false 时不拦截 `registerTool`、不扫描或改写 MCP/custom tool metadata。
3. 保留现有 built-in ownership、edit/write renderer、user box 与 reload cleanup。
4. 配置 modal/show 输出上述开关的 effective 值；默认值保持上游兼容，本仓配置显式设 false。

### 测试

- 同一 turn 连续同名工具合并；不同工具或 `turn_end` 断 burst。
- 每个工具块首行一个空行；burst 代表行继承首行间距；live 与 hydrated history 一致。
- 失败工具解除 hidden 并独占红行。
- process_update preserve/exclude，且不吞掉下一 compact 工具块的间距。
- 单次及各类别一次无 summary；某类别多次时最多一条 summary；无工具/metadata-only turn 无 summary。
- 有效 summary entry 在下一 turn `message_start` 前已经 append。
- hidden thinking 不出现 ticker。
- workspace 外路径仅 basename。
- bash collapsed 不出现原命令；expanded 出现。
- edit diff stats。
- tool-display 两个关闭项为 false 时不注册 thinking handler/MCP interceptor。
- 移除 package 后 `/reload` 恢复原 prototype/renderer，无旧 timer 或 symbol state。

### Gate

两个 patch 都有独立测试；diff 只围绕配置、生命周期和格式，不复制/重写执行逻辑。优先提交上游 PR；未发布前分别 pin fork commit。

## Phase 2：引入 external package 与展示配置

### 本仓与本机配置改动

- 先更新实际 `~/.pi/agent/settings.json`，加入两个真实 fork commit pin 与本地 presentation path。
- 更新 `agent/required-external-packages.json`（新增，供 pack/install 合并 required pins）。
- 更新 `agent/settings.packages.example.json`。
- 运行 `SNAPSHOT_ONLY=agent ./scripts/snapshot.sh` 生成 `snapshot/agent/settings.json`，禁止手改后再被 snapshot 覆盖。
- 新增 nested external config 快照（见 Phase 7）。

### 行为

- pin patched tool-display commit（基线 0.5.0）。
- pin patched compact transcript commit（基线 0.6.2）。
- tool-display 只拥有 edit/write，不标记 thinking、不装饰 MCP/custom tools。
- `hideThinkingBlock=true`、`outputPad=0`、`quietStartup=true`。

### Gate

启动无意外重复 tool owner；process_update 仍使用自身 renderer；expanded read/bash 为 pi 原生，expanded edit/write 为 tool-display。

## Phase 3：Taskboard 去重适配

### 修改文件

- `extensions/taskboard/lib/types.ts`
- `extensions/taskboard/lib/config.ts`
- `extensions/taskboard/lib/render.ts`
- `extensions/taskboard/extensions/taskboard.ts`
- 对应 `tests/{config,render,extension}.test.ts`
- `extensions/taskboard/README.md`

### 改动

1. 新增 `ProcessActivityMode = "full" | "task" | "off"`。
2. `full` 保持当前行为。
3. `task`：
   - 无 snapshot 时不显示 passive activity HUD。
   - collapsed task HUD 不显示 tool activity 第二行。
   - full/`Ctrl+O` panel 仍显示 runtime activity。
4. `off`：任何 HUD 都不显示工具活动，但任务状态仍显示。
5. 默认保持 `full` 兼容独立安装；仓库 snapshot 配置为 `task`。
6. prompt guideline 增加：presentation file ledger 活跃时，不向 process_update 重复提交普通 file artifact。
7. 当前 snapshot 由 HUD 单独展示：相同的 collapsed `process_update` receipt 动态隐藏；展开态、错误、旧里程碑及 HUD 收起后的最终 receipt 保留。

### Gate

- 多步任务仍始终可见 goal/progress/current/time。
- waiting/blocked/verification 不受影响。
- compact transcript 开启后没有重复工具活动行或当前任务进度行。
- standalone taskboard 默认行为不回归。

## Phase 4：Presentation 插件骨架与系统条

### 新增目录

```text
extensions/presentation/
├── package.json
├── README.md
├── tsconfig.json
├── extensions/presentation.ts
├── lib/config.ts
├── lib/types.ts
├── lib/render.ts
├── lib/system-events.ts
├── lib/artifacts.ts
└── tests/
    ├── config.test.ts
    ├── render.test.ts
    ├── system-events.test.ts
    ├── artifacts.test.ts
    └── extension.test.ts
```

### 实现

1. 配置读取/原子写入/坏 JSON fail closed。
2. 注册 `presentation-system-v1` renderer。
3. workspace entry 去重。
4. model/thinking debounce 合并。
5. skill command 记录。
6. 监听 `terrific-pi:presentation:event-v1`。
7. 注入 answer contract。
8. `/presentation`：裸命令/`config` 在 TUI 打开 SelectList 配置菜单，编辑本插件布尔项、expanded artifact 行数、状态诊断与确认 reset；保留显式参数给脚本使用。
9. print 模式 `/presentation` 输出文本诊断；无 TUI 不 append 视觉 entry。

### Gate

- 所有 system entry 都是 `appendEntry`，不是 `sendMessage`。
- branch reload/resume 无重复。
- presentation 关闭时完全退让。
- 不注册任何写/执行 tool，不改变 active tools。

## Phase 5：Artifact ledger

### 修改范围

在 `extensions/presentation/lib/artifacts.ts` 与 extension lifecycle 中实现，不塞入 taskboard state。

### 实现顺序

1. settled-batch journal、turnIndex 与 path sanitizer。
2. edit patch stats。
3. write baseline/diff stats。
4. dirty Git status/numstat/hash baseline 与逐 turn reconciliation。
5. 在 tool-bearing `turn_end` flush 一条 `presentation-artifacts-v1`；`agent_settled` 仅 flush 未捕获补充差异。
6. `Ctrl+O` collapsed/expanded。
7. 非 Git与 pre-dirty 降级语义。
8. 可选 adapter registry，通过 `pi.events` 接收其他可信写工具 artifact。

### Gate

- 成功 edit/write 精确记录。
- 失败不虚报成功文件。
- 用户已有 dirty change 不归零、不覆盖、不错误归属。
- session entry 不含文件正文或绝对外部路径。
- 没有文件变化时不追加空 receipt。

## Phase 6：Mode/Fast 薄事件接线

### 修改文件

- `extensions/mode/extensions/mode.ts`
- `extensions/fast/extensions/fast.ts`
- 两包对应 extension tests

### 改动

- `applyMode(... notify:true)` 成功后 emit presentation event。
- `setPreferred` 用户动作后 emit fast preference/effective event。
- restore、tree、before_agent_start refresh 不 emit。
- presentation 不存在时 event 无副作用。

### Gate

mode/fast 的现有状态、持久化、权限和 header 注入测试全部不变；新增测试只验证事件 payload 与触发边界。

## Phase 7：配置快照与离线迁移

外部 package 配置位于 agent 目录的 nested path，当前 snapshot/install 会按 basename 扁平化，必须先修正。

### 修改文件

- `scripts/snapshot.sh`
- `scripts/pack.sh`
- `scripts/install.sh`
- `snapshot/README.md`
- `agent/required-external-packages.json`
- `snapshot/agent/extensions/pi-tool-display/config.json`
- `snapshot/agent/extensions/pi-compact-transcript/config.json`
- 脚本 smoke tests（新增或现有 shell smoke 入口）

### 改动

1. whitelist 使用相对路径而非 basename。
2. snapshot 创建父目录并保持相对路径。
3. cleanup 按完整相对路径判断，禁止 `..`/绝对路径。
4. manifest 输出 `agent/<relative-path>`，并新增 `external_packages<<` 块，来源为 `agent/required-external-packages.json`。
5. install 还原到 `$AGENT_DIR/<relative-path>`，不再扁平化。
6. `merge_packages` 同时合并 terrific 本地 packages 与 required exact external pins；默认安装和 `RESTORE=1` 都生效，不依赖 snapshot settings 覆盖。
7. secret sanitizer 对 nested 文件同样生效。
8. `RESTORE=1` 覆盖 nested presentation config；默认只 seed missing。
9. 外部 npm/git package 仍不进入 tar；README 明确目标机首次联网安装 pin。

### Gate

在临时 `PI_HOME` + 临时 skills dir 执行：

```bash
./scripts/snapshot.sh
./scripts/pack.sh
FORCE=1 RESTORE=1 PI_HOME=<tmp> AGENTS_SKILLS_DIR=<tmp> ./install.sh
```

验证 nested config 路径、默认/RESTORE 两条路径都合并 exact external pins、auth key 保留和 secret scan。

## Phase 8：文档、登记与默认配置

### 修改文件

- 根 `README.md` 插件表和 external package 说明。
- `docs/CAPABILITIES.md` 能力表、HUD 分层、决策账本和 external pins。
- `extensions/taskboard/README.md`。
- `extensions/presentation/README.md`。
- `agent/terrific.example.json`。
- `snapshot/agent/{settings,statusline,terrific}.json`。

### 默认 statusline

从当前 widgets 中只移除：

- `toolActivity`：compact transcript 已留 live/history。

保留 `environment`，因为它会随每次 `before_agent_start` 的 context files/skills/active tools 动态刷新；workspace 条只显示稳定身份信息。保留 `progress`，避免 docsflow 等没有专用 transcript entry 的状态消失。

### Gate

README 插件表与磁盘一致；CAPABILITIES 记录为什么复用两个社区包、为什么仍需 presentation；所有示例无密钥、无机器绝对路径。

## Phase 9：集成与真机验收

### 自动化矩阵

| 场景 | 断言 |
|------|------|
| 同一 turn 连续 read | 合并为一个 `N× read`；多个 unique file 才生成 summary |
| read→edit→read | 三个 burst；各类别一次不生成 summary |
| edit/write | collapsed 有 path/+/-；expanded 有 rich diff |
| bash success | collapsed 无命令正文；expanded 有命令与输出 |
| bash failure | 红行独占；单次失败不追加复述 summary，多 command 聚合时附 failed 数 |
| process_update | 保留原 receipt；不计入 other tools，也不消耗下一工具块首行间距 |
| multi-turn/retry/compact | burst 不跨 turn；仅某类别多操作时生成 summary；live 与 hydrated spacing 一致 |
| steer/followUp | 可并入同一 settled batch，但按 tool turn flush；skill entry 无 pending 泄漏 |
| simple no-tool answer | 不产生空 summary/空 artifact receipt |
| mode/fast/model | 用户变化有一条系统条；restore 无条 |
| skill command | 一条 invoked；普通 prompt 不误报 |
| dirty Git | baseline hash 检出同行数/同 numstat 内容变化；pre-existing 标记且不错误计算 run delta |
| non-Git | edit/write 可见；bash 隐式变化不虚报 |
| reload/resume/tree | state 重建，无 timer 泄漏、无重复 entry |
| TUI width | 80/120/160 列均不溢出 |
| print/json/rpc | 不调用 TUI-only component factory，不崩溃 |

### 包级命令

```bash
cd extensions/taskboard && npm run check
cd extensions/presentation && npm run check
cd extensions/statusline && npm test
cd extensions/mode && npm run check
cd extensions/fast && npm test
```

按各包实际 script 调整，但每个变更包至少运行其完整 test；presentation/taskboard 必须 typecheck。

### TUI 人工检查

在 80x24、120x40、160x50：

1. hidden thinking。
2. 工具 burst live 更新。
3. `Ctrl+O` 展开/折叠。
4. process compact/full。
5. edit/write diff。
6. 模型/mode/fast 切换条。
7. 文件 receipt。
8. `/reload`、移除 external package 后 `/reload`、`/resume`。
9. 自定义 keybindings 下 expand hint 正确。

可用 `PI_TUI_WRITE_LOG` 或 tmux `capture-pane` 留存归一化证据；不得只凭实现者口头确认。

## 14. 任务依赖与并行策略

```text
Phase 0 compatibility baseline
  ├─ Phase 1 compact-transcript + tool-display patches
  └─ Phase 2 package/config wiring
       │
       ├─ Phase 3 taskboard adaptation
       └─ Phase 4 presentation system/contract
             └─ Phase 5 artifact ledger

Phase 4 ──► Phase 6 mode/fast events
Phase 2 ──► Phase 7 nested snapshot/install
Phase 3-7 ──► Phase 8 docs/defaults
Phase 1-8 ──► Phase 9 integration acceptance
```

写入安全：

- 同一工作树始终只有一个 writer。
- external fork、本仓 taskboard、本仓 presentation 可由不同 planner/reviewer 并行分析，但实际写入分别串行或使用隔离 worktree。
- 每阶段先目标测试，再包级完整测试，再 fresh read-only review。

## 15. Review Gates

### Gate A：架构与重复建设

- 是否直接复用了两个社区包。
- presentation 是否越界实现 tool renderer/task/footer。
- taskboard/statusline 是否只做必要接线。

### Gate B：行为正确性

- tool 执行参数、结果、provider context 与原生完全一致。
- hidden display 不等于删除 toolResult。
- artifact attribution 不虚报。
- reload/branch semantics 正确。

### Gate C：安全与隐私

- collapsed bash 不泄露 command。
- workspace 外路径净化。
- UI entries 不进 LLM。
- nested snapshot secret scan。

### Gate D：信息效率

- 不同时显示 HUD tool activity、statusline tool counts、transcript tool rows三份同义信息。
- 最终答案不复述动作摘要/文件 receipt。
- 默认一屏能看到结论、关键证据、验证/风险。

### Gate E：发布与迁移

- exact package pins。
- README/CAPABILITIES/snapshot 同步。
- 默认安装与 `RESTORE=1` 都能合并 required exact external pins；pack/install 临时目录 smoke 通过。
- 无 `node_modules`、dist、密钥或本机路径入库。

## 16. 故障处理与降级

| 故障 | 降级行为 |
|------|----------|
| compact transcript prototype patch 失效 | 自动回落 pi/tool-display 原 renderer；presentation/process HUD 继续工作 |
| tool-display 未加载 | edit/write 展开回落 pi 原生 renderer |
| presentation config 损坏 | 通知一次，使用默认值，不写回 |
| Git reconciliation 失败 | 只显示显式 edit/write artifact，标 `gitReconciled=false` |
| artifact diff 失败/二进制 | 显示 operation/path，不显示虚假 `+/-` |
| system event payload 非法 | 丢弃该事件，不写 session |
| entry renderer 抛错 | pi fallback error row；不得影响 agent loop |
| external package 首次安装无网络 | 启动提示 package 缺失；terrific 本仓插件仍可运行；联网后再加载 pin |

同一诊断最多三轮 analyze→fix→validate；之后停止并报告事实、原因和下一步。

## 17. 回滚

### 即时 UI 回滚

```text
/compact-transcript off
/tool-display preset verbose
/process full|off
```

### 配置回滚

- `settings.json`：移除两个 external pins 与 presentation；恢复 `hideThinkingBlock`、`outputPad`、`quietStartup`。
- `statusline.json`：需要恢复旧显示时重新加入 `toolActivity`；`environment` 从未移除。
- `terrific.json`：删除 `presentation` 段，将 `taskboard.activityMode` 改回 `full` 或删除。

### 状态兼容

presentation custom entries 不进入 LLM；卸载插件后只是不再渲染自定义内容，不影响 assistant/tool messages。不得为回滚删除 session 历史。

## 18. 交付切片

| Milestone | 可独立交付效果 | 完成门 |
|-----------|----------------|--------|
| M1 | compact tool rows + burst + expanded detail | Phase 0–2 |
| M2 | process HUD 去重 | Phase 3 |
| M3 | workspace/model/mode/fast/skill 条 + answer contract | Phase 4、6 |
| M4 | 自动文件回执 | Phase 5 |
| M5 | 可迁移默认配置与文档 | Phase 7–8 |
| M6 | 全场景集成验收 | Phase 9 |

M1 已能获得主要视觉收益；M1–M4 构成目标体验；M5–M6 才能宣告仓库级完成。

## 19. 最终 Definition of Done

- [x] 三栏明确未实现，且没有侧栏相关死代码/配置。
- [x] 社区复用结论已登记，未新增重复 compact renderer。
- [x] exact external pins 与兼容性证据已记录。
- [x] turn-bounded tool burst、条件 summary、统一工具块间距、process preserve、hidden thinking 均通过测试。
- [x] patched tool-display 已关闭 thinking labeling 与 MCP/custom decoration。
- [x] taskboard `activityMode=task` 无重复工具行。
- [x] presentation entries 全部 UI-only。
- [ ] artifact receipt 对 Git/非 Git/dirty/error/steer-followUp 有正确 flush 与降级。
- [x] mode/fast 只在用户动作后 emit。
- [x] final answer contract 已注入但不改写消息。
- [ ] 80/120/160 列真机 TUI 已验收。
- [x] 所有变更包 test/typecheck 通过。
- [x] nested snapshot/pack/install smoke 通过，默认安装与 RESTORE 都合并 exact external pins。
- [x] README、CAPABILITIES、snapshot、配置示例一致。
- [ ] 无密钥、无机器绝对路径、无第三方源码 vendoring。

## 20. 实施起点

第一步不是创建 `extensions/presentation`，而是完成 Phase 0 与 Phase 1：先证明两个现成 package 的组合边界；把 compact transcript 的 tool-turn summary/process preserve/thought ticker/bash 隐私/path 净化/prototype 卸载补齐，并让 tool-display 可关闭 thinking labeling 与 MCP decoration。只有两个 Gate 都通过并产生真实 commit pin，才写本仓 presentation，避免本仓再次承担一个已经存在的 transcript renderer。
