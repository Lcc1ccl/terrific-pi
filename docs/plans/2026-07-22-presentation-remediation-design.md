# Presentation 展示层彻底修复设计

> 日期：2026-07-22
>
> 状态：问题、最终技术设计、实施顺序与验收门槛已冻结；进入测试先行实施
>
> 范围：`extensions/presentation`、`extensions/process-view`、`extensions/auxiliary`、展示配置与真实 TUI 验收

## 1. 用户指令与交付原则

本轮不是对现有实现做降级或局部遮盖，而是恢复并提升完整交互效果：

1. `presentation` 可以内建原 `pi-tool-display` 的 user-message patch，不再依赖外部 package。
2. 展示层具体设计由实现方判断，以最终运行效果和用户反馈为准。
3. 必须先记录问题与计划，再完成方案复核，报告任何需要提权的操作，最后实施。
4. 以最佳效果为目标；不以关闭功能、隐藏信息或退回低质量原生输出作为最终方案。
5. 工具执行结果、模型上下文、安全网和权限语义不得被展示层改变。

## 2. 已确认问题

### P0-1 `git_finalize` 提前终止任务生命周期

- `git_finalize` 成功结果返回 `terminate: true`，同时提示模型不得在其后响应。
- 成功提交后不再有模型回合发布 `process_update(completed)` 或最终回答。
- `process-view` 在 `agent_settled` 遵守“不擅自宣称任务完成”原则，只能把仍为 `running` 的快照转为 `waiting`。
- 用户看到的结果是：Git 已提交、任务仍为 Waiting、会话没有正常收尾。

### P0-2 Bash 运行/成功/失败三态退化

- `presentation` 同名覆盖 Bash，并使用 `renderShell: "self"`。
- collapsed Bash 的 `renderCall` 和成功 `renderResult` 均为空；运行中没有 spinner，成功没有绿色完成态。
- 失败由 wrapper 手工输出红行；成功只在 `turn_end` 追加 muted `Command` entry。
- 旧版稳定的 running animation、success green、error red 状态机因此被拆散。

### P0-3 展示所有权冲突

当前同一事实可能同时存在于四个表面：

1. Pi 原生 `ToolExecutionComponent`。
2. `presentation` 的 `presentation-tools-v1` durable entry。
3. `process-view` 在 `activityMode=full` 下的 active/recent activity。
4. `ArtifactJournal` 的文件回执。

这不是简单文案重复，而是没有定义唯一 owner。

### P1-1 用户消息边框被主动删除

- 旧效果由 `pi-tool-display` patch `UserMessageComponent.prototype.render` 实现。
- Pi 当前没有公开的 built-in user-message renderer override。
- 新 `presentation` 明确不复现该边框，因此用户输入层级与会话边界退化。

### P1-2 Bash、generic tool 与历史 failure entry 重复

- 当前 `ToolTimeline` 为 Bash 成功追加 `Command` entry，为其他自定义工具追加 `Tool(...)` entry。
- 这些 durable entries 与原生 tool row、Process HUD 同时存在。
- 历史 session 中已经持久化的 `kind: "failure"` 仍被当前 renderer 接受；恢复会话后会与当前失败行叠加。

### P1-3 文件变更回执重复且可能误报

- ArtifactJournal 在每个 tool-bearing `turn_end` flush，write -> edit 跨轮会产生多个回执。
- Git reconciliation 把“路径从 dirty status 消失”直接视为 modified/deleted；正常 commit 也会生成虚假的 `Files changed`。
- expanded 状态还会同时显示原生 edit/write 与 artifact receipt，缺少明确的信息分工。

### P1-4 合法配置可让成功修改完全不可见

- compact wrapper 会隐藏成功 edit/write 的原生结果。
- ToolTimeline 又跳过 mutation。
- 当 `compactTools=true` 且 `artifacts=false` 时，没有任何 collapsed 成功反馈。

### P1-5 同名工具 override 越过纯展示边界

- Pi 对同名工具采用 first-registration-wins，而不是 renderer middleware。
- `presentation` 重新创建本地 built-in definition，不是装饰当前已注册 definition。
- 它会与 sandbox、remote、其他 tool override 或未来安全实现竞争执行所有权。
- 最终架构不能把这种竞争当作纯展示机制。

### P2-1 大量 Bash 失败污染历史

- 失败本身来自真实命令错误或 CC Safety Net 拒绝，不应被伪装为成功或全部隐藏。
- 当前展示会把每次失败都永久保存，历史 failure entry 还可能重复。
- 需要保留第一条可行动失败，并合并同一轮内同原因的连续失败。

### P2-2 现有测试把回归当成正确行为

- wrapper 测试断言 collapsed 成功为空。
- live fixture 只覆盖 Bash error，不覆盖 running/success 状态转换。
- 文件 fixture 已出现双回执，但审计只检查存在性和隐私，不检查数量与 A/M/D 正确性。
- 没有 `git_finalize` + `process-view` + agent loop 的组合测试。

## 3. 不可降级的目标效果

### 3.1 用户输入

- 用户消息保持明确的整宽边界、标题与原始文本。
- patch 必须幂等、可卸载、可检测不兼容，不得静默破坏 Pi 启动。
- reload、resume、tree navigation 后不得重复包裹或丢失边框。

### 3.2 工具状态

每个工具调用在 collapsed 模式下只能有一个 owner，并满足：

- running：动画/活动色、语义动词、安全目标、elapsed。
- success：绿色完成态、影响摘要、duration。
- error：红色失败态、最小可行动原因、下钻入口。
- expanded：恢复完整原始 call/result 或专用 diff，不丢失信息。
- 80/120/160 列均不错误换行；长路径按可见宽度截断。

Bash 命令正文默认不进入 collapsed 历史；expanded 必须可查。安全拒绝、exit code 和短错误原因必须可见。

### 3.3 任务与收尾

- Process HUD 只展示目标、进度、当前步骤、时间和 blocked/waiting 原因。
- 工具活动不在 collapsed Process HUD 与 transcript 重复。
- 成功 Git 提交后，最后步骤可靠变为 done，task 变为 completed，并出现最终 assistant 总结。
- commit/push 失败时不得完成任务或提前终止会话。

### 3.4 文件结果

- 一个用户请求只产生一个净文件变更回执；同一文件多次 write/edit 合并。
- A/M/D、总 `+/-`、路径和 pre-existing 语义准确。
- commit/index 状态变化不算文件内容变化。
- expanded 原生 edit/write 与最终净回执职责不同：前者是调用细节，后者是请求级最终影响。

### 3.5 历史兼容

- 恢复旧 session 时，旧 `presentation-tools-v1 failure` 不与当前 tool result 重复。
- UI-only entry 不进入 provider context。
- 旧 entry 数据不得导致 renderer 崩溃。

## 4. 候选架构

### 方案 A：恢复两个外部 fork

优点：最接近旧视觉效果，已有 Bash/user-message 实现。

缺点：重新引入外部 pin、安装与升级耦合，继续依赖多个互相 patch 的包，所有权仍分散。

结论：只作为回滚基线，不作为最终方案。

### 方案 B：只使用 Pi 公共 API

优点：升级边界清晰，不 patch 私有 TUI。

缺点：当前公共 API 没有 user-message override，也没有可组合的 tool renderer middleware；同名 override 会接管执行定义，无法同时达到视觉目标和所有权安全。

结论：不能完整满足目标，不作为最终方案。

### 方案 C：`presentation` 内建受控兼容层并统一展示所有权

核心思路：

- 把已验证的 user-message patch 和必要的 transcript/tool rendering hook 内建到 `presentation`。
- 私有 API 只封装在单一 compatibility 模块中，带版本守卫、幂等 install/uninstall 和 fail-safe。
- 不再通过同名 `registerTool()` 模拟 renderer middleware，从而不接管工具执行。
- 由一个 tool presentation controller 统一 running -> success/error -> expanded 生命周期。
- `process-view` 只管任务；ArtifactJournal 只管请求级净文件影响；system entries 继续由 presentation 管理。

初步结论：方案 C 最符合完整效果与长期可控性。实施前必须完整对照旧 fork、Pi `0.81.1` TUI 生命周期和 reload/resume 行为，再冻结接口。

## 5. 初始所有权模型

| 信息 | 唯一 owner | durable |
|---|---|---:|
| 用户输入 | presentation user-message compatibility layer | 原消息自身 |
| 活跃工具状态 | presentation tool presentation controller | 否，原地更新 |
| 完成/失败工具历史 | presentation tool presentation controller | 使用原 tool call/result |
| 任务步骤 | process-view | 是 |
| 请求级文件净变化 | ArtifactJournal | 是，每请求一次 |
| workspace/model/mode/fast/Skill | presentation system events | 是 |
| 最终回答 | Pi 原生 assistant message | 是 |
| footer 系统状态 | statusline | 否 |

## 6. 实施阶段

### Phase 0：方案与兼容性复核

- 完整读取 Pi extension/TUI/session 文档及相关示例。
- 完整读取旧 user-message、Bash、compact transcript patch。
- 验证 Pi `0.81.1` 的组件构造、tool lifecycle、reload/shutdown、session restore 和 prototype 稳定边界。
- 扫描本仓已启用插件与 package 顺序，确认 mode/fast/context/btw/statusline 联动。
- 更新本文为最终设计，并记录是否需要修改 Pi core、网络、sudo 或安装依赖。

### Phase 1：先建立失败的回归测试

- user-message patch：安装、重复安装、卸载、版本不兼容、原 renderer 恢复。
- Bash：running、partial、success、error、expanded、长路径/原因和 elapsed。
- ownership：presentation 不注册/替换内置执行工具；其他 override 不受影响。
- duplicate：native history、Process HUD、legacy failure 各场景恰有一个 owner。
- artifact：write -> edit 请求级合并；commit disappearance 不误报；真实删除仍报告。
- lifecycle：running 3/4 -> git_finalize success -> completed 4/4 -> final response。
- 所有新增测试必须先观察到预期失败，再写实现。

### Phase 2：展示兼容层与工具状态机

- 引入 `lib/compat/`，隔离私有 Pi 组件 patch。
- 合并 user-message renderer，补幂等与卸载恢复。
- 统一 tool running/success/error/expanded 展示，删除同名 tool execution wrapper。
- 移除 Bash/generic durable 摘要的重复 owner，保留有价值的语义分组。
- 旧 failure entry 兼容隐藏或迁移。

### Phase 3：Artifact 与 Process 生命周期

- ArtifactJournal 改为请求级净变化聚合。
- 修复 dirty path disappearance 的文件指纹判定。
- `processView.activityMode=full` 的紧凑 HUD 只显示聚合工具计数/结果；工具名称和详情只保留在原生 tool row 与展开任务面板。
- 重定义 `git_finalize` 成功后的非终止收尾契约，允许 process completion 和最终回答；禁止后续写操作。

### Phase 4：真实 TUI 验收

- 80x24、120x40、160x50。
- collapsed/expanded。
- user input、read/search、Bash success/error/long-running、edit/write、process、git finalize。
- reload、resume、tree navigation。
- 对截图做非空、宽度、颜色状态、重复行和顺序审计。

### Phase 5：配置、文档与迁移

- 更新 `README`、`CAPABILITIES`、example/snapshot 配置及安装清单。
- 删除不再使用的 wrapper 配置和历史声明。
- 如用户要求离线物，再执行 snapshot、pack 和临时 `PI_HOME` 安装 smoke。

## 7. 权限、影响与回滚边界

当前已知实施不需要：

- `sudo` 或系统级配置。
- 修改已安装 Pi core。
- 新增第三方依赖。
- 网络访问或发布外部包。
- Git push、rebase、reset 或删除用户状态。

允许范围内的变更：本仓 extension、测试、配置快照和文档。

如果复核确认必须修改已安装 Pi core，必须先暂停并报告：具体文件、影响版本、验证方法和回滚补丁。默认不走该路径。

回滚策略：

1. 保留现有 `presentation` config 开关。
2. compatibility patch 必须在 shutdown/reload 恢复原 prototype。
3. 每个阶段保持独立测试与窄 diff，可逐阶段撤回。
4. 不迁移或重写已有 session JSONL；历史兼容由 renderer 处理。

## 8. 发布门槛

以下条件全部满足前不得宣称完成：

- package typecheck/test 全绿。
- 新回归测试完成 RED -> GREEN 证据。
- presentation、process-view、auxiliary、statusline 联动测试通过。
- 真实 TUI captures 覆盖三种宽度、collapsed/expanded 和生命周期。
- 用户输入边框、Bash 三态、单一文件回执、process completed 均有视觉证据。
- 没有内置 tool execution ownership 冲突。
- 没有新增 secret、本机绝对路径、外部依赖或无关文件。

## 9. 最终设计冻结（源码/API 复核后）

### 9.1 私有兼容边界

只 patch Pi 根包已导出的两个公开类方法：

1. `UserMessageComponent.prototype.render`。
2. `ToolExecutionComponent.prototype.render`。

明确禁止：

- patch `ToolExecutionComponent.updateDisplay/updateResult/setExpanded` 或内部 Container。
- 注册同名 built-in tool。
- 修改任何 tool definition、schema、execute、operations、active tools 权限或结果。
- 复制旧 compact-transcript 对 AssistantMessageComponent 的 thinking patch。

两个 patch 都采用 compare-and-swap 卸载：仅当 prototype 当前仍是本插件 wrapper 时恢复保存的 descriptor。所有 `session_shutdown` reason 均停止 timer、清理 controller 并恢复 prototype。结构或版本不兼容时只告警一次并调用原 renderer。

### 9.2 User message

不再重新构造 Markdown，也不读取/改写原始消息文本：

- 先调用原 `render(innerWidth)`，保留 Pi 的 Markdown、ordered-list、backslash、ANSI 与 OSC 8 行为。
- 从原输出提取 OSC 133/633 semantic-zone 标记，并各一次地重新附着到新外框首尾。
- 仅移除旧背景 SGR、补整宽 `user` 标题边框和 `userMessageBg`；窄宽、超大输出或异常时原样回退。
- `presentation.userMessageBox` 默认开启，可在 `/presentation` 中切换。

### 9.3 Tool presentation controller

状态维度为 `pending | running | success | error`，`expanded` 是正交视图标志：

- collapsed：patched `render(width)` 从组件只读 `toolCallId/toolName/args/cwd/executionStarted/isPartial/result`，输出 width-bound 语义行。
- expanded、功能关闭或兼容失败：逐行等价调用保存的原 `render()`。
- 一个全局 spinner timer 按 `toolCallId` 更新所有 running component；一个调用结束不得停止其他并行调用的动画。
- live 状态来自 tool lifecycle events；resume/reload/tree 从当前 branch 的 assistant tool calls 与 toolResult 重建，历史终态不启动 timer。
- read/grep/find/ls 按同一 assistant tool turn 聚合为 exploration episode；失败独占，Bash/edit/write/custom 不混入 exploration。
- Bash collapsed 不显示 command，只显示 running/success/error、输出行数、duration 与安全原因；expanded 保留命令和原始输出。
- `process_update` 始终保留自己的 renderer。
- 相邻同 tool、同安全原因的重复失败合并计数；不同失败不合并。

旧 `presentation-tools-v1` renderer 全部返回 `undefined`，不改写历史 JSONL；工具原始 call/result 成为唯一 durable history。

### 9.4 请求级 Artifact 投影

不再把可见文件回执作为多条 append-only UI entry：

- ArtifactJournal 在 `before_agent_start` 以当前 user leaf 建立 request baseline。
- 每次相关 `turn_end` 计算“请求开始状态 vs 当前文件系统”的完整净快照，写一条无 renderer 的 `presentation-artifact-state-v2` UI-only state entry。
- state 包含 `requestId/revision/anchorToolCallId/files/fullSnapshot`；相同 digest 不追加。
- Tool controller 把最新 state 投影到最后一个贡献工具的现有 ToolExecution row：先前成功 edit/write collapsed row 隐藏，anchor row 显示唯一累计 `Files` 摘要；expanded 在原工具详情后附请求级文件详情。
- write -> edit、explicit -> Bash、跨 tool turn 都只保留最新净值；完全回退显示 `Files unchanged · net changes reverted`。
- Git status/index/commit 只用于发现候选路径；A/M/D 与 `+/-` 由首次文件基线和当前内容决定。
- 后续 snapshot 继续观测初始 dirty 与显式候选路径；路径从 dirty status 消失但指纹相同视为 commit/index-only，不产生变更。
- 比较 request-start HEAD 与 current HEAD，补获 Bash 在同一调用内修改并提交的 Git-visible 路径。
- `agent_settled` 不追加正常文件回执，避免落在最终回答后。

旧 `presentation-artifacts-v1` 在 branch hydration 时转换为最近 tool anchor 的兼容 state；原 renderer 不再单独显示，避免历史重复。

### 9.5 `git_finalize` 与 Process 收尾

采用确定性宿主 hook，不依赖模型自觉完成任务：

1. `git_finalize` 移除 `terminate:true`，details 增加严格版本 receipt：`kind/version/status/commit/requestedPush/operationSatisfied`。
2. `operationSatisfied=true` 仅用于本地 commit 已满足请求，或 push 成功；requested push 的 `partial` 为 false。
3. process-view 在 `tool_call` 检查：若存在 running process，只有“其他步骤全 done、唯一 active 是最后一步”时允许 terminal `git_finalize`。
4. process-view 在宿主等待的 `tool_result` hook 中验证 receipt；满足时把最后一步与 task 同步持久化为 completed，并加入唯一 commit artifact。
5. `partial` 保持未完成并转 waiting/failed，明确记录“本地提交成功、push 失败”；commit 前失败不改变完成状态。
6. `git_finalize` 必须是其 assistant response 中唯一 tool call；commit 产生后 auxiliary 保存 active tools、将下一模型回合工具集置空，并在同批后续 `tool_call` 中阻止其他工具；下一回合只能输出最终 assistant 收尾。
7. `agent_settled/session_shutdown` 恢复 active tools 和 run-scoped guard。

### 9.6 权限结论

本设计不需要：

- `sudo` 或系统配置修改。
- 修改已安装 Pi core。
- 网络访问、外部 fork 或新 runtime dependency。
- Git push、rebase、reset 或 session JSONL 迁移。

Pi `0.81.1` 已从根包导出两个目标组件。本轮私有依赖是实例 shape，而不是模块深路径；版本/shape guard 和真实 TUI gate 是发布条件。长期彻底移除该边界，应向 Pi 上游增加 composable transcript renderer middleware，但不阻塞本轮交付。

## 10. 实施记录与当前状态

已完成的生产变更：

- 删除 `presentation` 对内置 `read/grep/find/ls/bash/edit/write` 的同名注册，删除已废弃的 public-wrapper/timeline 实现；compatibility controller 成为唯一展示层。
- 内建 user message frame、Bash pending/success/error、准确 Skill path identity、native expanded fallback、reload-safe prototype ownership 与单请求 artifact projection。
- `ArtifactJournal` 使用请求起点文件指纹和 base HEAD 对比；已覆盖 dirty -> committed 不误报，以及 Bash 修改并提交仍保留净变更。
- `git_finalize` 返回 `git_finalize@1` receipt 且不再终止 agent loop；成功提交锁定余下工具但允许最终 assistant message。`process-view` 仅在合格最终步骤收到有效 receipt 时完成任务，partial push 保持 Waiting 并标记该步骤失败。
- Process HUD 紧凑态只显示聚合活动，不重复 native tool-row 标签；展开面板继续提供详情。

权限结论：未使用 `sudo`、网络、新依赖、Pi core 修改、Git push/rebase/reset 或 session JSONL 迁移。

验证状态：已完成 targeted RED -> GREEN 证据及 package typecheck/test；真实交互 TUI 验收仍需在重载后的 Pi 会话中覆盖 80/120/160 列、Bash 三态、user frame、Git 收尾和 reload/resume。
