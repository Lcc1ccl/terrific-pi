# terrific-pi 历史会话复盘与长期契约

> 当前归属提示：Pilot 与 Docsflow 已迁至独立 `terrific-pi-automation` 发行边界；本文保留拆分前历史事实，不作为当前安装或目录规格。
>
> 证据窗口：2026-07-17 至 2026-07-22。
> 本文记录历史动机、踩坑与长期工程契约，不替代当前代码、测试、`AGENTS.md` 或 `docs/CAPABILITIES.md`。

## 1. 覆盖范围

本次复盘逐行解析了仓库工作目录对应的全部 session：

| 日期 | 顶层 session | 顶层 user 消息 |
|------|-------------:|---------------:|
| 2026-07-17 | 5 | 12 |
| 2026-07-18 | 22 | 79 |
| 2026-07-19 | 9 | 70 |
| 2026-07-20 | 12 | 61 |
| 2026-07-21 | 7 | 45 |
| 2026-07-22 | 7 | 14 |
| **合计** | **62** | **281** |

另将嵌套子代理 JSONL 与顶层 session 分开审阅。嵌套记录会随当前工作继续产生，因此不把易变文件数固化为长期事实；两条 fork 后复制的委派提示没有重复计入长期契约。与本仓治理无关的付款排查、全局技能安装等会话计入覆盖数，但不被提升为仓库规则。

原始 session 可能包含本机路径、账号、付款或密钥类信息，因此只保留统计和抽象结论，禁止把原始 JSONL 或私密值写入仓库。

## 2. 演进主线

### 2026-07-17：先修真实行为

- `master` 与 `main` 的默认分支语义统一。
- `/fast` 从“HUD 看似开启”修到请求实际注入 Priority。
- fast 状态开始考虑 resume 后恢复。

这一阶段确立了第一条底线：界面状态不能替代真实运行态。

### 2026-07-18：从插件功能走向协同体验

- statusline 经历信息层级、亮暗主题、plain/emoji、quota、窄屏与间距迭代。
- taskboard（当时名为 process-view）形成目标、步骤、计时、waiting/blocked 等任务状态。
- auxiliary 从单一 Git 场景扩展为任务级模型路由，并开始对照 Hermes 与社区实现。
- 用户明确要求：新增 feat 默认检查 statusline/HUD、mode、fast、context、btw 与共享配置的联动。

### 2026-07-19：把交付过程纳入产品边界

- auxiliary 增加 fallback、TUI 配置与 sidecar/subagent 方案审判。
- statusline 的 minimal、分区排序、mock preview、秒数与窄屏行为反复校正。
- 提交/推送前的 review-fix-review、人类 checkpoint 和文档沉淀开始成为长期要求。

### 2026-07-20：统一配置与交互语义

- model-profile 在调研官方与社区方案后落地，覆盖 model+thinking、session/global、启动选择与快捷键。
- 共享配置迁移到 `terrific.json`，历史配置路径不再长期回落。
- slash 管理器被要求承担配置、快速应用与状态解释，而不只是开关。
- 全局菜单逐步形成循环选择、二级 Esc 返回、必要 tips、输入筛选等共同交互契约。

### 2026-07-21：展示层与控制面收敛

- presentation 追求低噪音、可下钻、保留真实结果的运行时呈现。
- 反复暴露双重提示、重复 progress、工具摘要重复、窄屏截断与状态所有权冲突。
- 工作流讨论从自动 hook 扩展到由主会话掌控 planner/worker/reviewer 的人类 control plane。

### 2026-07-22：摆脱脆弱依赖，明确 workflow 方向

- 修复 `pi-subagents` 的 TypeBox 依赖兼容问题。
- presentation 从外部 renderer fork 转向受控 native render compatibility layer，并继续处理回归。
- `/mode auto` 被重新定义为潜在 workflow 路由入口，而不只是工具集切换；该方向仍须以当前代码和已批准计划为准，不能把历史讨论冒充已交付事实。

## 3. 反复强调的长期契约

### 3.1 先调研，再决定复用还是新建

1. 先扫本仓现有实现与历史计划。
2. 再读官方 Pi 文档、示例和当前 API。
3. 再查社区包、上游 issue 与本机已装包。
4. 已覆盖大部分需求时优先配置、引用或薄适配；只有语义冲突且无法配置时才新建插件。
5. 新建或大改后，在能力账本写清“为何不能复用”。

### 3.2 参考产品不是规格

截图、Claude Code、Codex、Hermes、OpenCode 等只提供设计素材。现有 terrific-pi 的正确语义、用户当前目标和运行证据优先，不能因为参考图而丢失已有 main/branch、plain、progress 或权限语义。

### 3.3 feat 默认按整套系统设计

运行态能力必须检查：

- statusline 是否需要 badge/HUD，是否会重复展示；
- mode 是否改变工具权限或副作用边界；
- fast 是否应继承或明确不继承请求 tier；
- context 是否仍能解释上下文组成；
- btw/auxiliary/subagent 是否污染主 session；
- 配置是否应进入既有 `terrific.json`，而不是新增平行真源。

无联动也要留下“无需联动”的结论。

### 3.4 运行事实是唯一真相

- HUD 从真实事件、请求和完成状态派生，不能从 toggle 文案推断。
- presentation 只能改变呈现，不能改变工具结果、权限、安全网、上下文或终止语义。
- waiting、blocked、failed、completed 必须由状态机定义；最后一步不能在任务完成后继续显示 waiting。

### 3.5 同一事实只有一个展示所有者

statusline 负责常驻摘要，taskboard 负责任务进度，presentation 负责会话中的工具与系统事件。一个事实只能有一个主 renderer；其他层最多引用摘要或提供下钻，必须用明确的 key/event ownership 去重。

### 3.6 配置只有一个权威来源

- 本仓共享配置以 `terrific.json` 为主，statusline 独立布局保留在 `statusline.json`。
- 迁移完成后清理旧路径；除非存在有期限、有测试的兼容窗口，不做永久 fallback。
- project override 必须受 trust 与插件自身边界约束；auxiliary 模型路由不接受 project 偷换。

### 3.7 大改先确认，获批后完整交付

当用户要求“先汇报、先确认、批准后实施”时，不得提前写实现。方案获批后要按原始编号建立 acceptance checklist，连续完成约定 phase；不能只交付最显眼的一项，再把遗漏留给用户追问。

### 3.8 TUI 以语义完整和低噪音为准

- 一级菜单 Esc 取消，二级及更深层 Esc 返回上级。
- 全局选择器支持循环；长列表支持输入筛选或模糊匹配。
- tips 解释快捷键、作用域与破坏性影响，但不重复常识或长期占位。
- 无数据时可用 mock preview 帮助配置，但必须明确不是运行数据。
- 80/120/160 列与分屏是基础验收视口；关键信息不能被计数、长命令或装饰色挤出。
- 配置界面保持 KISS；核心展示效果不能以维护成本为由降级。

### 3.9 review、commit、push 是不同 checkpoint

- 实现后先跑针对性测试，再做 fresh-context review；重要问题修复后按风险复审。
- 提交前检查 diff、密钥、意外文件、原需求逐项覆盖和残留风险。
- commit 与 push 均需用户明确授权；要求提交不自动等于允许推送。

## 4. 反复踩坑与预防规则

| 事故模式 | 根因 | 以后如何防止 |
|----------|------|--------------|
| fast 只改 HUD，真实请求未生效 | UI toggle 被当作事实源 | 先测试 provider payload，再测 badge |
| taskboard/presentation/statusline 重复同一进度 | 多个插件同时拥有 renderer | feat 设计时写 ownership 表和去重 key |
| widget 移动、default/current 语义多轮翻转 | 先补局部交互，未定义不变量 | 先列状态机、排序规则和场景矩阵 |
| 参考截图覆盖既有语义 | 把示例误当需求 | 先写“保留行为”和“新增行为”两列 |
| 只完成任务的一部分 | 没有逐条 acceptance mapping | 最终验证逐项回看原始编号 |
| 外部 fork/依赖在新机失效 | 缺少兼容探测和离线边界 | 优先公共 API；外部 pin 固定版本并做安装冒烟 |
| 窄屏下时间、状态被挤出 | 只在宽屏验证 | 80/120/160 列回归，默认摘要限制长度 |
| 旧配置与新配置长期并存 | fallback 没有退出条件 | 一次迁移、明确删除、测试无回落 |
| 子代理并发写同一工作树 | 编排边界不清 | 默认单 writer；并行只做读取/评审，或显式 worktree |
| 归档夹带本地运行态 | 打包整棵工作树且误以为 `.gitignore` 会生效 | 打包使用顶层 allowlist，归档后检查 forbidden members |

## 5. 需求演进时的判定规则

历史 session 中存在真实的需求演进，不能简单取最早版本：

- fast：从 session toggle 演进为全局偏好，但只在符合条件的 GPT/OpenAI 请求上生效并真实退让。
- docsflow：曾是独立 slash 插件，也讨论过内化为 workflow；现状以代码、能力表和最新已批准计划为准。
- model-profile：`current`、`default`、冷启动和 `/new` 的语义经过多轮澄清，不能硬编码历史默认项。
- presentation：从 renderer fork 演进到受控、可卸载的 native render compatibility layer；不得因迁移而丢失用户输入、成功/失败状态和原生下钻能力。
- 工作流：从自动 hook 演进到主会话掌控的 planner/worker/reviewer control plane；任何 pilot/auto 行为在实现前仍需独立规格和权限边界。

冲突时采用以下优先级：当前明确用户指令 > 当前代码与测试 > 最新已批准设计 > `AGENTS.md`/能力表 > 历史 session 经验。历史经验用于解释和防复发，不用于绕过新决定。

## 6. 每次变更的最小复盘清单

1. 原始需求是否逐条映射到实现或明确非目标？
2. 是否先检查本仓、官方和社区实现？
3. 真实运行态、UI 状态和持久化状态是否一致？
4. 是否引入第二个配置真源或第二个展示所有者？
5. 是否检查已启用插件的联动与重复信息？
6. 是否覆盖窄屏、resume/reload/new、失败与无数据状态？
7. 是否有最小可运行测试，并实际看过失败再修复？
8. 是否做了独立 review，且逐项处置 finding？
9. 打包是否只含公开 payload，manifest 是否可审计？
10. commit/push 是否都在用户授权边界内？
