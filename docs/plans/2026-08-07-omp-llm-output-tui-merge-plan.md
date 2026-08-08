# OMP LLM 输出 TUI 调研与合并计划

> 日期：2026-08-07
> 状态：方案 A（平衡侵入版）已实施，验证中
> 适用仓库：`terrific-pi`
> 目标范围：只改善 LLM transcript 的输出体验，不接管或重绘 `appearance`、`statusline`、`taskboard` 等已有界面所有者
>
> **实施修订（后续用户决策）**：初版调研建议只保留 user/tool 两个私有 patch；用户随后明确选择并授权平衡侵入版方案 A，增加 host shape gate 下的第三个 target：`AssistantMessageComponent.prototype.render`，并进一步移除硬编码 Pi 版本 allowlist。该 patch 只装饰 Pi 原生 render 输出，用于 hidden-thinking pulse、最终清理与首个 native spacer 清理；不创建第二 transcript，不写 session/context，不调用 working/header/editor/footer/widget setters，也不注册 Markdown transformer。`style: "classic"` 动态恢复原 presentation 投影。本文后续关于“禁止第三 target”“hidden thinking 只能等待上游”和“两 target scope”的早期结论，均以本修订及第 16 节最终标准为准。

## 1. 结论

不应把 `@oh-my-pi/pi-tui`、OMP `InteractiveMode` 或 OMP theme 包整体合入 `terrific-pi`。这些能力属于宿主 TUI，不是可组合 extension；整体移植会形成第二套 transcript/runtime，并直接碰撞现有插件。

推荐路线是“以 OMP 为视觉行为参考，继续运行 Pi 原生 transcript”：

1. 保留 Pi 0.84.1 原生 `AssistantMessageComponent` 内容构建、Markdown、session replay 和 regular/fullscreen 根布局；只装饰其最终 render 行。
2. `presentation` 继续是 transcript 唯一自定义所有者；私有兼容层精确允许 `AssistantMessageComponent.render`、`UserMessageComponent.render` 与 `ToolExecutionComponent.render` 三个 target。
3. Phase 0 未证明需要纯 Markdown 变换，因此不调用 `registerMarkdownTransformer()`，也不增加第二套 Markdown 规则。
4. hidden-thinking starburst、真实 usage token 计数/滚动速度与 final placeholder 清理可在已授权 assistant render decorator 内有界实现；smooth reveal、assistant block settled rows、native scrollback rebuild 和局部 Markdown engine 仍等待上游接口。`setWorkingIndicator()` 控制另一个无 owner/disposer 的全局 surface，明确不调用。
5. 继续向 Pi 上游争取 assistant decorator/thinking renderer、局部 Markdown theme 和 scoped surface ownership；本仓不新增第四个 prototype patch。
6. OMP 主题只作为颜色和 glyph 的取样来源，不安装整套 theme，不修改全局 theme 选择。这样不会改变 editor、header、footer、selector、taskboard HUD。

这条路线保证 session/context 和插件所有权不变。当前实现只复刻有明确边界的 pulse、spacing 和 tool block 行为；30fps reveal、settled scrollback 等宿主级体验仍必须等上游组合接口。若必须达到像素级 OMP 一致性，需单独批准 Pi host fork；它不是本计划路径。

## 2. 已验证基线

| 对象 | 已验证版本/提交 | 说明 |
|---|---|---|
| OMP 源码 | `3a8591a8af5b6d200088d12ca75a5517cb064fa8` | 本次所有 OMP 结论以该 checkout 为准 |
| `@oh-my-pi/pi-coding-agent` | `17.2.10` | OMP 完整 coding-agent fork |
| `@oh-my-pi/pi-tui` | `17.2.10` | OMP 完整 TUI fork |
| 本机 Pi runtime | `0.84.1` | 当前实际运行真值 |
| 根仓开发基线 | `0.83.0` | 根 `package.json` 的 Pi devDependencies |
| `presentation` 包开发基线 | `0.83.0` | 已与根仓基线对齐；runtime shape probe 另验证 0.81.1/0.84.1 |

OMP source：`https://github.com/can1357/oh-my-pi` @ `3a8591a8af5b6d200088d12ca75a5517cb064fa8`。

Pi 0.84.1 runtime 通过安装包 namespace 与实际 render probe 验证，不在仓库文档固化机器路径。

版本错位通过 host shape probe 处理；0.81.1/0.83.0/0.84.1 保留为注入式实际 render probe 证据，不构成运行时白名单。

## 3. 范围与所有权

### 3.1 本轮包含

- assistant text、visible/hidden thinking、streaming working 状态、最终回答和 inline error 的显示体验。
- live stream、final、resize、`/resume`、`/tree`、`/compact` 后 replay 的一致性。
- transcript 内已由 `presentation` 拥有的 user frame 和 compact tool row 的兼容性验证。
- OMP 视觉语言中可局部使用的 glyph、动画节奏和 semantic color 用法。
- 0.83.0 与 0.84.1 的 API/shape probe。

### 3.2 本轮不包含

- 不替换 Pi root TUI、terminal driver、session manager、provider stream 或 `InteractiveMode`。
- 不安装 OMP 的 98 个默认主题，不切换全局 theme，不增加 OMP statusline。
- 不调用新的 `setHeader()`、`setEditorComponent()`、`setFooter()`、`setWidget()`、`setWorkingIndicator()` 或 `setWorkingMessage()`。
- 不改 `appearance`、`statusline`、`taskboard` 源码、配置或持久状态。
- 不改 tool definition、tool execution、permission、sandbox、remote execution 或模型上下文。
- 不创建第二份 transcript，不使用 fullscreen overlay 模拟聊天历史。
- 不把 UI 状态写成 `custom_message`，不新增进入 LLM context 的消息。
- 不依赖 0.84 experimental fullscreen 的私有 layout class/field。

### 3.3 现有所有者必须保持

| Surface | 当前唯一所有者 | 本计划约束 |
|---|---|---|
| Assistant Markdown/final answer | Pi core | 保持 native；只使用公开 display hook |
| User prompt frame | `presentation` compat | 保留现有 patch 和 native fallback |
| Tool rows/file receipt | `presentation` compat | 保留现有 patch；expanded 继续回原生 |
| Header/editor | `appearance` | 不调用对应 setter；保留 foreign editor guard |
| Footer | `statusline` | 不调用 `setFooter()` |
| Task HUD/process state | `taskboard` | 不增加重复进度条、entry 或 widget |
| LINE0 editor border | `appearance` pixels + `statusline` data | 不接入、不改事件协议 |
| Working indicator/message | Pi host 全局 last-writer surface | 当前 API 无 getter、owner key 或 disposer；本计划不占用，需先上游 scoped ownership |

现有依据：

- [`presentation` compatibility installer](../../packages/interface/presentation/lib/compat/index.ts)
- [`presentation` prototype patch lifecycle](../../packages/interface/presentation/lib/compat/prototype-patch.ts)
- [`appearance` foreign editor guard](../../packages/interface/appearance/extensions/appearance.ts)
- [`statusline` footer owner](../../packages/interface/statusline/extensions/statusline.ts)
- [`taskboard` process/HUD owner](../../packages/interface/taskboard/extensions/taskboard.ts)
- [当前 capability map](../CAPABILITIES.md)
- [已冻结 presentation ownership 设计](./2026-07-22-presentation-remediation-design.md)

## 4. OMP 输出链路的全部参与方

OMP 的可见效果不是单个 theme 或 message component 产生的。它由以下四层共同决定。

### 4.1 Terminal 与 native primitives

| 参与方 | 对输出的影响 | 合并决策 |
|---|---|---|
| `packages/tui/src/terminal-capabilities.ts` | terminal ID、truecolor、OSC 8、Kitty/iTerm2/SIXEL、DECCARA、screen-to-scrollback | Host-only；继续用 Pi runtime 能力检测 |
| `packages/tui/src/utils.ts` | ANSI/OSC-aware width、wrap、slice、truncate；OSC 66 text sizing 宽度修正 | Host-only；不得在 extension 复制第二套宽度模型 |
| `crates/pi-natives` | syntax highlight、SIXEL、text measurement 等 Rust N-API | 不引入 Rust/native dependency |
| `packages/tui/src/kitty-graphics.ts` | Kitty Unicode placeholder 图像占位和 cell 几何 | 继续依赖 Pi native image path |

关键证据：

- [OMP terminal capabilities](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/tui/src/terminal-capabilities.ts#L98)
- [OMP ANSI/OSC width model](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/tui/src/utils.ts#L223)

### 4.2 `@oh-my-pi/pi-tui` 核心渲染

| 参与方 | 对输出的影响 | 合并决策 |
|---|---|---|
| `TUI` differential renderer | frame diff、cursor movement、synchronized output、native scrollback | Host-only |
| `NativeScrollbackLiveRegion` | 标记 live/committed 接缝，避免已提交历史被重画 | Pi 0.84 当前无同等公开契约；需上游 |
| DECCARA fill planner | Kitty 矩形 SGR 优化 | Host-only |
| `Markdown` | token layout、code highlight、table、links、HTML、math、stream cache | 不 vendoring；保留 Pi native Markdown |
| `Image` | protocol-specific inline image | 保留 Pi native |
| Component contract | `render(width)`、`invalidate()`、`dispose()` | 可依赖公开接口，不依赖实现类私有字段 |

OMP `Markdown` 已超过普通视觉 formatter：它包含 streaming stable-prefix、table layout lock、OSC 66 heading、Unicode math、HTML normalization、color swatch、Mermaid/async reflow 配合和模块级 cache。单独复制该文件仍无法得到 OMP 行为，因为它依赖 OMP TUI 的 committed-row 协议、terminal singleton 和 native primitives。

关键证据：

- [OMP live-region contract](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/tui/src/tui.ts#L209)
- [OMP Markdown component](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/tui/src/components/markdown.ts#L1415)

### 4.3 OMP coding-agent 交互与 transcript

| 参与方 | 视觉/交互职责 | 可移植性 |
|---|---|---|
| `theme/theme.ts` | 语义色、Markdown/editor/list adapter、symbols、spinner、terminal color mode | 只能取样；整体 theme 会泄漏到全局 UI |
| `AssistantMessageComponent` | text/thinking/image/error、hidden-thinking pulse、token speed、fast path、settled rows | 保留原生内容/Markdown；仅在 host shape 兼容时装饰最终 render 行 |
| `ToolExecutionComponent` | pending/partial/final、spinner、diff preview、custom renderer、images | 部分行为可在现有 tool compat 内重做，不复制组件 |
| `ReadToolGroupComponent` | 连续 read 分组、preview、usage attachment | 与 OMP event/replay 深度耦合；保留当前 exploration grouping |
| `BashExecutionComponent`/`EvalExecutionComponent` | streaming output 和展开 | 保留当前 Pi/native fallback |
| `StreamingRevealController` | 30fps、grapheme-level 平滑揭示 | Host event-controller 能力；extension 不可安全注入 |
| `TranscriptContainer` | block sealing、settled rows、committed/live compose、displaceable snapshot | Host-only；不可作为普通 component 插入现有 root transcript |
| `ChatTranscriptBuilder` | session entry -> user/assistant/tool/read group 重建 | Host/session 强耦合 |
| `EventController` | message/tool/turn 生命周期组装、reveal、错误 banner、read grouping | Host-only |
| `InteractiveMode` | root component tree、setting、input、transcript rebuild、terminal lifecycle | Host-only |
| `CompactionSummaryMessage`/branch summary | compaction 与分支切换后的 durable transcript 行 | 保留 Pi native；必须纳入 replay fixture |
| `SkillMessage`/usage row/stripped-tool placeholder | skill、token usage、被隐藏 tool call 的替代行 | 保留 native；不得被 assistant transform 误改 |
| Error banner/retry/late diagnostics | provider error、retry countdown、延迟诊断和恢复状态 | Host/controller 所有；纳入共存测试 |
| Custom message/custom entry renderer | extension 消息和 UI-only durable entry | 保留各插件 renderer；不改注册优先级或内容 |

关键证据：

- [OMP assistant message](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/coding-agent/src/modes/components/assistant-message.ts#L277)
- [OMP 30fps reveal](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/coding-agent/src/modes/controllers/streaming-reveal.ts#L216)
- [OMP transcript container](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/coding-agent/src/modes/components/transcript-container.ts#L159)
- [OMP transcript builder](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/coding-agent/src/modes/components/chat-transcript-builder.ts#L80)
- [OMP tool execution](https://github.com/can1357/oh-my-pi/blob/3a8591a8af5b6d200088d12ca75a5517cb064fa8/packages/coding-agent/src/modes/components/tool-execution.ts#L277)

### 4.4 Extension、settings 与 keybindings

| 参与方 | 作用 | 合并决策 |
|---|---|---|
| Theme/settings | `theme.*`、`symbolPreset`、`transparent`、`tui.tight`、`tui.scrollbackRebuild`、`display.smoothStreaming` | 不写 live Pi settings；只记录为 OMP 基线 |
| Tool renderer API | call/result component、partial、expanded、spinner frame | Pi 对 built-in tool 无独立 middleware；沿用现有 compat |
| Message/thinking renderer | OMP 可注册 custom message 和 assistant thinking renderer | Pi 0.84 没有等价 assistant thinking renderer；需上游 |
| Pi custom message/entry renderer | `sendMessage` 进入 context；`appendEntry` 仅 UI/session | 保持现有类型和 renderer；fixture 分别验证 context 与 UI-only 语义 |
| Compaction/branch/retry surfaces | replay、summary、retry/error/status 行 | Host-owned；transformer 与 compat 不得吞掉或重复 |
| Working indicator/message setter | 全局 working-loader 设置，last-writer-wins | 不是 transcript thinking hook；没有 owner introspection，不使用 |
| Keybindings | global expand、interrupt、follow-up、selector | 不接管已有 keymap；继续用 Pi `app.tools.expand` |
| Hook/custom UI | overlay、temporary components | 不用于 transcript 重建 |

## 5. Theme 差异与隔离结论

直接比较 OMP 17.2.10 和 Pi 0.84.1 内置 dark theme：

- OMP `dark.json` 有 67 个 color token，Pi 有 53 个。
- OMP 独有 16 个 token：`link`、`pythonMode` 以及 14 个 statusline 相关 token。
- Pi 独有 `scrollbarThumb` 与 `thinkingMax`。
- OMP 内置 98 个 default theme；当前 Pi package 没有同目录的批量 defaults。

这些数量差异不等于可以安全导入。Pi theme 是进程级语义色源；一旦切换，assistant、editor、header、footer、selector、taskboard 和第三方 component 都会一起改变。由于本任务明确只限 LLM 输出，合并方案必须遵守：

1. 不新增全局 OMP theme resource。
2. 不修改用户 `theme.dark`、`theme.light`、`transparent` 或 `symbolPreset`。
3. 可从 OMP default dark 取样 glyph 和动效节奏。
4. 局部颜色优先通过当前 `ctx.ui.theme` 的 `accent`、`thinkingText`、`muted`、`error` 等现有 token表达，不增加平行 palette。
5. 若将来 Pi 提供 per-message `MarkdownTheme` hook，再考虑 assistant-local palette；在此之前不注入裸 ANSI 来绕过 Markdown/theme。

## 6. OMP 与 Pi 0.84.1 的关键差异

### 6.1 OMP assistant 特征

OMP `AssistantMessageComponent` 包含以下 Pi 0.84.1 原生组件没有的行为：

- hidden thinking 使用 8 帧 starburst 动画，并显示 provider token 总数和滚动 tokens/s。
- assistant update 走 fast path，只更新最后一个 Markdown child。
- visible thinking 支持 prose-only 格式化和 OMP extension renderer。
- assistant/tool images 进行 Kitty PNG conversion 和 budget 控制。
- provider error 最多显示 8 行，`Ctrl+O` 展开完整错误，并与 pinned banner 去重。
- cache invalidation marker、post-finalize block version、Mermaid reflow gate。
- 向 `TranscriptContainer` 报告 settled leading rows，允许一条仍在 streaming 的消息分段进入 native scrollback。

这些行为不是 `render(width)` 的单点样式，依赖 event controller、usage 数据、terminal image protocol、Markdown cache 和 transcript commit 协议。

### 6.2 OMP streaming 与 transcript 特征

- `StreamingRevealController` 以 30fps 对 grapheme 计数和切片。
- `TranscriptContainer` 区分 mutable tail 与 immutable native scrollback。
- finalized/displaceable block 可以 seal、compact、replay。
- `tui.scrollbackRebuild` 可在直接终端清空并重建历史，multiplexer 下禁用破坏性路径。
- `ChatTranscriptBuilder` 负责 parked transcript 和 replay 的 user/assistant/tool 配对。

这组能力必须作为一个宿主功能看待。只移植 reveal controller 会让 Pi 原生 assistant stream 与 extension 自建 stream 竞争；只移植 transcript container 则无法替换 Pi root chat container。

### 6.3 Pi 0.84.1 新增的可用边界

Pi 0.84.1 相比仓库 0.83.0 基线新增两个相关能力：

1. `pi.registerMarkdownTransformer()`：display-only，同一 transformer 覆盖 streaming、final、replay、resize，并提供 `messageType`、`isStreaming`、`availableWidth`。
2. `TuiMainScreen`/`TuiAltScreen`：regular 与 experimental fullscreen；`TUI` 在 runtime 不再是可实例化 class。

因此：

- 任何新代码禁止 `new TUI(...)` 或 `instanceof TUI`。
- Markdown transformer 必须同步、确定、幂等、无 I/O；只处理 `assistant`/`assistant-thinking`。
- transformer 不能替换 `AssistantMessageComponent` 外壳、theme adapter、smooth reveal 或 transcript commit。
- `setWorkingIndicator()`/`setWorkingMessage()` 只覆盖 host working-loader 全局值，既不能渲染 transcript 内 hidden thinking，也无法 compare-and-restore 后加载插件的值；本计划不调用。
- fullscreen 只纳入兼容性测试，不作为本功能依赖，也不由插件自动开启。

本机官方文档证据：

- `.../pi-coding-agent/docs/extensions.md:1566-1585`
- `.../pi-coding-agent/dist/core/extensions/types.d.ts:837-845,918-922`
- `.../pi-coding-agent/dist/modes/interactive/interactive-mode.js:168-178,622-651`

## 7. 可移植性矩阵

分类：

- `PUBLIC`：可通过 Pi 公开 API 合并。
- `COMPAT`：只能复用当前受控私有兼容层。
- `UPSTREAM`：需先获得 Pi host 组合接口。
- `HOST`：只能 fork/替换宿主。
- `EXCLUDE`：违反本任务所有权或范围。

| OMP 能力 | 分类 | 本轮决定 |
|---|---|---|
| OMP hidden-thinking starburst/tokens/s | `COMPAT` | 只装饰原生 hidden label 行；不用 working setter，不持久化 stream state |
| OMP 风格 working-loader | `UPSTREAM`/`EXCLUDE` | 当前全局 setter无 ownership；且不是 hidden-thinking surface，不用它替代 |
| Assistant Markdown display transform | `PUBLIC` | 仅在 fixture 证明具体差异后使用；不预设无效 transformer |
| Session replay 一致性 | `PUBLIC`/host native | 依赖 Pi 同一路径，不另建 hydration |
| User prompt frame | `COMPAT` | 保留现有唯一 patch |
| Compact tool rows | `COMPAT` | 保留现有唯一 patch；可选调整纯视觉 cadence/glyph |
| Assistant outer spacing/frame | `UPSTREAM` | 当前没有普通 assistant renderer/decorator |
| Hidden-thinking transcript pulse/speed | `UPSTREAM` | 请求 assistant-thinking renderer 或 assistant decorator |
| Per-assistant Markdown theme | `UPSTREAM` | 请求局部 MarkdownTheme/render options hook |
| OMP smooth streaming reveal | `HOST`/`UPSTREAM` | 不在 extension 模拟 |
| OMP settled-row transcript | `HOST`/`UPSTREAM` | 不移植 container；需要 host contract |
| OMP Markdown engine | `HOST` | 不 vendoring 2600+ 行 renderer/native dependencies |
| OMP terminal capability/native layer | `HOST` | 继续使用 Pi runtime |
| OMP 98 themes/statusline | `EXCLUDE` | 会改变其他插件 |
| OMP editor/header/footer/overlay | `EXCLUDE` | 已有独立所有者 |
| OMP read grouping整体移植 | `EXCLUDE` | 与当前 exploration grouping 重复 |
| OMP tool execution wrapper | `EXCLUDE` | 会竞争 execution/security owner |

## 8. 方案比较

| 方案 | 保真度 | 插件安全 | 升级成本 | 决策 |
|---|---:|---:|---:|---|
| A. Pi native assistant Markdown + guarded assistant/user/tool render compat | 中 | 高 | 低 | 已选定 |
| B. 再 patch `AssistantMessageComponent`，选择性搬 OMP assistant | 中高 | 中低 | 高 | 默认禁止，需单独批准 |
| C. Fork Pi/替换为 OMP TUI runtime | 高 | 低 | 很高 | 不属于本计划 |

方案 A 保留 Pi 的 assistant 内容构建与 Markdown，只在三个 component target 的 shape probe 通过后装饰最终行。它复刻 native user band、hidden-thinking pulse/final cleanup、bounded tool blocks 与 single artifact receipt；不复刻 working ownership、30fps reveal、mid-message scrollback settling、advanced Markdown layout 或 transcript rebuild。

方案 B 指完整移植 OMP assistant/transcript internals，会突破已冻结的三 target surface，并依赖 0.84.1 已变化的 constructor/update/private fields；即使已有 assistant render decorator，也不应继续复制整套组件。

方案 C 能得到最接近 OMP 的行为，但会把 package namespace、session/replay、terminal lifecycle、settings 和 extension loader一起带入。它无法满足“不影响现有插件”的约束。

## 9. 目标架构

```text
Provider stream / persisted session
               |
               v
Pi Session + InteractiveMode
               |
     +---------+--------------------------+
     |                                    |
     v                                    v
native AssistantMessageComponent      native User/Tool components
     |                                    |
     | optional assistant-only             | existing presentation compat
     | Markdown transformer                | render decoration only
     v                                    v
native Pi Markdown/TUI/component tree  custom message/entry renderers
               |                            |
               +-------------+--------------+
                             v
regular or fullscreen Pi renderer -> terminal

untouched host/plugin surfaces:
  working loader -> Pi host/global extension chain
  appearance     -> header/editor
  statusline     -> footer
  taskboard      -> HUD/process state
```

不新增 transcript entry、session entry 或 hidden context。live 和 replay 必须继续汇入同一个 native component path；custom message、custom entry、compaction summary、branch summary 和 retry/error 行继续走各自原生/注册 renderer。

## 10. 分阶段合并计划

### Phase 0：冻结视觉合同与兼容基线

目标：在写视觉代码前定义“OMP 风格”到底是哪几项可见行为，并把版本错位变成可执行证据。

工作项：

1. 以 OMP built-in dark、commit `3a8591a8` 为默认视觉参考；若目标是其他 OMP theme，先替换 fixture 基线。
2. 新增 OMP/Pi 对照 fixture，至少覆盖：paragraph、H1-H3、list、table、blockquote、inline/fenced code、link、CJK、emoji、image fallback、visible/hidden thinking、aborted/error、tool pending/partial/success/error、custom message、custom UI-only entry、compaction/branch summary、skill/usage row、retry/late diagnostics。
3. 记录 40/80/120/160 列 normalized ANSI 输出；80/120/160 另保留 PTY capture。
4. 分别探测 0.81.1、0.83.0、0.84.1 根导出和 component shape；0.81.1 只保留为历史兼容证据。
5. 把 `presentation` 开发依赖校正到根仓 0.83.0；0.84.1 用隔离临时安装/运行矩阵验证，不覆盖 live `~/.pi`。
6. 记录 OMP MIT 来源。若后续复制非平凡代码或常量，保留版权/许可证归属。

Gate 0：

- OMP 与 Pi fixture 的差异按“public 可表达 / compat 可表达 / host-only”逐项标记。
- 当前 runtime 0.84.1 的 native user/assistant/tool 纯 render probe 成功。
- 没有修改 live theme、`terrific.json` 或用户 Pi settings。

### Phase 1：先加 host shape fail-closed

目标：视觉增强之前，确保三个私有 render patch 在 host shape 不兼容时不会污染整个进程。

工作项：

1. 把 compat 对 `AssistantMessageComponent`/`ToolExecutionComponent`/`UserMessageComponent` 的静态 named import 改为 package namespace lookup；`VERSION` 也从同一 namespace 读取并仅用于诊断。这样 future host 删除某个 named export 时，ESM module instantiation 仍能完成并进入 shape probe。
2. 不导入 package 未 export 的 `dist/...` subpath，也不把 private deep import 当 fallback。
3. 私有 patch 不维护版本 allowlist；兼容性只由必需的 component constructors 和 prototype methods 决定。
4. 同时检查 namespace 中的 class、`prototype.render` 和必要更新方法；不能只依赖 `Function.length`。
5. unknown/future version 在 shape 兼容时正常安装；缺失任一 component export 或必要方法时完全不安装 assistant/user/tool patch，只告警一次并保持 native renderer；`presentation` 其余公开能力仍可加载。
6. 增加真实 ESM module-resolution fixture：模拟 package 缺少一个 component export，断言 extension 初始化不因 import error 失败。
7. source-contract test 锁住 production patch target 只有：
   - `AssistantMessageComponent.prototype.render`
   - `UserMessageComponent.prototype.render`
   - `ToolExecutionComponent.prototype.render`
8. 连续 10 次 install/shutdown/reload，验证 prototype 恢复、foreign newer patch 不被卸载、timer/controller 无泄漏。
9. expanded tool 继续直接回 native；不注册同名 built-in tool。

Gate 1：

- 0.81.1、0.83.0 与 0.84.1 compatibility tests/实际 render probe 通过。
- unknown/future/versionless host 在 shape 兼容时安装；缺失 component export 或必要方法时明确回落 native，extension 本身仍成功加载。
- `npm --prefix packages/interface/presentation run check` 通过。
- 根 `npm run check` 通过。

### Phase 2：有证据才增加 assistant-only Markdown transform

目标：只使用 0.84+ 公开、display-only 的 Markdown hook；若 OMP/Pi 差异不能由纯 Markdown 安全表达，本阶段不写功能代码。

工作项：

1. 从 Phase 0 fixture 选择具体差异，必须同时满足：
   - 可以用纯 Markdown、同步确定函数表达；
   - streaming 每个前缀都保持语法稳定；
   - 不插入裸 ANSI/OSC，不依赖 private theme epoch；
   - 不改 message object、session JSONL 或 model context；
   - 不影响 `user`、custom message、custom entry、compaction/branch summary。
2. 只有存在合格差异时，才增加 `assistantStyle: "native" | "omp"`；否则不新增配置、transformer 文件或空抽象。
3. `registerMarkdownTransformer()` 没有 unregister handle。若注册，transformer closure 必须读取当前 config：`native` 时原样返回输入，`omp` 时执行已批准变换。
4. 配置切回 `native` 可立即恢复字节级 pass-through，但注册项本身要到 `/reload` 或 extension teardown 后才从 runner 清除；文档和测试必须区分“行为关闭”与“注销完成”。
5. 仅在 `VERSION >= 0.84.0` 且方法存在时注册；0.83.x 直接保持 native，不用 assistant prototype fallback。
6. 不调用 `setWorkingIndicator()`、`setWorkingMessage()` 或 `setHiddenThinkingLabel()`。它们不是 composable assistant renderer，无法安全还原 OMP transcript pulse。
7. transformer throw 时保留当前内容并让后续 transformer 继续，遵循 host fail-open 语义。

Gate 2：

- 无合格 Markdown 差异时，本阶段以“无需实现”通过，不为追求提交数量添加代码。
- 若实现，`assistantStyle=native` 的 render 字节与变更前一致；`omp` 只改变已批准 Markdown fixture。
- assistant message、session JSONL、model context 与 native 模式一致。
- regular/fullscreen、live/final/replay/resize 无重复输出或闪烁回退。
- custom message/entry、compaction/branch summary、retry/error 行不变。
- 连续 reload 后 transformer 不累积；切回 native 的即时 pass-through 和 reload 后完整注销均有测试。
- `appearance` header/editor、`statusline` footer、`taskboard` HUD 截图和 owner audit 不变。

### Phase 3：可选的 transcript 视觉对齐

目标：只在 Phase 2 验收后，微调已由 `presentation` 拥有的 user/tool transcript；不新增 surface owner。

允许项：

1. 在现有 `tool-render.ts` 内将 spinner cadence/glyph 调到 OMP fixture，继续 phase-locked、单 timer、width-safe。
2. 在当前 user frame/tool row 内使用 OMP 风格局部 glyph；颜色仍走当前 Pi semantic theme。
3. 保留当前 exploration grouping、长参数隐私截断、单行 collapsed、失败独占、artifact projection 和 `Ctrl+O` native detail。

禁止项：

- 不移植 OMP `ReadToolGroupComponent`。
- 不把未经脱敏或无界完整 command/prompt 放回 collapsed transcript；OMP Bash 只显示先脱敏再截断的 bounded command preview。
- 不新增 tool entry summary，与 taskboard/statusline 重复。
- 不改 `process_update` 的 HUD/result dedupe。
- 不改 tool registration、execution 或 permission。

Gate 3：

- 40/80/120/160 列每行 `visibleWidth <= width`。
- pending -> partial -> success/error 状态稳定；并行工具 spinner 不互相停止。
- collapsed 信息预算和敏感参数规则不回退。
- expanded 与 native baseline 内容一致。

### Phase 4：上游接口，再提升 assistant 保真度

只有下列公开接口落地后，才继续移植对应 OMP 行为：

1. `registerAssistantThinkingRenderer()` 或普通 assistant decorator，输入 streaming/final 状态、usage、theme 和 `requestRender()`。
2. per-message `MarkdownTheme`/render options hook，使 assistant 可局部换色和 spacing，不影响全局 theme。
3. keyed/scoped working-indicator API，返回 disposer 或 compare-and-restore token；仅用于确需改 working-loader 的插件，不替代 transcript thinking renderer。
4. built-in tool renderer middleware，仅装饰 render，不重新注册 execution definition。
5. transcript block lifecycle contract，至少包含 finalized、version、settled rows；是否接受 native scrollback commit 由 host 决定。

上游接口具备后可分开引入：

- hidden thinking pulse 与 tokens/s。
- bounded inline error + expand。
- assistant-local spacing/theme。
- host 级 smooth reveal/settled rows。

每项独立 Gate，不把 OMP assistant、Markdown、TranscriptContainer 一次性 vendoring。

## 11. 验证矩阵

### 11.1 静态与纯 render

- export/shape probe：0.81.1、0.83.0、0.84.1、future version 与 versionless host。
- user/assistant/tool：40/80/120/160 列。
- Markdown：heading、list、table、code、partial fence、CJK、emoji、OSC 8、长 token。
- tool：pending、partial、success、error、collapsed、expanded、artifact projection。
- source contract：只有三个 production prototype target（assistant/user/tool）。
- setter owner audit：生产代码中 `setHeader`/`setEditorComponent` 只属于 appearance，`setFooter` 只属于 statusline；本计划不新增 working indicator/message setter。
- custom message、custom UI-only entry、compaction/branch summary、skill/usage row、retry/error/late diagnostics 均有 native baseline。

### 11.2 Lifecycle

- 10 次 start/shutdown/reload。
- foreign patch 在本插件之后安装时，本插件 shutdown 不覆盖 foreign method。
- `assistantStyle` 若存在，runtime config 切换后立即 pass-through；`/reload` 后 transformer 注册不累积。
- 不遗留 interval、timeout、widget、status、working setter 或 custom component。

### 11.3 PTY 与 session replay

在隔离 `PI_CODING_AGENT_DIR` 中验证：

- regular 与 fullscreen。
- 80x24、120x40、160x50。
- streaming -> final。
- `/resume`、`/tree`、`/compact`、resize、`Ctrl+O`。
- hidden/visible thinking、custom message/entry、compaction/branch summary、skill/usage row。
- assistant error、tool error、abort/retry、late diagnostics。
- 当前 `presentation`、`appearance`、`statusline`、`taskboard` 同时启用。

### 11.4 数据不变式

- assistant render decorator 只改 native render 行；原 message object 不变。
- 相同 prompt/provider fixture 下，native/omp 模式 session JSONL 的 message/tool entries 相同。
- 不新增 custom message、hidden context 或 assistant rewrite。
- replay 不依赖进程内 timer 状态。
- print/json/rpc 模式不安装 TUI-only视觉组件，不崩溃。

### 11.5 人工终端验收

至少在实际 WSL2 -> Windows Terminal 路径检查：

- truecolor、CJK/emoji 宽度、光标和粘贴不受影响。
- streaming 无明显 vertical churn、重影或已完成行改写。
- user/tool/assistant 间距协调。
- editor/header/footer/taskboard 与基线截图一致。

Kitty/Ghostty/SIXEL 仅在有真实终端时验证；不能用伪造环境变量声称 image protocol 已通过。

## 12. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `presentation` 私有 prototype 在 Pi minor 版本漂移 | 高 | 必需方法 shape probe、不兼容时 native fallback |
| Assistant prototype shape 随 Pi minor 版本漂移 | 高 | 三 target 共用 shape gate，任一不匹配即全部 native fallback |
| 全局 theme 改变已有插件 | 高 | 不发布/安装 OMP theme；只消费当前 semantic theme |
| 自建 reveal/transcript 与 Pi native 重复 | 高 | 不创建第二 transcript、overlay 或 assistant stream |
| transformer 每个 delta 同步执行造成卡顿 | 中 | 纯函数、无 I/O、fixture benchmark；无明确收益就不注册 |
| transformer 与第三方链顺序相关 | 中 | assistant-only、幂等、保持语法前缀稳定；throw fail-open |
| transformer 无 unregister handle | 中 | config closure在 native 模式原样返回；reload 验证 runner 清理且不累积 |
| global working indicator/message 覆盖第三方插件 | 高 | 不调用；先请求 keyed/scoped setter 或 assistant renderer |
| tool/status/task 信息重复 | 中 | 不新增 durable row、widget 或 summary；保留现有 dedupe |
| fullscreen experimental 行为变化 | 中 | 只做兼容测试，不依赖私有 class/field |
| 复制 OMP 代码遗漏许可证 | 中 | OMP 为 MIT；复制非平凡代码时保留 attribution |
| 视觉目标主观 | 中 | 先冻结 fixture 和实际终端截图，再写行为代码 |

## 13. 回滚

本计划不修改 session schema、tool data 或模型上下文，因此回滚不需要迁移数据。

1. `style="classic"` 可恢复之前的 presentation 投影；`enabled=false` 完全 pass-through，均不需要 session migration。
2. `style="classic"` 可立即恢复原 presentation 投影；`presentation.enabled=false` 完全 pass-through。未注册 Markdown transformer，无注销或累积问题。
3. `compactTools=false` 或 `userMessageBox=false` 可分别回到 native tool/user renderer；不影响 assistant。
4. 缺失 component export 或必要方法时自动不安装私有 compat；unknown/future version 只要 shape 兼容即可加载。
5. extension shutdown/reload 只恢复本插件实际拥有的 prototype descriptor；不触碰 working indicator/message。
6. 若 release 回滚，只需回退对应 package commit；session JSONL 仍可由原生 Pi replay。

## 14. 实施文件边界

预计只触及：

- `packages/interface/presentation/extensions/presentation.ts`
- `packages/interface/presentation/lib/config.ts`
- `packages/interface/presentation/lib/types.ts`
- `packages/interface/presentation/lib/compat/index.ts`
- `packages/interface/presentation/lib/compat/assistant-message.ts`
- `packages/interface/presentation/lib/compat/tool-render.ts`
- `packages/interface/presentation/tests/`
- `packages/interface/presentation/package.json`
- `packages/interface/presentation/lib/LICENSES/oh-my-pi-MIT.txt`
- `packages/interface/presentation/README.md`
- `docs/CAPABILITIES.md`
- `docs/plans/fixtures/presentation/`

明确不触及：

- `packages/interface/appearance/**`
- `packages/interface/statusline/**`
- `packages/interface/taskboard/**`
- `packages/session-control/**`
- `packages/runtime/**`
- live `~/.pi` 配置和 OMP checkout

根 `package.json` 不需要新增 extension、runtime dependency 或 Pi package spec；`presentation` 现有资源路径不变。

## 15. 合并顺序与停止条件

建议拆成小提交：

1. `test(presentation): freeze Pi 0.83 and 0.84 TUI baselines`
2. `fix(presentation): fail closed when host exports or shapes are unsupported`
3. `feat(presentation): add guarded OMP assistant and tool transcript profile`
4. `test(presentation): add live replay and plugin coexistence captures`
5. `docs(presentation): record profile ownership and OMP attribution`

停止并要求重新决策的情况：

- 目标验收要求 OMP hidden-thinking 动效、30fps reveal、mid-message native scrollback commit、assistant-local Markdown engine 或像素级 spacing，而上游没有对应 API。
- 实现必须新增第四个 prototype target、替换 root chat container、占用无 ownership 的 working setter 或重注册 built-in tool。
- future host 删除 component export 时，namespace gate 仍无法让 extension 成功加载。
- 0.84.1 pure render/PTY probe 无法稳定通过。
- 视觉差异只能通过全局 theme 修改实现。

此时只能在“接受较低保真度”与“单独维护 Pi host fork”之间选择，不能把 host fork 隐藏在普通 `terrific-pi` extension 内。

## 16. 最终验收标准

- immediate extension 路线只启用 Phase 0 证明可由纯 Markdown 安全表达的 OMP 差异；没有合格差异时明确保持 native，不声称已有 OMP thinking/motion。
- live、final、resize、resume、tree、compact 的 assistant 输出一致，无重复或丢失。
- custom message/entry、compaction/branch summary、skill/usage、retry/error 行与 native baseline 一致。
- 模型消息、tool facts、session JSONL 和 context 与 native 模式相同。
- appearance header/editor、statusline footer、taskboard HUD 与基线无变化，working indicator/message 未被本插件占用。
- production 私有 patch 只有 assistant/user/tool 三个精确 target；任一 host shape 不兼容时三者全部回 native，expanded tool 保真。
- Pi 0.83.0 与 0.84.1 验证通过；unknown/future/versionless host 在 shape 兼容时可加载，缺失 export 或必要方法时 extension 成功加载并 fail closed 到 native。
- package check、root check、PTY capture 和实际 Windows Terminal 人工验收都有证据。

方案 A 以 `style="omp"` 作为默认可回滚配置：Pi 原生 assistant Markdown、OMP-style hidden-thinking pulse/最终清理、native user band、bounded tool blocks 和单次 artifact receipt 已实现。Smooth reveal、settled scrollback、assistant-local Markdown engine 与 working-loader ownership 仍属于 Phase 4 上游能力，当前结果不冒充这些高保真行为。

## 17. 实施验证记录

- `npm --prefix packages/interface/presentation run check`：typecheck 与 95/95 tests 通过。
- 根 `npm run check` 通过；`npm pack --dry-run --json` 包含 assistant compat 与 OMP MIT notice。
- 真实 package namespace 注入 probe：Pi 0.81.1、0.83.0、0.84.1 的 assistant/user/tool 均完成 install、render 与 uninstall 恢复。
- 隔离 `PI_CODING_AGENT_DIR`、offline PTY：regular/fullscreen 均同时加载 appearance、presentation、statusline、taskboard，并通过 Ctrl+D clean shutdown，无 extension diagnostics。
- 独立 fresh-context review 共三轮，另执行一次 `openai/gpt-5.6-sol:max` 独立审阅；发现的 credential/path redaction、OSC marker 顺序与空输出 carrier、usage、message lifecycle、artifact expansion、host gate、read row budget 与 license payload 问题均补 RED-GREEN 回归。

未完成的环境验收仅剩 Windows Terminal 人工视觉检查，以及需要真实 session/provider 的 `/resume`、`/tree`、`/compact` 全流程。它们不影响静态、纯 render、package 或隔离 PTY 结论，但发布前仍应执行。
