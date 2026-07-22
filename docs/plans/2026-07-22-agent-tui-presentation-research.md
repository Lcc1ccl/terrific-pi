# Agent TUI 运行时信息呈现调研与优化建议

> 日期：2026-07-22
>
> 范围：Claude Code、OpenAI Codex CLI、OpenCode，以及 terrific-pi 的 `presentation`、`process-view`、`statusline` 与历史 renderer fork 基线
>
> 调研结论状态：历史源码与配置审计完成；当前实现以 [presentation remediation design](./2026-07-22-presentation-remediation-design.md) 为准。
>
> 实施更新（2026-07-22）：历史 public-wrapper 方案已被 `presentation` 的受控 native render compatibility layer 取代。它不接管 built-in tool execution，内建 user-message frame、Bash 三态、Skill identity、原生展开和请求级文件回执；外部 renderer fork 已从安装链路移除。

## 1. 结论先行

当前方案的架构方向是对的：它没有重写工具执行，也没有强制最终答案走结构化工具，而是把常驻状态、任务进度、工具历史、系统事件、文件产物和最终回答分给不同层处理。这比复制 Claude Code 的整套重型 TUI 更符合 pi 的轻量与可组合特性。

以下四点记录的是实施前审计发现，保留用于说明变更动机；当前实现和验收状态以上述实施更新及第 10 节为准。

1. **关键身份信息不稳定。** 普通 `read` 行能显示路径，但模型自动读取 `SKILL.md` 时不会显示技能名；连续 read burst 只保留代表行，用户不总能判断“正在读哪个文件、是否读对了”。
2. **collapsed 契约没有真正锁住。** `presentation` 的系统条和文件回执不是宽度感知组件；最大合法输入在 80 列会分别渲染成 4 行和 40 行，当前本机 16 项配置的文件回执也会达到 19 行。当前 live compact fork 又选择让长参数完整换行，和“一次行动一行”的目标冲突。
3. **压缩语义仍偏机械。** compact fork 只合并连续同名工具，turn summary 只有 read/edit/command/other 四类；grep/find/ls 没有形成“探索批次”，Skill 也没有专门语义。
4. **运行基线不确定。** 本机 Pi 是 `0.81.1`，开发与兼容性记录仍基于 `0.80.10`；本机 compact fork pin 与仓库 snapshot pin 不一致。不同机器安装后可能看到不同的换行行为。

建议的目标不是“更像 Claude Code”，而是采用一句更严格的原则：

> **压缩体积，不压缩可判断性。默认只显示行动语义、目标身份和异常；原始输入输出统一下钻。**

优先级上，应先做 P0 的确定性、Skill 可见性、collapsed 行宽与异常信息，再做 P1 的探索批次和视觉层级。侧栏、三栏、逐工具复杂配置和完整 thinking 都不应进入近期范围。

### 实施状态（2026-07-22）

- 已落实：Pi `0.81.1` package baseline、无 fork package 迁移、受控 native render compatibility layer（不接管 built-in tool execution）、运行中探索/Skill identity、单行 width-aware renderer、动态展开键位、exact-path Skill entry、单一失败行、探索批次、A→B→A transient 状态、`processView.activityMode=full` 与收紧后的 statusline 预算。
- 已验证：`presentation` typecheck 与完整 package tests、offline install smoke、隔离 TUI，以及 authenticated model-driven 的 read/edit-write/bash-error/process-task/skill-load/reload/resume 真实 captures。
- 真实视觉证据：42 个 80x24、120x40、160x50 collapsed/expanded pane 均通过宽度、隐私、披露和生命周期断言；详见 [live fixture](./fixtures/presentation/2026-07-22-live-model-verification.md)。

## 2. 证据边界

本文使用四类证据，结论中不混用：

- **[官方]** 产品官方文档与官方 changelog。
- **[源码]** 固定 commit 的公开源码，或当前本地插件工作树。
- **[讨论]** GitHub issue 中的用户报告，只用于说明真实使用摩擦，不视为已复现事实。
- **[推断]** 从多个实现共同模式推导出的设计原则。

### 2.1 调研快照

| 对象 | 本机/源码快照 | 证据说明 |
|---|---|---|
| Claude Code | 本机 `2.1.178`；公开仓库 `ac062f33ab0ca7c62b9df648d0f2027fa9b969f0`，tag `v2.1.217` | 核心 TUI 不开源；以官方文档、changelog、截图和 issue 为主。高于 `2.1.178` 的 changelog 只说明产品方向，不代表本机已有 |
| Codex CLI | 本机 `0.144.5`；源码 `4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a` | TUI 源码可直接验证；源码 main 快照不等同于本机 release tag |
| OpenCode | 本机未安装；源码 `c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b`，package `1.18.4` | 结论来自固定源码，不声称完成本机交互复现 |
| Pi | 本机 `0.81.1` | 当前插件 devDependencies 和 Phase 0 证据基于 `0.80.10`，需重新做兼容性验收 |

### 2.2 已执行验证

- `process-view`: typecheck + 71 tests 通过。
- `presentation`: typecheck + 27 tests 通过。
- `pi-compact-transcript`: 9 tests 通过。
- `statusline`: 149 tests 通过。
- 定向 render probe：80 列下，最大 system entry 为 4 行；32 项 artifact receipt 为 40 行，当前本机 16 项配置为 19 行。
- 定向状态/隐私 probe：model A→B→A 的第三次 entry 被现有 deduper 拒绝；unknown custom tool 的 URL query 会原样进入 collapsed preview。
- `pi-tool-display`: 当前检出树没有开发依赖，`tsc` 不存在，因此本轮不能复跑 typecheck/test；历史 Phase 0 文档记录其旧基线检查通过，但不能替代当前 Pi `0.81.1` 验收。
- 子代理并行调研因本机 `pi-subagents` 缺少 `typebox/compile` 启动失败；未安装依赖，后续全部改为直接读取固定源码和官方资料。

## 3. 用户截图的信息层级

用户给出的 Claude Code 截图并不依赖复杂布局。它的有效性来自同一列中的五级权重：

| 层级 | 截图表现 | 作用 |
|---|---|---|
| L0 输入 | 深灰背景条，内容保持完整 | 明确本轮任务边界，不和 agent 输出混在一起 |
| L1 批次摘要 | 灰色低对比文本，如 searched/read/ran | 告诉用户“做过什么”，不争夺阅读焦点 |
| L2 离散事件 | Skill 成功为绿色；模型切换为黄色；Workspace 为中性白色 | 只把会改变用户判断的状态抬高 |
| L3 产物结果 | 文件编辑总量、`+/-` 使用绿红语义色 | 让用户快速确认影响范围 |
| L4 最终回答 | 高对比正文和表格，无装饰卡片 | 把真正需要阅读的内容留在最强层级 |

截图还有三个细节值得吸收：

1. **动作是语义化的。** 它说 “Searched for 1 pattern, read 3 files”，不是重复工具内部 JSON。
2. **Skill 是一等事件。** `Skill(claude-api)` 与其加载结果被明确标出，用户不必从 `Read SKILL.md` 猜测。
3. **颜色表达状态，不表达品牌。** 绿色只用于成功和新增，黄色只用于切换/提醒，大部分过程文本保持灰白。

不应照搬的部分是具体措辞、特定模型名和 Claude 私有的 focus 策略。应复制的是信息优先级。

## 4. 三款产品的可验证策略

### 4.1 Claude Code

### 可验证事实

- **[官方]** `Ctrl+O` 打开 transcript viewer，显示详细工具执行、时间戳和 assistant message 模型；默认折叠的 MCP 调用也在这里展开。官方文档还提供 transcript 内的 `Ctrl+E` “show all content”。
  来源：[Interactive mode](https://code.claude.com/docs/en/interactive-mode#keyboard-shortcuts)
- **[官方]** `verbose=false` 默认显示截断摘要；`viewMode` 支持 `default`、`verbose`、`focus`；thinking summary 默认折叠。
  来源：[Settings](https://code.claude.com/docs/en/settings#available-settings)
- **[官方]** task checklist 是独立状态区，`Ctrl+T` 显示最多五项，不和背景任务视图混用。
  来源：[Task list](https://code.claude.com/docs/en/interactive-mode#task-list)
- **[官方]** 自定义 status line 独立于 transcript，承载 model、cwd、context、cost、git 等持续状态；官方明确建议保持短小。
  来源：[Status line](https://code.claude.com/docs/en/statusline)
- **[官方 changelog]** 长工具增加周期性 heartbeat，collapsed tool summary 增加实时 elapsed time，说明它把“不要看起来卡死”作为独立问题处理。
  来源：[progress heartbeat](https://github.com/anthropics/claude-code/blob/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0/CHANGELOG.md#L83)、[elapsed counter](https://github.com/anthropics/claude-code/blob/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0/CHANGELOG.md#L216)
- **[官方 changelog]** agent view 从 raw tool text 改为 colored state word + classifier headline；screen reader 模式隐藏装饰 glyph，并把符号读成短标签。
  来源：[agent state headline](https://github.com/anthropics/claude-code/blob/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0/CHANGELOG.md#L381)、[screen reader semantics](https://github.com/anthropics/claude-code/blob/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0/CHANGELOG.md#L472)

### 设计哲学推断

- **[推断] 双平面。** 活跃状态保持在可更新区域，历史结果进入 transcript；两者避免重复。
- **[推断] 信息预算。** 默认只保留可监督摘要，详细执行不是删除，而是移到统一 viewer。
- **[推断] 异常提权。** 权限、失败、模型变化、长时无进展比普通 read 更高权重。
- **[推断] 最终回答不进入工具卡。** 最终 Markdown 是阅读主角，工具过程只是支撑证据。

### 公开讨论揭示的边界

- **[讨论]** Focus mode 可能把工具之间的实质 assistant 文本一起隐藏。这个报告未被本文复现，但说明“按位置隐藏 assistant text”不可靠。
  来源：[anthropics/claude-code#50894](https://github.com/anthropics/claude-code/issues/50894)
- **[讨论]** 只显示 read/search 数量、不显示文件名或 pattern，会破坏用户对当前行为的判断。
  来源：[anthropics/claude-code#22458](https://github.com/anthropics/claude-code/issues/22458)

对 Pi 的直接启示：可以隐藏工具正文，不能隐藏目标身份；可以压缩中间解释，不能吞掉实质结论。

### 4.2 OpenAI Codex CLI

### 可验证事实

- **[源码]** Codex 把 read/list/search 类命令组织为 `Exploring`/`Explored` 语义组，而不是逐条展示 shell。连续 read 会合并并去重文件名。
  来源：[exec_cell/render.rs](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/exec_cell/render.rs#L256-L333)
- **[源码]** 普通 agent command 输出默认只保留 5 行；被省略内容明确显示 `ctrl + t to view transcript`。
  来源：[line limit](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/exec_cell/render.rs#L33-L34)、[transcript hint](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/exec_cell/render.rs#L247-L252)
- **[源码]** `SKILL.md` read 会和当前加载的 skill 列表做精确路径匹配，命中后标注 `SKILL.md (<name> skill)`。
  来源：[chatwidget/skills.rs](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/chatwidget/skills.rs#L153-L178)
- **[源码]** reasoning summary 使用 dim + italic，视觉权重低于最终回答。
  来源：[history_cell/messages.rs](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/history_cell/messages.rs#L219-L275)
- **[源码]** 活跃状态使用 composer 上方的独立 status row，固定保留 header、elapsed、interrupt hint 和短 detail，注释明确目标是避免 vertical layout churn。
  来源：[status_indicator_widget.rs](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/status_indicator_widget.rs#L1-L5)
- **[源码]** patch 展示先给文件级 `Edited N files (+x -y)`，再以路径和绿红 line counts 组织 diff。
  来源：[diff_render.rs](https://github.com/openai/codex/blob/4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a/codex-rs/tui/src/diff_render.rs#L351-L442)

### 设计哲学推断

- **[推断] 语义分组优先。** Codex 不是只做字符串截断，而是先判断 Read/List/Search/Run，再决定如何呈现。
- **[推断] 进行态与完成态使用同一心智模型。** `Exploring` 完成后变 `Explored`，用户不必理解另一套格式。
- **[推断] 下钻入口必须就地可发现。** 只有被截断时才显示 transcript hint，避免每行都堆快捷键说明。

### 公开讨论揭示的边界

- **[讨论]** 只保留 basename 在 monorepo 中会产生歧义。
  来源：[openai/codex#18458](https://github.com/openai/codex/issues/18458)
- **[讨论]** 根据 shell parser 把命令归为 `Explored` 可能掩盖真实写操作，例如 `rg | xargs perl -pi`。
  来源：[openai/codex#9079](https://github.com/openai/codex/issues/9079)
- **[讨论 + 源码现状]** 用户明确提出 Skill 名比 `Read SKILL.md` 更可判断；当前源码已采用精确路径注释。
  来源：[openai/codex#16303](https://github.com/openai/codex/issues/16303)

对 Pi 的直接启示：探索批次应基于可信 tool identity，不应靠解析 bash 猜副作用；路径必须 workspace-relative 且足以消歧。

### 4.3 OpenCode

### 可验证事实

- **[源码]** 所有 tool part 进入统一 dispatcher，再按 Bash/Read/Edit/Skill 等专用组件渲染 pending、running、completed、error。
  来源：[ToolPart](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/routes/session/index.tsx#L1702-L1785)
- **[源码]** Read 行在执行中显示 spinner 与文件路径；Skill 有 `Loading skill...` 和 `Skill "name"` 专用语义。
  来源：[Read](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/routes/session/index.tsx#L2148-L2181)、[Skill](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/routes/session/index.tsx#L2579-L2585)
- **[源码]** Skill 本身是显式 tool，结果 title 为 `Loaded skill: <name>`，metadata 也保留 name/dir。
  来源：[tool/skill.ts](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/opencode/src/tool/skill.ts#L12-L67)
- **[源码]** reasoning 在 minimal 模式下一行折叠，运行时显示 spinner，完成后显示 title 与 duration；正文使用 muted tone。
  来源：[ReasoningPart](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/routes/session/index.tsx#L1572-L1665)
- **[源码]** Edit diff 在宽度大于 120 时 split，否则 unified；宽屏自动出现 42 列 sidebar。
  来源：[Edit](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/routes/session/index.tsx#L2388-L2438)、[layout](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/routes/session/index.tsx#L249-L271)
- **[源码]** tool details、generic output、thinking、sidebar 和 diff view 都是独立 toggle。
  来源：[config/keybind.ts](https://github.com/anomalyco/opencode/blob/c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b/packages/tui/src/config/keybind.ts#L74-L151)

### 设计哲学推断

- **[推断] 每种工具有用户语言。** Read、Skill、Edit、Bash 不共享一条泛化 JSON renderer。
- **[推断] 大内容使用局部容器。** 只有 shell output、diff、error 这类真正需要边界的内容进入 block panel。
- **[推断] 响应式能力强于默认密度。** 宽屏 side panel 与 split diff 很完整，但不是轻量 transcript 的必要组成。

### 公开讨论揭示的边界

- **[讨论]** 单个工具输出只能鼠标点击展开，缺少键盘操作，会破坏终端工作流。
  来源：[anomalyco/opencode#14511](https://github.com/anomalyco/opencode/issues/14511)
- **[讨论]** 全局 show/hide 对插件 rich output 过于粗糙，用户提出 per-tool 例外。该 issue 以 not planned 关闭，说明这类配置不一定值得立即引入。
  来源：[anomalyco/opencode#17250](https://github.com/anomalyco/opencode/issues/17250)

对 Pi 的直接启示：借用专用语义和响应式 diff，不借用默认 sidebar、卡片密度和鼠标优先交互。

## 5. 跨产品共同原则

三款产品实现不同，但共同收敛到以下规则：

1. **当前状态与历史记录分离。** 进行态可原地更新，完成态才进入 durable transcript。
2. **先归类，再压缩。** “read/search/edit/run/skill” 比工具名和 JSON 更接近用户判断。
3. **保留目标身份。** 文件路径、skill 名、模式、模型和失败原因不能被计数摘要吞掉。
4. **渐进披露必须统一。** 默认摘要、一个全局键查看详情、完整 transcript 可恢复。
5. **异常永远提权。** error、permission、blocked、retry、long-running 不参与普通成功项降噪。
6. **thinking 是辅助，不是主内容。** 默认隐藏或弱化；最终答案保持最高对比。
7. **颜色是有限状态通道。** muted=过程，green=成功，yellow=切换/等待，red=失败，accent=当前活动。
8. **可访问性不是装饰。** reduced motion、纯文本语义和键盘下钻需要和视觉模式共享信息结构。

一句可执行的设计准则是：

> 每个默认可见单元都必须回答至少一个问题：现在在做什么、对什么做、结果如何、我是否需要介入。

## 6. 实施前 Pi 方案评估（历史基线）

### 6.1 已经做对的部分

| 能力 | 当前实现 | 评价 |
|---|---|---|
| 工具执行与显示解耦 | compact fork patch transcript component；expanded 回到原 renderer | 方向正确，保留 Pi 原生执行和上下文 |
| 最终回答 | 保留 native assistant Markdown，只注入 answer contract | 正确，避免 final 被压成工具回执 |
| 任务进度 | `process-view` 保存 milestone、blocked/waiting/verification | 比单纯 spinner 更可审计 |
| 文件产物 | `presentation` 自动生成 UI-only artifact receipt | 解决“做了什么文件变更”的高价值问题 |
| 状态分层 | statusline 管常驻状态，presentation 管离散事件 | 职责边界合理 |
| thinking 降噪 | hidden thinking + thought ticker 关闭 | 符合用户偏好 |
| 失败独占 | compact fork 解除 burst hidden，失败用红色 marker | 正确，异常不会被成功 burst 吞掉 |
| 隐私基础 | bash collapsed 隐藏 command；process-view 不显示 unknown args | 符合低噪音与安全目标 |

### 6.2 关键差距矩阵

| 维度 | 用户需要 | 当前真实行为 | 判断 | 优先级 |
|---|---|---|---|---|
| 当前 read 目标 | 看见正在读哪个文件 | compact live row 显示当前/代表路径；`processView.activityMode=task` 会隐藏 passive 与 collapsed activity | 部分具备，但并行/burst 与工具间空档不稳定 | P1 |
| Skill 可见性 | 明确用了什么 skill | 只记录用户显式 `/skill:<name>`；模型按规则读取 `SKILL.md` 不会触发 Skill entry | 核心缺失 | P0 |
| collapsed 单行 | 过程流不挤占屏幕 | `presentation` system/artifact renderer 不感知 width；合法 32 项 artifact receipt 在 80 列为 40 行，当前本机 16 项配置为 19 行 | 与成功标准直接冲突 | P0 |
| compact 长参数 | 不显示大段 prompt/命令 | 本机新 pin 为避免 clipping，让完整 preview 自动换行；unknown tool 可选择 `prompt`、`text`、`url` | 与用户偏好及隐私边界冲突 | P0 |
| 探索批次 | read/grep/find/ls 形成可理解的一个阶段 | 只合并相邻同名工具；grep/find/ls 在 turn summary 中落入 `other` | 机械压缩，语义不足 | P1 |
| 失败原因 | 看见是否失败及最小原因 | 失败行可见且为红色，但多行 error 常退化成 `N lines`，没有明确原因或下钻 hint | 可见但不可判断 | P0 |
| 模型/思考切换 | 每次显式变化可追溯 | model/thinking 被 durable dedupe；定向 probe 证实 A→B→A 时第二次 A 被抑制 | 时间线不完整 | P0 |
| 文件回执 | 一行确认影响范围 | collapsed 和 expanded 共用 `maxExpandedArtifacts`，本机值 16；整行统一 muted，无绿红 diff 层级 | 功能有，信息层级和宽度不合格 | P0/P1 |
| 下钻发现 | 隐藏详情时知道如何查看 | Ctrl+O 能恢复原 renderer，但 compact row 本身通常不提示；只有文档说明 | 能力有，发现性弱 | P1 |
| statusline | 只保留常驻、可行动信息 | 本机 stacked 配置含 15 widgets；`environment` 只给可用 skill/tool 数，不回答“实际用了谁” | 可能与 transcript 竞争 | P1 |
| 运行确定性 | 迁移后行为一致 | 本机 compact fork 与 snapshot pin 均为 `1bad0d8`；Pi `0.81.1` 未完成新兼容验收 | 发布阻断项 | P0 |
| 视觉验收 | 80/120/160 可证实 | fixture 目录只有兼容性 note；计划明确六个 capture 未完成 | 不能宣称完成 | P0 |

### 6.3 具体源码证据

- Skill 只识别显式 slash input：`extensions/presentation/extensions/presentation.ts:291`。
- model/thinking 不在 transient dedupe 集合：`extensions/presentation/lib/system-events.ts:16`、`:119-126`。
- system/artifact renderer 直接构造 `Text`，没有 render width：`extensions/presentation/lib/render.ts:31-68`。
- collapsed artifact 使用 `maxExpandedArtifacts`：`extensions/presentation/lib/render.ts:42-49`。
- unknown compact preview 会优先展示 `url`、`prompt`、`text`：本机 compact fork `extensions/compact-transcript.ts:236-299`。
- turn summary 只有 read/edit/bash/default 四类：同文件 `:882-952`。
- `task` activity mode 无 snapshot 时不显示 passive activity，collapsed task HUD 也不显示 activity：`extensions/process-view/lib/render.ts:173-180`、`:298-301`。
- 本机配置确为 `processView.activityMode="task"`：`~/.pi/agent/terrific.json` 对应段。
- 审计当时的 Phase 0 文档明确六个 model-backed capture 未完成；该历史 gate 已由 [live fixture](./fixtures/presentation/2026-07-22-live-model-verification.md) 关闭。

## 7. 优化方案（实施前建议）

### 7.1 P0：先修“判断错误或不同机器不一致”

#### P0-1 统一 Pi 基线与 package pins

**改动**

- 选择并记录一个真实运行基线：要么回到 Pi `0.80.10`，要么正式把基线提升到 `0.81.1`。
- 在新基线上重跑 process/presentation/statusline/compact/tool-display 集成检查。
- live settings、snapshot、required external package 清单只允许一个 compact commit。
- 不直接把 snapshot 追到 `1bad0d8`：先决定长 preview 应换行还是语义截断。按本项目目标，应当语义截断后再生成新 pin。

**验收**

- 本机与临时安装环境解析到同一两个 external commits。
- `/reload`、resume、Ctrl+O、edit/write expanded renderer 在目标 Pi 版本通过。

**成本/风险**：S；风险低，但属于其他 UI 优化的前置条件。

#### P0-2 恢复严格 collapsed 行宽

**改动**

- `presentation` renderer 改为 width-aware component。
- collapsed system entry 固定 1 行；label 优先保留，message 尾部 ellipsis。
- collapsed artifact receipt 固定展示总数、总 `+/-`、最多 2 个路径和 `+N more`。
- `maxExpandedArtifacts` 只控制 expanded rows，不再控制 collapsed 数量。
- compact tool preview 只保留 `verb + safe target + result state + duration`；长 prompt/text 不允许换行进入 collapsed。

**验收**

- 80/120/160 列下所有 system/tool/artifact collapsed 单元均为 1 行。
- 长单词、CJK、ANSI、OSC、长 workspace path 和 32 files fixture 均不溢出。
- Ctrl+O 后仍可读取完整原始 renderer 内容。

**成本/风险**：M；风险中等，主要在 TUI 宽度与 ANSI visible width。

#### P0-3 把模型加载的 Skill 变成一等事件

**最小实现**

- 在 `before_agent_start` 从 `systemPromptOptions.skills` 建立 `filePath -> name` 精确映射。
- `read` 的最终 path 与某个 Skill `filePath` 精确匹配时，显示 `Skill(<name>) · loading`；成功后落一条 `loaded`，失败则红色 `failed`。
- 每个 request 对同一 skill 去重一次；普通读取非 Skill 文件不推断。
- 保留现有显式 `/skill:<name>` 记录。

这与 Codex 当前的 exact-path best effort 做法一致，不需要新增 Skill tool，也不需要解析 skill 正文。

**验收**

- 自动读取、显式 slash、读取普通同名 `SKILL.md`、失败 read、重复 read、resume 均有 fixture。
- transcript 只显示 skill 名，不泄露全局绝对路径。

**成本/风险**：M；风险低，误判边界可由 exact path 控制。

#### P0-4 修复失败最小信息和状态时间线

**改动**

- failed row 固定包含：tool、`failed`、安全的第一条错误原因或 exit code、隐藏行数、Ctrl+O hint。
- 继续隐藏 bash command 正文；不要把错误堆栈放 collapsed。
- model/thinking dedupe 改为“连续相同状态不重复”或短时间窗口，不做 session 全局永久去重。A→B→A 必须保留三次用户动作。

**验收**

- 单行失败、多行失败、无文本失败、permission denied、retry 后成功均有 snapshot。
- model/thinking 往返切换时间线完整，restore 不新增事件。

**成本/风险**：S-M；风险低。

#### P0-5 完成真实视觉 Gate

必须补齐设计稿已经要求但尚未存在的六类 capture：

- 分析/read burst
- edit/write
- bash error
- process task
- skill load
- reload/resume

每类在 80x24、120x40、160x50 下记录 collapsed 与 Ctrl+O expanded。自动测试不能替代真机 capture。

**成本/风险**：M；无实现风险，但可能暴露 prototype patch 或布局问题。

### 7.2 P1：提升语义和视觉层级

#### P1-1 从同名 burst 升级为“探索批次”

将可信的 `read`、`grep`、`find`、`ls` 组织为一个 exploration episode：

```text
◆ Exploring · read render.ts · 3s
◆ Explored 3 files · searched 1 pattern · listed 1 directory · 6s
```

规则：

- 活跃行只显示当前主目标；并行时显示最多两个目标和 `+N`。
- 完成行按 read/search/list 分桶，不把它们叫 `other tool`。
- edit/write/bash 永不并入 exploration。
- 不解析 bash 来猜 read-only；shell 一律保留 `ran command`，避免 Codex issue #9079 类误分类。
- 连续 assistant 实质文本结束当前 episode，不能跨过用户可读结论继续合并。

**成本/风险**：M-L；风险在 turn/retry/hydration 生命周期，必须先写 episode state tests。

#### P1-2 使用 span 级语义色，而不是整行着色

建议统一渲染语法：

```text
◆  Exploring   render.ts · 3s
✓  Skill       best-practice-research · loaded
●  Model       openai/gpt-5.6 · thinking high
✓  Files       3 changed · +105/-7 · M render.ts · +2 more
✗  bash        failed · exit 1 · 12 lines · Ctrl+O
```

颜色分配：

- marker：active/accent、success/green、warning/yellow、error/red。
- verb/label：bold neutral。
- target：normal foreground。
- duration、count、hint：muted。
- additions/deletions：green/red，只染数字和符号。

`presentation` 当前把整行染为同一 tone，应改为多个 span。这样能接近截图的层级，但不绑定固定配色值，继续使用 Pi theme token。

**成本/风险**：M；风险低。

#### P1-3 统一下钻语义

- 继续复用 Pi 原生 `app.tools.expand`，不新增第二套快捷键。
- 只在确实隐藏了内容的行显示一次本地 hint，例如 `12 lines · Ctrl+O`。
- process panel、tool detail、artifact detail 都跟随同一个 expanded 状态。
- 不做 OpenCode 式鼠标专属单块展开，除非以后 Pi 提供可访问的统一焦点模型。

**成本/风险**：S-M；风险低。

#### P1-4 收紧 statusline 默认信息预算

当前 stacked 配置包含 15 widgets。建议默认只保留持续且可行动的信息：

- identity：path、branch、model、mode、fast
- budget：context、cost、cache
- runtime：progress、state、duration

`environment` 的“可用 context files / skills / tools 数量”不回答“本轮实际用了什么”，建议移到 `/status` 或 expanded diagnostics。Skill 使用应由 transcript event 表达。

**成本/风险**：S；纯配置即可验证。

#### P1-5 校正设计文档状态

已完成：研究文档、历史 fork baseline 与 native renderer note 已链接到 authenticated live fixture。当前状态是：

```text
实现、包级自动测试、离线迁移和真实 TUI 验收均已完成；P2 的 sidebar、逐工具策略和子代理原始流仍是明确非目标。
```

这保持了历史审计与当前事实的边界，避免维护者把实施前缺口误读为现状。

**成本/风险**：S；无运行风险。

### 7.3 P2：范围结论

1. **外部 fork 已移除；受控 patch 保留。** `presentation` 仅 patch 两个 native `render` 方法，具备 compare-and-swap 卸载与原 renderer 回退；不会接管 tool execution。
2. **screen-reader/reduced-motion：已满足当前需要。** 所有 presentation 状态都有文本 label，未引入动画/blink，展开提示来自可重绑定的 `app.tools.expand`。
3. **per-tool output policy：明确不做。** 当前没有多个 rich custom tools 需要默认展开；全局原生展开已经覆盖需求。
4. **subagent activity summary：明确不做。** `process-view` 已负责主流程进度；复制子代理原始工具流会违背低噪音目标，只有用户需要主会话内的 agent 汇总时才重新立项。
5. **fullscreen/sidebar：明确不做。** 当前目标不需要。OpenCode 的宽屏 sidebar 很完整，但会扩大布局、状态和键位维护面。

## 8. 明确不建议照搬

| 不照搬项 | 原因 |
|---|---|
| Claude focus 对 assistant 中间文本的隐藏 | 可能吞掉实质结论；只应隐藏工具正文与明确标记的 reasoning |
| Codex 对复杂 shell 的 read/search 推断 | 可能把真实写操作标成 `Explored`；只按可信 tool identity 分组 |
| OpenCode 默认 sidebar 和大量 block panel | 不符合 Pi 的轻量单列目标，且会挤占最终回答 |
| 每个工具独立配置几十个显示字段 | 当前问题可以由少量全局规则和安全 adapter 解决，避免配置爆炸 |
| 为避免 clipping 而完整换行 prompt/text/url | 这会把低价值参数重新变成墙；collapsed 应语义截断，expanded 保真 |
| 把 thinking 标题当过程导航 | 用户明确不关心大量 thinking；应由行动/里程碑提供导航 |

## 9. 推荐实施顺序

1. **先冻结基线。** Pi 版本、两个 external pins、配置快照完全一致。
2. **先写 P0 失败测试。** 80 列 system/artifact、Skill exact-path、A→B→A、multiline error、long prompt/url。
3. **修 collapsed 与隐私。** 一行、目标优先、原文下钻。
4. **补 Skill 和状态时间线。** 解决用户最关心的“用了什么、读了什么”。
5. **完成真实 TUI capture。** 在继续设计探索批次前证明 P0 目标成立。
6. **再做 exploration episode 与 span hierarchy。** 这两项是最大体验增益，但不应建立在漂移的 renderer pin 上。
7. **最后精简 statusline 与文档状态。** 通过配置收尾，不扩大插件职责。

## 10. P0 验收清单

- [x] live settings、snapshot、required package list 已移除 renderer fork；安装时清理 retired pin。
- [x] Pi `0.81.1` 是明确运行基线；`presentation` 使用受控 native render compatibility layer，不再要求 tool-display check。
- [x] 所有 collapsed system/tool/artifact 行在 80/120/160 列均为一行。
- [x] collapsed 不显示 bash command、完整 prompt/text、URL query、工具结果正文。
- [x] 自动 Skill 加载显示 skill 名，普通 `SKILL.md` 不误报，失败仍保留 Skill identity。
- [x] 当前 read 的 workspace-relative 目标在运行中可见；完成批次显示数量和代表目标。
- [x] error 永远可见，包含最小安全原因和动态 `app.tools.expand` 提示，且不重复。
- [x] model/thinking A→B→A 时间线完整；restore/reload 不重复。
- [x] artifact collapsed 固定短摘要，expanded 才按配置列文件。
- [x] 六类 fixture 与三种宽度真机 capture 已归档。
- [x] print/json/rpc 退化路径不调用 TUI-only renderer。
- [x] 设计文档状态与 DoD、实际证据一致。

## 11. 最终判断

当前组合已经具备正确的骨架，尤其是 native final answer、UI-only entries、process milestone、artifact ledger 和统一 Ctrl+O 下钻，这些都应保留。真正缺的不是另一个大插件，而是把现有五层显示链路收敛到同一套信息规则。

最小有效路线是：

```text
确定版本/pin
  -> 锁住 collapsed 一行与隐私
  -> 精确显示 Skill 和当前目标
  -> 提升 error/model chronology
  -> 完成真机 capture
  -> 再做 exploration episode 与 span hierarchy
```

完成 P0 后，当前方案就能可靠回答用户最关心的三个问题：“用了什么 skill”“现在在读哪个文件”“结果是否可信”。P1 再负责让这些答案像 Claude Code 截图一样安静、清楚、有层级。
