# Grok Build TUI 与 Pi 0.81.1 高保真复刻对比报告

> 日期：2026-07-22
>
> 状态：研究结论冻结；未开始实现
>
> 后续决策：用户不采用 pager 路线，选择路线 B（原生 Pi TUI + 公共 API + 现有 `presentation` 受控补丁）。现行计划见 [Grok 风格原生 Pi TUI 并行开发计划](./2026-07-22-grok-style-native-pi-tui-development-plan.md)。本报告的五路线能力研究保持不变。
>
> 命名更新：2026-07-23，原 `process-view` package 已更名为 `taskboard`；下文已使用现行 package/path 名称，`process_update` 与历史 session entry 兼容未变。
>
> 目标：逐项判断 Grok Build TUI 在 Pi 公共扩展、全屏 overlay、现有私有兼容层、Pi 宿主 fork、独立 Rust 前端五条路线上的可达上限

## 1. 结论

**基于源码静态复用率，最高还原候选不是给Pi当前TUI换主题，而是保留Grok Build的Rust/Ratatui pager作为视觉与交互真源，把Pi作为RPC agent后端。该候选必须先通过upstream build/PTY/license Phase 0，尚未获得运行时证明。**

原因不是颜色或组件数量，而是两边的根布局模型不同：

- Grok Build 是全屏、固定 viewport、显式 scrollback、sticky prompt、统一 hit-test、modal、Dashboard 和按状态调度动画的应用壳。
- Pi 0.81.1 的内建 TUI 是纵向 line-array transcript。公共 API 能换 theme、header、footer、editor、widget、working indicator，能打开 overlay，也能注册快捷键和自定义 renderer；但它不提供 transcript 根布局、内建消息几何、sticky scrollback、全局鼠标命中和多 session Dashboard 的组合接口。
- 当前 `presentation` 已能受控 patch `UserMessageComponent.render()` 与 `ToolExecutionComponent.render()`，适合提升现有 Pi TUI，但它仍处于 Pi 根布局之内。
- 一个持久的全屏 `ctx.ui.custom({ overlay: true })` 理论上可以覆盖整个 viewport，并自行维护第二套 transcript；这是公共 API 能达到的最高边界，但仍要重写 Grok 的 Ratatui 视图、滚动和鼠标系统，并与底层 Pi TUI 生命周期竞争。
- 复用 Grok pager 并接入 `pi --mode rpc`，可以直接保留布局、主题、diff、sticky prompt、Dashboard 外壳、mouse hit regions、动画调度和终端降级。需要新写的是协议适配和 Pi 语义映射，而不是重新猜测前端。

本报告不提供一个误导性的“总体还原百分比”。纯前端能力可直接复用并接近像素/行为一致；permission、plan、tasks、subagents 和 Dashboard 等后端绑定能力只能在 Pi 提供真实状态后复刻，不能用静态 UI 冒充。

## 2. 证据规则与版本基线

### 2.1 状态标签

- **Verified**：官方源码、官方文档、官方截图、当前安装代码或可复核运行状态直接支持。
- **Inferred**：由多个已验证事实推导，但尚未运行目标组合。
- **Unknown**：当前材料不足，不补写为事实。
- **Blocked**：依赖授权、外部环境或产品决策。

### 2.2 固定基线

| 对象 | 固定版本 | 证据 |
|---|---|---|
| Grok Build 公开仓库 | Git `3af4d5d39897855bdcc74f23e690024a5dc05573` | 本地 shallow checkout 与 `git rev-parse HEAD` |
| Grok Build 上游同步时间 | `2026-07-21T18:10:23+00:00` | Git commit metadata |
| Grok pager crate | `xai-grok-pager 0.2.109` | `crates/codegen/xai-grok-pager/Cargo.toml` |
| Grok 内部源修订 | `0f4d7c91b8b2b408333f6de1e8a76cb8eaa71899` | 根 `SOURCE_REV` |
| Pi agent | `@earendil-works/pi-coding-agent 0.81.1` | 本机安装 package metadata |
| Pi TUI | `@earendil-works/pi-tui 0.81.1` | Pi 嵌套依赖 package metadata |
| 官方视觉样本 | `universe-tui-screenshot-6f7a0837.png`，`1728x907` | 官方 README 资源 |

Grok 仓库 Git HEAD、crate 版本和 `SOURCE_REV` 是三个不同标识，报告中不混用。外部 changelog 本次可独立检索到的最新明确版本是 `0.2.106`；`0.2.109` 由公开源码直接确认，但没有找到对应独立 release page。

### 2.3 证据优先级

1. 当前固定 commit 的实现与测试。
2. 当前固定 commit 内的用户指南。
3. 官方截图、发布页和 changelog。
4. 有作者、日期和具体操作描述的实机体验。
5. 社区单条评论或 issue。

当文档与源码冲突时，以当前源码为准，并记录冲突。

## 3. 官方截图视觉解剖

官方截图是一个置于深色营销背景上的 macOS 风格终端窗口。背景、窗口阴影和标题栏不属于 Grok TUI 本身，不能作为终端内像素验收基线。窗口内部可直接观察到以下结构：

1. 顶部信息行：左侧 `~/Documents`，右侧 `9.5K / 500K`，低对比度显示工作区和上下文预算。
2. 用户 prompt：整宽深灰高亮带，左侧 `❯ explain the universe`，右侧时间戳 `8:19 AM`。
3. Thinking：单行 diamond 标识与 `Thought for 2.0s`，处于折叠态。
4. Assistant 内容：无外层卡片，H1 使用青绿色，H2 使用蓝色，正文为高对比灰白，段落间使用短水平分隔线。
5. Scrollback：右侧有细窄 scrollbar，底部中央有继续向下的三角提示。
6. Turn status：左侧 spinner/活动文本 `Responding... 15s`，右侧 `17s ↡9.45k [stop]`；计时、token 和 stop 固定在右侧。
7. Prompt editor：单线边框输入框，左侧 prompt arrow；底边右侧嵌入 `Grok 4.5 (High) · always-approve`。
8. Shortcuts bar：底部显示 `Shift+Tab:mode │ Ctrl+C:cancel │ Ctrl+.:shortcuts`，key 高亮、label 低对比。

这张截图验证了正常响应态的层级、密度和主配色，但没有验证 Welcome、diff、permission、plan、tasks、Dashboard、窄终端或动画逐帧行为；这些必须回到源码和 PTY 验收。

## 4. Grok Build TUI 的真实结构

### 4.1 应用与状态所有权

**Verified**：TUI 不是独立 widget 的松散集合，而是 `AppView -> AgentView -> Scrollback/Prompt/Overlay` 的 Elm 式状态、action、effect 和 render 系统。[G2]

- `AppView` 持有 welcome、active agent、Dashboard、全局 modal 和进程级状态。
- `AgentView` 持有 scrollback、prompt、queue、todo、tasks、permission、plan 和当前 turn 状态。
- 输入先解析为 `Action`，dispatcher 产生 `Effect`，effect 完成后再回写状态。
- 渲染函数同时产出可交互几何；mouse handler 消费最后一帧几何，不在输入层重新猜坐标。
- ACP tracker 将 agent 协议更新转成 scrollback block 变更；视觉状态不是从文案猜测。

这条边界对移植至关重要：permission、plan、queue、running tool、background watcher 必须由 Pi 真实事件驱动。

### 4.2 全屏和 Minimal 双模式

**Verified**：Grok 有 fullscreen Ratatui 模式和 scrollback-native Minimal 模式。全屏路径控制 alternate screen、raw mode、mouse capture、bracketed paste、keyboard protocol、focus 和恢复顺序；Minimal 使用不同的输入与 transcript 路由。[G16]

Pi 0.81.1 的 `pi-tui` 默认不是 alternate-screen 应用：它将所有组件渲染为字符串行，增量改写当前终端区域，resize 时可能清屏重绘。`ProcessTerminal.start()` 启用 raw mode、bracketed paste 和 keyboard protocol，但不启用 alternate screen 或 mouse capture。[P2][P4]

### 4.3 Agent 主布局

**Verified**：主视图按高度预算，而不是维护 80/120/160 三套模板。[G3]

纵向顺序为：

```text
status / warnings
optional tasks, catalog, todo
scrollback (minimum 5 rows)
btw / queue
turn status
banner / CTA / follow-ups
prompt
shortcuts
```

- `SHORT_TERMINAL_ROWS = 16`：隐藏 CTA、follow-ups 和底部 padding。
- `AUTO_COMPACT_MAX_ROWS = 20`：强制 compact render，但不改写用户持久配置。
- 宽度主要通过 Unicode-aware wrap/truncate、固定右侧预算、可选 scrollbar/timeline 和动态 hints 连续适配。
- 90 列是 Welcome side-by-side hero 的明确 breakpoint。
- 40 列是 Dashboard 的最低完整宽度；更窄时进入单列降级。

### 4.4 Welcome 与 top bar

**Verified**：[G17]

- 水平 margin 正常为 2、compact 为 1。
- menu 最小宽度 51，prompt 高度 3，version gap 1。
- hero box 仅在 `width >= 90` 且高度足够时 side-by-side；宽度上限 120。
- Logo 在高度 `<22` 隐藏，`22..25` 使用 small，`>=26` 使用 full；legacy ConHost 隐藏。
- Logo shimmer 以 12 FPS 重绘，4 秒周期，约 32% 周期执行 sweep，另有 5 秒低幅 breathing。
- top bar 从 per-cwd cache 读取 branch/worktree/cwd，渲染路径不执行 Git 子进程。

Logo 的动画算法可以复用；xAI/Grok 品牌资产不能因为代码是 Apache-2.0 就自动获得商标授权。

### 4.5 Scrollback、sticky prompt 与导航

**Verified**：sticky prompt 是独立纯算法，`MIN_PINNED_HEIGHT = 4`，header 与内容间隔 1 行。[G4]

- 每个 prompt 有 virtual Y、full/min height 和 sticky flag。
- prompt 滚过顶部后，header 随滚动逐行收缩。
- 下一 prompt 接近时，从顶部 clip 当前 header。
- `scroll_for_content = scroll_offset + header_height` 保持内容每次只移动一行，避免跳动。
- follow mode、manual fold、entry selection、turn/response jump、search、timeline 和 scrollbar 使用同一 scrollback state。

Pi 当前 transcript 没有可替换的 scroll model。只 patch 单条消息 renderer 无法得到 sticky prompt 或 block selection。

### 4.6 User、Thinking 与 Assistant block

**Verified**：[G5]

- User prompt 是 sticky 候选，可包含 timestamp 和 prompt chrome。
- Thinking 有 `Collapsed / Truncated / Expanded` 三态。
- 运行中显示 `Thinking...`；结束后显示 `Thought for Xs`。
- Truncated 由 header、ellipsis 和最后 N 行组成。
- 历史 replay 不启动本地 thinking timer，避免伪造 `0.0s`。
- Assistant Markdown 通过共享 parser、syntax theme 和 streaming cache 渲染。

当前 `presentation` 能高质量包装 Pi user message，并保留原 Markdown/OSC 区域；它不接管 assistant root block，也不建立 Grok 的三态 thinking 模型。[T1]

### 4.7 Tool block 与 diff

**Verified**：`ToolCallBlock` 是 Execute、Read、Edit、ListDir、Search、Web、MCP、Memory、Skill 等具体 block 的 sum type，共享 `DisplayMode`、fold、raw、selection、bullet、background 和 timing。[G6][G7]

关键实现：

- Execute 保存完整 command 和独立 `header_display`，支持 `$ command` 或 `Run ...`，shell syntax highlighting、物理换行与 hanging indent。
- Edit 首帧做 per-hunk syntect，高亮任务后台升级为 full-file scoped highlight。
- Full-file highlight 上限为 2 MiB 或 50,000 行；超限保持 hunk-only。
- Edit 默认显示单一行号列、indent 和 `...` hunk separator。
- Read 默认保留前 5 行、后 3 行，使用绝对行号、syntax highlight、range，并区分 image/PDF/skill。
- Unknown/custom tool 仍保留 raw fallback，不能因没有专用 renderer 丢失结果。

Pi 公共 API可以给扩展自己注册的 tool 定义 renderer，但没有 built-in tool renderer middleware。当前 `presentation` 通过受控 prototype patch 为 Pi 内建工具提供 collapsed lifecycle，并在 expanded 状态回退原生 renderer；它可以作为 Pi 语义映射参考，但不是 Grok diff 几何的直接复用。[T1]

### 4.8 Prompt/editor

**Verified**：Grok 的 `PromptWidget` 基于 `xai_ratatui_textarea::TextArea`，不是简单字符串输入框。[G8]

- multiline、history、slash suggestions、`@` file search。
- paste/file/image element model；large single-line paste 超过 10,000 bytes 变为 chip。
- preview、clipboard、voice interim text。
- boxed、minimal、overlay、plan tint、bash prefix、placeholder 和 session title 样式。
- Enter routing 会考虑 turn 是否运行、file search、queue/interject 和 multiline。

Pi 的 `setEditorComponent()` 足以实现自定义 editor，也注入 keybindings；但若追求 Grok 行为，仍需移植其 element model 和 routing，而不是只复制边框。[P1][P3]

### 4.9 Turn status、status bar 与 shortcuts

**Verified**：[G9][G10]

Turn status：

- 默认 animation tick 为 30 FPS，可配置。
- spinner 每 4 tick 换帧，约 7.5 FPS。
- monitor pulse 每 8 tick 换帧，约 3.75 FPS。
- waiting diamond 使用 `sin²(tick*0.08)`，亮度在 0.3 到 1.0，约 1.3 秒一周期。
- 先预算右侧 timer/token/buttons，只有 activity label 可以截断。
- 宽度低于 10 列不画。
- idle、drain blocked、permission wait、plan wait、running tool、background watcher 是不同分支。

Shortcuts：

- hint 从 action registry 生成，不是手写静态文案。
- compact 先保 pinned，再按预算加入普通 hint，最后强制 help hint。
- 分隔符固定为 `"  │  "`，无法完整放入下一项就停止。
- 超宽终端自然显示更多项，不需要 80/120/160 三份配置。

### 4.10 Modal、permission 与 plan

**Verified**：[G11]

- `ActiveModal` 是 command palette、settings、session/doc picker、shortcuts 和 confirmations 的单一 sum type。
- Permission 使用 FIFO `VecDeque`，仅 front request 可交互。
- Permission 支持 options/follow-up input、MCP tool/server scope、bash selection 扩缩。
- 默认高度至少 10、最多 80、上限为屏幕一半；expanded args 可使用更多空间。
- Plan 有 `Preview / Prompt / Commenting` 状态，支持 inline/file-backed source、逐行评论，以及 approved/abandoned/cancelled 结果。

这些视觉状态可以原样复用，但 Pi 当前没有与 Grok 完全同构的 permission/plan 协议。Pi RPC 的 extension UI `select/confirm/input/editor` 可以驱动一部分 modal；逐行 plan comment、bash scope 和 MCP scope 只有在 Pi 后端产生真实结构化请求后才能实现。

### 4.11 Tasks、todo 与 queue

**Verified**：[G12]

- Tasks 按 workflow、subagent、task、monitor、scheduled 类型分组；组内 running-first，subagent 还先按 agent type 排序，最终时间键为 newest-first。
- Todo 图标语义为 pending `□`、in-progress `▶`、completed check、cancelled X；最多 10 行且最多占总高度 15%，badge 变化闪烁 1200ms。
- Queue 显示 `#N`、首个非空行和 `(+N lines)`，先保留 suffix 宽度再截正文。
- 多个列表共享 `ListPane` 的选择、滚动、搜索、follow 和 mouse 行为。

Pi RPC 有 queue update、steer/follow-up、tool lifecycle；当前 `taskboard` 的 `process_update` tool 可提供结构化任务步骤。Grok 的 workflow/watcher 分类与 Pi subagent/background 状态仍需显式 adapter，不能只按工具名推断。

### 4.12 Dashboard

**Verified**：[G13]

- Dashboard 每帧从 agent roster 重建 rows，小规模列表不缓存。
- `MIN_DASHBOARD_WIDTH = 40`；更窄时单列和中间截断。
- list floor 为 12 行；peek 最大占总高 `floor(H * 3/8)`。
- live-tail box 最少 8 行，question/permission 最少 10 行，body 最多 28 行。
- 空间不足时保 roster，完全关闭 peek。
- 支持按状态分组、peek、attach、reply、dispatch、rename、pin、stop 和 mode change。

Pi 单个 RPC 进程只代表一个 active session；它不会自动提供跨独立 Pi 进程的 live roster。高保真 Dashboard 需要 frontend-owned session supervisor，管理它自己启动的多个 Pi RPC child，并将磁盘 session 发现与 live process state 分开。

### 4.13 Mouse、selection 与 clipboard

**Verified**：[G14]

- Grok startup 显式启用/禁用 mouse capture，并为 legacy ConHost 做特殊恢复。
- render 输出 `PaneAreas` 和 button rect；click/hover/drag 使用上一帧几何。
- scroll pipeline 区分 wheel/trackpad，按 terminal family 调整 acceleration 与 event cadence。
- scrollback 支持块选择、文本选择、link hover/open、context bar click 和拖拽。
- mouse reporting 可运行时关闭，以恢复终端原生文本选择。
- clipboard 路径包含 native clipboard、OSC52 和备份文件策略。

Pi 公共 API提供 raw terminal input listener；`ctx.ui.custom()` 还能拿到 `TUI` 实例。当前没有文档化的 mouse capture、mouse event parser、全局 hit-region registry 或恢复协议。全屏 overlay 可直接写 CSI 并解析 SGR mouse，但这已跨入低层终端所有权，必须自己保证 signal/reload/exception cleanup。

### 4.14 Theme、glyph 与终端能力

**Verified**：[G14]

默认 GrokNight 是中性灰阶底色加 TokyoNight accent：

| 角色 | 颜色 |
|---|---|
| terminal bg | `#0a0a0a` |
| main bg | `#141414` |
| highlight bg | `#242424` |
| primary text | `#e1e1e1` |
| secondary text | `#c8c8c8` |
| muted | `#6c6c6c` |
| blue | `#7aa2f7` |
| cyan | `#7dcfff` |
| green | `#9ece6a` |
| magenta | `#bb9af7` |
| orange | `#ff9e64` |
| red | `#f7768e` |
| plan gold | `#ffdb8d` |

- `Theme::current()` 根据 color level 量化并处理 Windows contrast/ANSI16 fallback。
- GrokNight/GrokDay 支持低色深量化；部分第三方 theme 要求 truecolor。
- glyph 层集中定义 prompt arrow、check/X、token arrow、diamond 和 spinner，并为 legacy ConHost 提供等宽 fallback。
- terminal detection 覆盖 Apple Terminal、Ghostty、iTerm2、Warp、WezTerm、Kitty、VS Code family、JetBrains、VTE、Windows Terminal、tmux/screen/Zellij。

Pi theme JSON 定义 51 个前景/背景 token并支持 truecolor 到 256 色降级，但 theme 只控制颜色，不控制 Grok 的布局、glyph 和量化策略。[P7]

### 4.15 动画与刷新调度

**Verified**：Grok 并非永久 30 FPS 空转。[G9][G17]

- `TickDemand::None` 时 event loop 停止动画唤醒。
- Welcome shimmer 使用 83ms slow tick，约 12 FPS。
- 可见真实动画使用配置的 `animation.fps`，默认 30。
- `/gboom` 至少约 30 FPS；Minimal transcript 可请求 16ms ceiling。
- draw throttle 默认 cadence 为 16ms，并可依据 display-refresh probe 和配置调整。
- spinner、pulse、todo flash 等在统一 tick 上降频。

Pi `TUI.MIN_RENDER_INTERVAL_MS = 16`，extension 可以 timer + `requestRender()` 动画；但宿主没有 Grok 的视图级 tick demand。持续 overlay 必须自行停止 idle timer。

## 5. 文档冲突：快捷键是否可 remap

当前官方文档互相冲突：

- `03-keyboard-shortcuts.md` 明确写“Bindings are built in and cannot currently be remapped”。
- `23-dashboard.md` 写 Dashboard shortcut 可在 `[keybindings]` 配置，且称其他 shortcut 同样可配置。

当前固定源码的 `ActionRegistry` 由 `defaults::default_actions()` 构造，提供 lookup、hints 和 terminal-family alternate keys，但没有读取 `[keybindings]`、应用 override 或修改 binding 的路径；全仓也没有找到该表的 parser。[G15]

**结论：在 `3af4d5d` / `0.2.109` 基线中，应按“用户不可自由 remap”处理。** Simple/Vim 模式和 terminal-family fallback 会改变有效按键，但不是通用配置 remap。Dashboard 文档和源码注释中的“configurable”属于未落地或已漂移描述。

## 6. Pi 0.81.1 能力边界

### 6.1 公共 extension API 能直接做什么

**Verified**：[P1][P3]

- 加载完整 theme，或运行时切换 theme。
- 替换 startup header 和 footer。
- 替换 editor；读取/写入 editor text，处理 paste 和 autocomplete。
- 在 editor 上下放 widgets。
- 修改 working message、spinner frames 和可见性。
- 打开有键盘焦点的 custom component 或 overlay。
- 监听 raw terminal input。
- 注册 extension shortcut、command、custom message renderer 和 custom tool renderer。
- 设置 terminal title。
- 监听 agent/message/tool/session/compaction/retry 生命周期。
- 发送 user message、steer、follow-up、abort、compact 和 session 操作。

### 6.2 普通公共 API 不能组合控制什么

**Verified**：当前 API 没有以下宿主级接口：[P2][P3]

- 替换 `InteractiveMode` 根 container 顺序。
- 获取/替换 `chatContainer` 或 transcript scroll model。
- 修改内建 user/assistant/tool 外壳的统一 renderer middleware。
- 将多个内建 transcript entry 合成一个宿主 block。
- 给内建 diff 指定行号列、hunk 几何和 selection model。
- 建立 sticky prompt 或固定高度 scrollback viewport。
- 注册全局 mouse hit regions 或接管 mouse capture 生命周期。
- 替换所有内建 modal。
- 获得多进程 live session roster。
- 组合多个 footer owner；`setFooter()` 是整体替换，没有 getter/链式 composition。

### 6.3 全屏 overlay 是公共 API 的理论上限

**Verified + Inferred**：`pi-tui` overlay 支持 100% 宽度、top-left 定位、按 terminal height 限制和 focus restore；overlay compositing 发生在 differential render 前。[P4]

一个 extension 可以：

1. 在 `session_start` 后打开持久 full-viewport overlay。
2. 从 `tui.terminal.rows` 得到高度并返回整屏行。
3. 用 extension events 重建自己的 transcript。
4. 用 `sendUserMessage()`、`abort()`、session API 驱动 Pi。
5. 自行 timer + `requestRender()`。
6. 自行写 mouse CSI、解析 raw SGR input、维护 hit rect。

因此“公共 API 完全做不了全屏界面”并不准确。准确表述是：**公共 API 能托管一个覆盖宿主的第二前端，但不提供 Grok 所需的 transcript/mouse primitives；实现者必须重写并拥有它们。**

剩余风险：

- 底层 Pi transcript 仍在构建和重绘，只是被覆盖。
- 任意其他 extension overlay、内建 dialog、reload、external editor 会参与同一个 focus stack。
- mouse CSI 和恢复不是文档化 extension contract。
- session hydration、branch navigation 和 custom entries 要维护第二套投影。
- Grok Ratatui 的 2D buffer、selection 和 terminal detection 不能直接复用。

### 6.4 当前私有兼容层

**Verified**：[T1]

`presentation` 是当前唯一私有 transcript renderer owner：

- patch `UserMessageComponent.prototype.render`。
- patch `ToolExecutionComponent.prototype.render`。
- compare-and-swap 卸载、引用计数、reload-safe。
- 不 patch execution/schema/permission，不注册同名 built-in tool。
- expanded 回到 Pi 原 renderer。

新增 Grok 主题不能再叠第二组相同 prototype patch。若继续走 Pi 内建 TUI，必须扩展 `presentation/lib/compat`，并保持它是唯一 owner。

### 6.5 Pi 宿主与 pi-tui fork

修改 `InteractiveMode` 和 `pi-tui` 可以加入：

- 固定 viewport scroll container。
- root layout slot。
- built-in message/tool renderer middleware。
- mouse capture/parser/hit regions。
- sticky prompt 和 Dashboard surface。
- alt-screen lifecycle。

这条路线能保留任意 Pi extension custom component，但仍需把 Grok 的 Rust 算法和 view 全量移植到 TypeScript line renderer，并持续跟随 Pi 私有类变化。它的上限高于普通 extension，低于直接复用 Grok pager。

### 6.6 Pi SDK 与 RPC 作为后端

**Verified**：[P5][P6]

SDK `AgentSession` 提供 prompt、steer、follow-up、abort、subscribe、model/thinking、compaction、session 和 tool lifecycle；RPC 将同一层暴露为严格 LF JSONL：

- prompt、steer、follow_up、abort。
- get_state、get_messages、get_entries、get_tree。
- model、thinking、queue mode。
- compact、retry、bash。
- new_session、switch_session、fork、clone、session stats。
- agent/message/tool/queue/compaction/retry events。
- extension UI select/confirm/input/editor/notify/setStatus/setWidget/setTitle。

RPC 限制：`custom()` 返回 `undefined`；component factory、custom editor、theme、header、footer 和 working indicator 不跨进程传输。`get_entries`返回pre-compaction history和abandoned branches，不是active-branch projection；`fork`/`clone`响应不返回新session identity；异步events没有统一id/sequence；命令集中没有`shutdown`。Extension UI中只有带`timeout`字段的`select/confirm/input`由agent自动到期，`editor`没有协议timeout；`extension_ui_response`没有ack，unknown/late id会被静默忽略。以上限制不阻止Rust pager自己渲染UI，但要求active-leaf hydration、post-command `get_state`、本地barrier、显式dialog cancel和process-level退出协议，也会降低任意Pi TUI extension的可视兼容性。

## 7. 当前 Terrific Pi 的显示所有权

| 事实 | 当前 owner | 高保真独立前端中的处理 |
|---|---|---|
| user/tool transcript | `presentation` compatibility layer | Rust pager 直接渲染 Pi RPC 事件；prototype patch 在 RPC 中无可见实例 |
| 请求级文件净变化 | `presentation` ArtifactJournal | **Blocked**：当前 RPC 模式计算 snapshot 但不 append artifact entry；需由 `presentation` 在显式 custom-host gate 下发布 versioned state，保持它是唯一 journal owner |
| 多步任务 | `taskboard` / `process_update` | 解析 tool args/result；恢复 durable state 时只读取 active leaf chain，渲染为 Grok todo/tasks pane |
| footer | `statusline` | Pi TUI 中仍为唯一 owner；RPC 中不创建 footer，独立前端从 Pi state重建 status/shortcuts |
| execution mode | `mode` status key | 消费 RPC `setStatus` 或读取配置，只作显示，不把未认证 status key用于权限判断 |
| fast priority | `fast` status key | 同上 |
| btw side session | `btw` isolated session | **Blocked**：当前 `/btw` 明确拒绝非 TUI；需新增经过测试的 RPC/custom-host执行路径，不能只消费不存在的 live status |
| 最终回答 | Pi assistant message | Grok assistant block renderer |
| subagent run | `pi-subagents` tool/runtime | 从真实 tool/async state适配，不以 HUD toggle 推断 |

## 8. 逐项可达矩阵

等级：

- **E**：可复用原实现，预期达到 exact/near-exact。
- **H**：可高保真实现，但需要移植或 adapter。
- **P**：只能部分或近似。
- **N**：该路线没有可信实现入口。
- `*`：视觉可达，但后端语义仍取决于 Pi 真实能力。

| 能力 | 普通 extension | 全屏 overlay extension | 现有 compat 扩展 | Pi/`pi-tui` fork | Grok pager + Pi RPC |
|---|---:|---:|---:|---:|---:|
| GrokNight palette | H | H | H | H | E |
| 全屏固定 viewport | N | H | N | H | E |
| alternate-screen lifecycle | N | P | N | H | E |
| Welcome 三档布局 | P | H | N | H | E |
| Logo shimmer 算法 | P | H | N | H | E，品牌资产 Blocked |
| top bar / worktree / context | H | H | P | H | E/H |
| sticky prompt | N | H | N | H | E |
| scroll follow/search/timeline | N | H | P | H | E |
| block/文本选择与复制 | N | H | P | H | E |
| user prompt 几何 | P | H | H | H | E |
| Thinking 三态 | P | H | P | H | E/H |
| Assistant Markdown | P | H | P | H | E/H |
| Execute/Read/Edit block | P | H | H | H | E/H* |
| Grok diff 几何与高亮升级 | N | H | P | H | E |
| unknown tool raw fallback | H | H | H | H | H |
| Prompt TextArea/chips | H | H | P | H | E |
| turn status 宽度预算 | P | H | P | H | E/H* |
| 7.5 FPS spinner / pulse | H | H | H | H | E |
| 动态 shortcuts | P | H | P | H | E |
| 通用 modal chrome | H | H | P | H | E |
| Permission queue | P* | H* | P* | H* | H* |
| Plan preview/comment/approve | N* | H* | N* | H* | H* |
| todo/tasks/queue pane | P* | H* | P* | H* | H* |
| Dashboard roster/peek | N | P* | N | P* | H* |
| mouse hover/click/drag | N | H，需低层 CSI | N | H | E |
| trackpad/wheel tuning | N | P | N | H | E |
| terminal family detection | P | P | P | H | E |
| ANSI16/256 glyph fallback | P | H | P | H | E |
| arbitrary Pi custom TUI extension | E | P | E | E | P/N |
| print/json/rpc 非 TUI | E | E | E | E | H，直接委托 Pi |

### 8.1 不可被视觉移植解决的语义差异

| Grok 能力 | Pi 0.81.1 对应事实 | 结论 |
|---|---|---|
| ACP thought/message stream | RPC message_update / assistant metadata | 可适配 |
| ACP tool call/update | RPC tool_execution start/update/end | 可适配 |
| queue/interject | RPC queue_update、steer、follow_up | 可适配，术语不同 |
| cancel | RPC abort | 可适配 |
| model/effort | RPC set_model / set_thinking_level | 可适配 |
| compaction | RPC compact + compaction events | 可适配 |
| permission request | extension UI select/confirm 或安全工具结果 | 部分可适配；没有统一 Pi permission schema |
| plan line comments | 无同构公共事件 | 需一等 plan state/bridge，不能伪造 |
| todo | `process_update` 结构化步骤 | 可作为 Terrific Pi 对应物 |
| background watcher | tool/subagent runtime，非统一 schema | 需 adapter 和明确 owner |
| Dashboard leader roster | 单 RPC process 不提供 | 需 frontend session supervisor |
| xAI voice/video/marketplace | Pi 无同构核心能力 | 非核心视觉可保留壳，但不得宣称功能等价 |
| arbitrary custom component | RPC 不传组件 | 独立前端无法通用复用 |

## 9. 五条路线比较

### 9.1 路线 A：普通 theme + extension

适合：快速获得 GrokNight 色彩、header/footer/editor、working spinner 和部分工具文案。

上限：不能改变 transcript 根几何、sticky prompt、全局 scroll/mouse、内建 modal 和 Dashboard。它是“Grok 风格 Pi”，不是 Grok TUI 复刻。

### 9.2 路线 B：扩展现有 `presentation` 私有兼容层

适合：继续改善当前 Pi TUI 的 user/tool/diff 呈现，同时保留 Pi 原生交互和全部 extension compatibility。

上限：仍被 `InteractiveMode` root container 和 inline transcript 约束。继续 patch 更多内建 class 会快速扩大版本耦合，且 sticky scrollback/Dashboard 仍无自然所有权。

### 9.3 路线 C：持久全屏 overlay extension

适合：在不 fork Pi core 的前提下构建第二前端，保留 extension runtime 和同进程 API。

优势：理论上可以覆盖整个 viewport、拥有 editor、shortcuts、动画和大部分 transcript。

问题：必须把 Grok Ratatui 前端重写成 TypeScript line renderer；mouse 需要自行写 CSI；底层 Pi UI 仍运行；overlay/focus/reload 与其他扩展竞争。它是高上限备选和快速 prototype 路线，不是最高确定性路线。

### 9.4 路线 D：fork Pi `InteractiveMode` / `pi-tui`

适合：产品要求保留任意 Pi custom component、theme 和 editor extension，并接受长期维护宿主 fork。

优势：可建立真正 root slot、mouse 和 fixed viewport，不需要运行两个可见 UI。

问题：仍需重写 Grok view；Pi 每次升级都要审阅私有 host 差异。视觉上限高，但复用率低于 Rust pager。

### 9.5 路线 E：Grok Rust pager + Pi RPC backend

适合：本任务的最高还原目标。

优势：直接复用 Grok 的 2D buffer、layout、sticky、diff、prompt、Dashboard、mouse、animation、terminal detection 和现有测试；Pi RPC 是文档化 subprocess 协议，不依赖 `InteractiveMode` 私有 shape。

问题：ACP 与 Pi RPC 不同；Grok pager 当前高度依赖 xAI workspace/shell/agent crates，不能只复制一个 crate；任意 Pi custom TUI component 不能跨 RPC；Dashboard 需要 supervisor。

**条件式首选：路线 E。** 它在源码复用层面具有最高还原上限，但只有 Phase 0 证明固定 upstream 能构建、运行、取得原版 PTY/buffer 基线并闭合许可依赖后，才进入实现。若 Phase 0 因不可分离依赖、不可运行前端或再分发限制失败，go/no-go 评审在路线 C（公共 overlay，优先保留 Pi 扩展兼容）与路线 D（宿主 fork，优先建立根布局能力）之间重选。路线 B 继续服务现有 Pi TUI，不与独立前端叠加 owner。

## 10. 社区实机证据与已知问题

社区样本很少，不能形成统计性结论。

### 10.1 官方可证迭代

官方 changelog 记录了以下 TUI 问题和改进：[C1]

- 高负载或慢连接下滚动更平滑，加入 display refresh matching 和 presentation latency 约束。
- background work count 从 transcript 重复消息改为 persistent status line。
- parked subagent 重复/交错、queued message 短暂消失等状态时序修复。
- very long reasoning、数千 styled spans 曾造成 freeze/100% CPU。
- markdown table ghost cell、HTML entity、浅色 minimal syntax highlight 和输入 `[` 延迟修复。
- `0.2.106` 增加 `GROK_CLIPBOARD_NO_OSC52` 和复制备份文件，缓解不支持 OSC52 的终端。

这说明 Grok 的目标是平滑、持久状态和终端适配，也说明这些路径必须纳入回归，不应只验静态 screenshot。

### 10.2 独立体验

- Medium 实机文章认为完整 trace 可导航、折叠、单键复制，计划/技能/并行 subagent 在同一终端表面是主要优点；同时明确称 TUI 仍在演进。[C3]
- Hacker News 有用户称界面“quite beautiful”，并将其误认为 Textual；参与讨论的 TUI 工程师提到 alt-screen 和回归防护投入。样本仅为单条评论，不代表社区共识。[C4]
- 一个 SSH/Termius/headless Linux clipboard issue 报告 native clipboard 与 OSC52 均失败，后续官方 changelog 有对应缓解。[C5]

Reddit、X 和 YouTube 本次没有取得足够具体、可复核的 TUI 评价或逐帧材料，不纳入结论。

## 11. 许可、归属与品牌

**Verified**：公开仓库根许可证为 Apache-2.0，版权声明 `Copyright 2023-2026 SpaceXAI`。[G18]

直接复制或修改 substantial code 时必须：

1. 给接收方提供 Apache-2.0 license。
2. 修改文件带显著变更声明。
3. 保留与所用代码相关的 copyright、patent、trademark 和 attribution notices。
4. 分发被纳入的 third-party 代码时保留对应 notices/license。

根仓没有根级 `NOTICE`，但存在 `third_party/NOTICE` 和 `THIRD-PARTY-NOTICES`；实际分发依赖闭包决定必须携带哪些条目。

Apache-2.0 第 6 节不授予 trade name、trademark、service mark 或 product name 使用权。因此：

- 可以在文档中说明代码来源。
- 默认不直接发布 xAI/Grok logo、产品名或误导性品牌外观。
- 高保真实现应先用中性 `Terrific TUI` 标识替换品牌资产，同时保留相同布局和动画算法。
- 原 Logo 的直接发布属于 **Blocked：需要品牌/商标授权确认**。

## 12. 未验证项

- 尚未编译或运行固定 Grok checkout；源码响应式结论来自实现与测试。
- 尚未生成 Grok 自身的 80/120/160 PTY captures。
- 官方截图只覆盖单一正常响应态。
- 没有官方帧率、CPU、内存和终端矩阵性能基准。
- 尚未实现 Pi RPC -> ACP/view-state adapter，因此 permission、plan、subagent、custom entry 的精确字段映射仍是设计结论。
- 当前 `presentation` 在 RPC 模式不持久化 system/artifact visual entries；请求级净文件状态 transport 尚未建立。
- 当前 `/btw` 拒绝非 TUI 模式；custom-host执行路径尚未建立。
- `get_entries` 包含 abandoned branches；active-leaf过滤和 hydration/live-event barrier 尚未实测。
- 尚未验证长期 full-screen overlay 在 reload、external editor、多个 extension overlay 和巨大 transcript 下的行为。
- xAI logo/产品名发布授权未知。

这些未知项不会改变“最高视觉复用应以 Rust pager 为真源”的架构结论，但会决定后续某些后端绑定能力能否标为 E 而不是 H/P。

## 13. 证据索引

### Grok 官方源码与文档

- **[G1]** [官方 README 与 TUI 截图](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/README.md)
- **[G2]** [TUI crate architecture](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/README.md)
- **[G3]** [Agent layout](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/agent.rs#L80)
- **[G4]** [Sticky prompt algorithm](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/scrollback/sticky.rs#L23)
- **[G5]** [Thinking block](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs#L14)
- **[G6]** [Tool block sum type](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/mod.rs#L145)
- **[G7]** [Execute](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/execute.rs#L17), [Edit](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs#L1), [Read](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/read.rs#L15)
- **[G8]** [PromptWidget](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/prompt_widget/mod.rs#L1)
- **[G9]** [Turn status and animation constants](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/turn_status.rs#L1)
- **[G10]** [Shortcuts bar](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/shortcuts_bar.rs#L18)
- **[G11]** [Modal](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/modal.rs#L156), [Permission](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/permission_view.rs#L1), [Plan approval](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/plan_approval_view.rs#L27)
- **[G12]** [Tasks](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/tasks_pane.rs#L1), [Todo](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/todo_pane.rs#L85), [Queue](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/queue_pane.rs#L1)
- **[G13]** [Dashboard layout](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/dashboard/layout.rs#L9)
- **[G14]** [GrokNight](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager-render/src/theme/groknight.rs#L1), [glyphs](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager-render/src/glyphs.rs#L1), [terminal detection](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs#L51)
- **[G15]** [ActionRegistry](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/actions/mod.rs#L225), [keyboard guide](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md#L1), [Dashboard guide](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/docs/user-guide/23-dashboard.md#L1)
- **[G16]** [Screen mode and terminal lifecycle](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/app/mod.rs#L99)
- **[G17]** [Welcome](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/welcome/mod.rs#L49), [Logo shimmer](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager/src/views/welcome/logo.rs#L16)
- **[G18]** [Apache-2.0 license](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/LICENSE)

### Pi 0.81.1 本机证据

- **[P1]** `@earendil-works/pi-coding-agent/docs/extensions.md` 与 `docs/tui.md`
- **[P2]** `dist/modes/interactive/interactive-mode.js`：root container、widget、header/footer 和 extension UI binding
- **[P3]** `dist/core/extensions/types.d.ts`：`ExtensionUIContext`、events、session control
- **[P4]** `@earendil-works/pi-tui/dist/tui.js` 与 `terminal.js`：line render、overlay、focus、differential update、terminal lifecycle
- **[P5]** `@earendil-works/pi-coding-agent/docs/rpc.md`
- **[P6]** `@earendil-works/pi-coding-agent/docs/sdk.md`
- **[P7]** `@earendil-works/pi-coding-agent/docs/themes.md`

### Terrific Pi 本机证据

- **[T1]** `extensions/presentation/lib/compat/index.ts`、`extensions/presentation/README.md`
- **[T2]** `extensions/statusline/extensions/statusline.ts`、`extensions/statusline/README.md`
- **[T3]** `extensions/taskboard/extensions/taskboard.ts`、`extensions/taskboard/README.md`

### 官方发布与社区材料

- **[C1]** [Grok Build official changelog](https://x.ai/build/changelog)
- **[C2]** [Open source announcement](https://x.ai/news/grok-build-open-source), [Agent Dashboard announcement](https://x.ai/news/agent-dashboard)
- **[C3]** [Cobus Greyling hands-on article](https://cobusgreyling.medium.com/grok-build-cli-b1c069393483)
- **[C4]** [Hacker News discussion](https://news.ycombinator.com/item?id=48139115)
- **[C5]** [SSH/OSC52 clipboard issue](https://github.com/xai-org/grok-build-plugin-cc/issues/1)
