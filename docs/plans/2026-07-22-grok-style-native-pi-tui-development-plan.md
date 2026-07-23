# Grok 风格原生 Pi TUI 并行开发计划

> 日期：2026-07-22
>
> 状态：架构边界已确认，等待并行 worker teams 实施
>
> 用户决策：采用路线 B，即 Pi 公共 UI API + 扩展现有 `presentation` 受控私有兼容层
>
> 命名更新：2026-07-23，任务 HUD package 已从 `process-view` 更名为 `taskboard`；本计划使用现行 package、widget/status key 和 `/taskboard` 名称，保留 `process_update` 及兼容边界。
>
> 前置研究：[Grok Build TUI 与 Pi 0.81.1 高保真复刻对比报告](./2026-07-22-grok-build-tui-comparison-report.md)
>
> 目标定位：交付高完成度的 "Grok-styled native Pi"，不宣称完整复刻 Grok TUI

## 1. 决策

本轮保留 Pi 0.81.1 原生 TUI、session、transcript、editor input model、extension runtime 和 terminal lifecycle，只调整现有宿主允许调整的视觉表面：

- 新增零 runtime dependency 的 `extensions/appearance` package，提供中性 `terrific-night` theme、startup header、custom editor 和 below-editor shortcuts widget。
- `presentation` 继续唯一拥有 user message 与 built-in tool row 的两个受控 prototype patch。
- `statusline` 继续唯一拥有 footer，并在 opt-in layout 下承担 Grok 风格 turn status。
- `taskboard` 继续唯一拥有 task/todo HUD。
- `mode` 与 `btw` 只调整自己已有的菜单或 overlay，不改变工具权限和旁路 session 语义。
- Pi 原生 assistant Markdown、thinking、内建 dialog、root transcript 和 terminal lifecycle 保持原 owner。

明确排除：

- Rust/Ratatui pager。
- `pi --mode rpc` 独立前端。
- fullscreen persistent overlay 或第二套 transcript。
- Pi `InteractiveMode` / `pi-tui` host fork。
- 第三个 prototype patch、assistant-message patch 或 private panel patch。
- fixed viewport、sticky scrollback、全局 mouse hit regions、跨 block selection。
- 多进程 Dashboard、外部 live session attach、Grok plan/permission 协议仿造。
- xAI/Grok logo、产品名和暗示官方背书的品牌资产。

## 2. 复用调研结论

### 2.1 已核对实现

| 实现与固定证据 | License | 覆盖 | 不直接采用的原因 |
|---|---|---|---|
| Pi 0.81.1 theme/package API；已安装 `docs/extensions.md` | MIT | 51 个 theme token、package themes | 直接复用，是颜色真源 |
| Pi 0.81.1 `examples/extensions/border-status-editor.ts` | MIT | `CustomEditor`、width-safe border、injected keybindings | 复用实现模式，不复制 footer owner |
| [`pi-coder-theme 0.1.0` npm tarball](https://registry.npmjs.org/pi-coder-theme/-/pi-coder-theme-0.1.0.tgz) | MIT | theme、editor、user/tool、thinking | 重复 `presentation` user/tool owner，新增 assistant patch，依赖 Pi 0.74 与第三方 runtime 包 |
| [`pi-comfy-ui 0.3.0` npm tarball](https://registry.npmjs.org/pi-comfy-ui/-/pi-comfy-ui-0.3.0.tgz) / [repository](https://github.com/adanft/pi-comfy-ui) | MIT | public custom editor、panel appearance | 同时 patch Pi private panels，且 side-rail 视觉不符合本目标 |
| [`@rokiy/pi-ui 1.2.0` commit `0351169`](https://github.com/DragonYH/pi-ui/tree/03511691956fd8cfe8b3e5c10e2c61d450fff838) | MIT | theme、editor、footer、working timer | 重复现有 `statusline`、editor owner和计时器，并修改 assistant message content |
| 当前 `presentation` | 本仓 | user/tool private renderer | 直接扩展，保留唯一 owner |
| 当前 `statusline` | 本仓 | footer、usage、state、mode/fast | 直接扩展，避免第二 footer |
| 当前 `taskboard` | 本仓 | task state、telemetry、widget | 直接扩展，避免第二 task pane |

结论：没有第三方 package 能在遵守本仓单一所有权和受控 patch 边界后仍覆盖至少80%的需求。第三方实现仅作行为与测试模式参考；不新增其 runtime dependency。若复制实质代码，worker 必须先记录来源、版本和 MIT attribution；默认优先依据 Pi 官方示例自行实现最小代码。

### 2.2 为什么仍需新增 appearance package

Theme JSON 只能改颜色，不能独立提供 startup header、editor border 和动态 keybinding hints。新增 package 只填这三个公共 API 缺口，不接管现有 package 已拥有的 transcript、footer 或 task state，因此不是重复造轮子。

## 3. 不变量与所有权

### 3.1 Renderer owner

| 表面/事实 | 唯一 owner | 允许接口 | 禁止事项 |
|---|---|---|---|
| Theme palette | `appearance` | package `pi.themes` | renderer 内硬编码 RGB |
| Startup header | `appearance` | `ctx.ui.setHeader()` | persistent top bar、第二 root layout |
| Prompt editor | `appearance` | `ctx.ui.setEditorComponent()` | 重写 input/history/paste/autocomplete model |
| Shortcut hint | `appearance` | namespaced below-editor widget | 静态伪造用户已重绑按键 |
| Footer / turn status | `statusline` | `ctx.ui.setFooter()`、`ctx.ui.setWorkingVisible()`、terrific layout | 第二 footer owner |
| User prompt | `presentation` | 现有 `UserMessageComponent.render` patch | 第二 patch 或直接解析 private message shape |
| Tool rows / file receipt | `presentation` | 现有 `ToolExecutionComponent.render` patch | 替换 tool schema、execute、permission |
| Assistant/thinking | Pi core | Theme token | assistant prototype patch |
| Task/todo HUD | `taskboard` | 现有 taskboard widget | 第二 task state或 task widget |
| Mode/fast state | `mode` / `fast` | 既有 status keys | appearance 根据文案推断权限 |
| BTW side session | `btw` | 既有 isolated session/overlay | 写主 session 或复制上下文 owner |
| Built-in modal | Pi core | Theme token | private panel patch |

### 3.2 Setter 排他性

Pi 的 `setHeader()`、`setEditorComponent()` 和 `setFooter()` 是 last-writer-wins，不是可组合 slot：

- `appearance` 不得调用 `setFooter()`、`setStatus()` 或注册 transcript renderer。
- `statusline` 不得调用 `setHeader()`、`setEditorComponent()` 或写 appearance widget。
- `taskboard` 继续只使用 `terrific-pi:taskboard` widget key与 `taskboard` status key；statusline只在迁移期兼容旧 `process` key。
- `appearance` shortcut widget key固定为 `terrific-pi:appearance-shortcuts`。
- 不新增 appearance status key，不让内部 profile 文案泄漏到 footer progress。
- 实际启用 package 列表中若发现另一个 header/editor/footer owner，集成必须阻塞并要求显式选择，不能依赖加载顺序碰运气。

### 3.3 Prototype patch 上限

全仓允许的 transcript private patch target精确为：

1. `UserMessageComponent.prototype.render`
2. `ToolExecutionComponent.prototype.render`

两者都必须继续通过 `presentation/lib/compat/prototype-patch.ts` 安装，保留 Symbol key、引用计数、compare-and-swap uninstall、reload safety 和 native fallback。任何新增 patch target 都视为架构越界，不能由 worker 自行批准。

## 4. 冻结的跨团队合同

### 4.1 Profile contract

除Pi自身的theme选择外，所有structural/renderer增强读取同一durable配置：

```json
{
  "appearance": {
    "profile": "terrific-native-v1"
  }
}
```

规则：

- 精确值 `terrific-native-v1` 才启用结构性视觉修改；缺失、`off`、未知或类型错误都inactive。
- 真源只允许 `$PI_CODING_AGENT_DIR/terrific.json`；不得读取cwd/project-local `terrific.json`，不得复用 `mode`/`btw` 的trusted-project effective loader。
- `appearance`、`presentation`、`statusline`、`taskboard`、`mode`、`btw` 各自在包内做小型只读解析，不建立跨包runtime import。
- `statusline` 的 terrific效果要求 `profile === "terrific-native-v1"` 且 `layout === "terrific"` 同时成立；profile inactive时，配置中的 `terrific`按`single`渲染并保持Pi native working line可见。
- Theme选择是Pi自身的独立设置：profile inactive只保证结构/renderer行为不变；若用户仍选择`terrific-night`，颜色当然继续变化。
- parser对malformed JSON fail closed并返回可测试的error。只有`appearance`显示一次用户通知；其他consumer静默inactive，避免同一错误产生多条通知。任何包都不能阻断Pi启动。
- worker不提供profile CRUD命令或filesystem watcher。每个package在extension/session activation时读取一次，当前generation内保持不变；文件修改统一经`/reload`或重启生效。
- statusline自己的layout可在当前generation内切换，但只与generation缓存的profile计算`effectiveLayout`。
- 只有集成团队在视觉验收后更新示例或snapshot；并行worker不改live `~/.pi` 或共享snapshot。

所有A-E package tests必须复制同一组合同向量；这里的表是唯一规格，不新建跨包shared fixture：

| Case | `$PI_CODING_AGENT_DIR/terrific.json` | Project-local file | Expected |
|---|---|---|---|
| 1 | missing | missing | inactive，无错误 |
| 2 | `{}` | missing | inactive，无错误 |
| 3 | `{"appearance":{"profile":"terrific-native-v1"}}` | missing | active |
| 4 | `{"appearance":{"profile":"off"}}` | missing | inactive，无错误 |
| 5 | unknown/non-string profile | missing | inactive，无错误 |
| 6 | `appearance`非object | missing | inactive，一次可报告错误 |
| 7 | malformed JSON | missing | inactive，一次可报告错误 |
| 8 | agent file inactive | project file active | inactive，证明不读取project override |

测试还必须覆盖`PI_CODING_AGENT_DIR`指向临时目录；各包可复制几行parser，不能为此引入共享runtime package。

### 4.2 Theme contract

公开 theme id：`terrific-night`。

基础 palette：

| Role | Value |
|---|---|
| terminal background | `#0a0a0a` |
| main surface | `#141414` |
| raised/code surface | `#1c1c1c` |
| highlight/selection | `#242424` |
| primary text | `#e1e1e1` |
| secondary text | `#c8c8c8` |
| muted | `#6c6c6c` |
| dim | `#585858` |
| blue | `#7aa2f7` |
| cyan | `#7dcfff` |
| green | `#9ece6a` |
| magenta | `#bb9af7` |
| orange | `#ff9e64` |
| yellow | `#e0af68` |
| red | `#f7768e` |

约束：

- Theme JSON 覆盖 Pi 0.81.1 全部 required tokens。
- renderer 只使用 `theme.fg/bg/getBgAnsi` 的 semantic token，不复制 hex 或手写 RGB ANSI。
- Pi 只有统一 `mdHeading` token，因此 H1/H2 不宣称可拥有 Grok 的多色层级。
- truecolor 是目标基线，256-color 是必须可用的降级；ANSI16 只保证语义可辨，不保证视觉一致。
- 公开名称保持 `Terrific` 中性品牌；来源和 palette参考写入 README attribution，不发布 Grok logo。

### 4.3 Glyph contract

| State | Preferred | ASCII fallback |
|---|---|---|
| prompt | `❯` | `>` |
| running/current | `●` / spinner | `*` |
| pending | `□` | `[ ]` |
| active task | `▶` | `>` |
| success/done | `✓` / `◆` | `+` |
| failed | `✗` | `x` |
| cancelled/interrupted | `×` / `!` | `!` |
| separator | `│` / `·` | `|` / `.` |

状态不能只靠颜色表达。所有 width budget 使用 `visibleWidth()` 和 `truncateToWidth()`；禁止对 ANSI/CJK/emoji 直接使用 `string.length` 做最终布局判断。

### 4.4 Native layout contract

保持 Pi root顺序，不模拟 fixed viewport：

```text
appearance startup header (transcript 顶部，非 sticky)
Pi native transcript
  presentation user band
  Pi native assistant/thinking
  presentation tool rows
taskboard task widget (existing above-editor placement)
appearance editor
appearance shortcuts widget (below editor,可响应隐藏)
statusline footer / turn status
```

响应规则：

- 主验收：`80x24`、`120x40`、`160x50`。
- 边界验收：40列、16/20/24行。
- 高度 `<20` 时 shortcuts隐藏，statusline terrific layout退为单行，header退为一行。
- 宽度 `<72` 时 shortcuts隐藏；editor、tool、process和footer都必须保持可输入、无负 `repeat()`、无控制序列截断。
- 不缩放字体，不依赖 Nerd Font；emoji/plain 继续由现有配置决定。
- 不创建 cards-inside-cards；process expanded view只保留一层边界。

## 5. 并行模块总览

| ID | Worker team | 独占目录 | 可并行 | 主要产物 |
|---|---|---|---|---|
| A | Appearance Shell | `extensions/appearance/**` | Wave 1 | theme/header/editor/shortcuts |
| B | Transcript Presentation | `extensions/presentation/**` | Wave 1 | user band/tool rows/artifact视觉 |
| C | Footer & Turn Status | `extensions/statusline/**` | Wave 1 | terrific layout/turn status |
| D | Task HUD | `extensions/taskboard/**` | Wave 1 | task/todo视觉 |
| E | First-party Modals | `extensions/mode/**`, `extensions/btw/**` | Wave 1 | extension-owned menu/overlay视觉 |
| F | Integration & Release | 根 docs、examples、snapshot、install smoke | Wave 2+ | 组合验收与 rollout |

并行 worker 只能修改自己表中的目录。package README 与 package tests属于对应 team；根 README、`docs/CAPABILITIES.md`、`agent/`、`snapshot/`、`scripts/` 仅由 Team F修改。

## 6. Team A - Appearance Shell

### 6.1 目标

新增一个零 runtime dependency 的 Pi package，只使用公共 API提供 theme、startup header、prompt editor 和动态 shortcuts hint。

### 6.2 文件所有权

```text
extensions/appearance/
├── package.json
├── README.md
├── tsconfig.json
├── extensions/appearance.ts
├── lib/config.ts
├── lib/header.ts
├── lib/editor.ts
├── lib/shortcuts.ts
├── themes/terrific-night.json
└── tests/
    ├── config.test.ts
    ├── extension.test.ts
    ├── header.test.ts
    ├── editor.test.ts
    ├── shortcuts.test.ts
    └── theme.test.ts
```

### 6.3 实现任务

1. `package.json`
   - `type: module`。
   - `keywords`包含 `pi-package`、`pi-extension`、`pi-theme`。
   - `pi.extensions` 指向真实 entry。
   - `pi.themes` 指向 `./themes`。
   - Pi packages放 `peerDependencies: "*"`。
   - 不增加 `dependencies`。
2. `config.ts`
   - 只读 `appearance.profile`。
   - 缺失/未知为disabled。
   - malformed配置返回可报告错误，不抛出到Pi启动。
3. `terrific-night.json`
   - 映射完整 theme schema。
   - theme name与文件名一致。
   - export colors也必须定义或按Pi schema可靠派生。
4. Header
   - 中性 `Terrific` 文本标识，最多3行。
   - 不显示 cwd、context、model、mode、tokens等已被其他 owner持有的事实。
   - 低高度退化为一行；不构造营销式大Logo。
5. Editor
   - 继承Pi `CustomEditor`，调用`super.render()`后只装饰首尾边界。
   - 不覆盖`setPaddingX()`。Pi 0.81.1会在factory返回后用`defaultEditor.getPaddingX()`同步custom editor，并在settings reload时再次同步；本包沿用该宿主行为。
   - Border布局必须支持实际`editorPaddingX`为0/1/2，不把1写成renderer常量。
   - 保留injected `KeybindingsManager`、history、multiline、paste、autocomplete和cursor。
   - top border包含`❯`，bottom border不复制footer facts。
   - 若`ctx.ui.getEditorComponent()`已返回非本包factory，通知一次并同时放弃editor与shortcuts owner，不能覆盖。
6. Shortcuts widget
   - key固定`terrific-pi:appearance-shortcuts`，placement为below-editor。
   - 只从本包editor factory实际注入的`KeybindingsManager.getKeys()`生成；factory捕获manager后再安装或刷新widget。
   - editor冲突或尚未实例化时不显示shortcuts，不寻找private/global keybinding来源。
   - 不硬编码已经被用户重绑的键。
   - `<72`列或`<20`行返回空并卸载可见内容。
7. Lifecycle
   - 仅`ctx.mode === "tui"`安装。
   - 连续`session_start -> shutdown -> start`使用generation保护，并保存本generation的UI、header factory、editor factory和先前editor factory。
   - 当前generation shutdown时同步清理namespaced widget并调用`setHeader(undefined)`；旧generation不得清理新实例。
   - editor只在`getEditorComponent()`仍等于本包factory时恢复先前factory。
   - header没有getter，无法做CAS；其安全前提是Team F静态审计后全体enabled packages中只有appearance调用`setHeader()`。若审计失败，appearance不得启用header。
8. Config contract
   - `config.test.ts`逐项覆盖4.1的8组向量；不得读取project override。

### 6.4 禁止事项

- `setFooter()`、`setStatus()`、`setWorkingVisible()`。
- prototype patch。
- transcript/message/tool renderer。
- Git或网络子进程。
- 自建interval/timer。
- 自动改用户 `settings.json` 或强制切换theme。

### 6.5 Team A验收

- Theme由Pi 0.81.1 loader成功加载且required token齐全。
- Header/editor/widget在40/80/120/160列和16/20/24行不溢出。
- CJK、emoji、combining char和ANSI输入不破坏边界。
- editor submit/cancel/history/paste/multiline/completion冒烟通过。
- 初装、settings变更与reload时，Pi宿主同步的`editorPaddingX` 0/1/2都不破坏border。
- custom-editor conflict时header可保留，但appearance editor与shortcuts都不安装。
- non-TUI零UI副作用。
- 重复reload无重复widget；当前generation恢复header/editor，stale cleanup不影响新generation。
- `npm run typecheck && npm test`通过。

## 7. Team B - Transcript Presentation

### 7.1 目标

在现有唯一 compat owner内，把user prompt和collapsed tool rows调整为Terrific/Grok风格，同时保持Pi执行事实与expanded native详情不变。

### 7.2 独占文件

- `extensions/presentation/extensions/presentation.ts`
- `extensions/presentation/lib/config.ts`
- `extensions/presentation/lib/types.ts`
- `extensions/presentation/lib/compat/user-message.ts`
- `extensions/presentation/lib/compat/tool-render.ts`
- `extensions/presentation/lib/compat/index.ts`，只在传递style flag确有必要时修改
- `extensions/presentation/tests/**`
- `extensions/presentation/README.md`

### 7.3 实现任务

1. 按4.1的全局路径与8组向量读取`appearance.profile`，生成只读`terrificNativeActive`；不得读取project override或由`/presentation`写该字段。
2. Profile inactive时，现有user frame和tool row输出保持当前行为。
3. Profile active时，user prompt改为：
   - 全宽 `userMessageBg` band。
   - 左侧 `❯`，正文继续由原Pi Markdown renderer产生。
   - 保留OSC 133/633 prompt zones和原ANSI前景。
   - 不从private instance猜timestamp、model或session事实。
   - 窄宽和任何异常立即回退原renderer。
4. Profile active时，tool rows改为：
   - Read/Search/List使用低噪音探索聚合。
   - Bash/Execute保留pending/running/success/error/duration。
   - Edit/Write仍由ArtifactJournal提供request-level net receipt。
   - Skill只基于exact file path。
   - unknown/custom tool保留generic/native fallback。
   - error保留一个可行动且脱敏的独立行。
5. Expanded始终调用Pi原renderer；artifact details只能追加，不能替换原事实。
6. 保持当前200ms running-tool timer仅在活跃tool存在时运行；idle、dispose、shutdown清理。
7. 不改变tool input/result/schema、permission、execution mode或session entries语义。

### 7.4 禁止事项

- 新增第三个 `patchPrototypeMethod()`。
- patch assistant/thinking/private panel/root。
- 注册同名built-in tool。
- 修改ArtifactJournal算法以迎合视觉。
- 在collapsed error中泄漏URL query、token、绝对私密路径。

### 7.5 Team B验收

- 对`extensions/presentation/lib/compat/index.ts`做target allowlist审计，`UserMessageComponent.prototype`与`ToolExecutionComponent.prototype`各出现一次且没有其他`.prototype` patch；不统计tests/helper文本。
- Profile inactive的核心golden与当前基线一致。
- Profile active覆盖user multiline、OSC、ANSI、CJK、40/80/120/160列。
- Tool覆盖read/search/list/bash/edit/write/custom的pending/running/success/error/expanded。
- `Ctrl+O` expanded继续进入native详情。
- reload/refcount/CAS/fail-open测试通过。
- `npm run check`通过。

## 8. Team C - Footer 与 Turn Status

### 8.1 目标

在现有statusline内新增显式`terrific` layout，继续作为唯一footer owner；仅当全局profile与layout同时激活时接管turn status并隐藏Pi native working line。

### 8.2 独占文件

- `extensions/statusline/extensions/statusline.ts`
- `extensions/statusline/lib/types.ts`
- `extensions/statusline/lib/config.ts`
- `extensions/statusline/lib/render.ts`
- `extensions/statusline/lib/widgets.ts`
- `extensions/statusline/lib/format.ts`，仅必要时
- `extensions/statusline/tests/**`
- `extensions/statusline/README.md`

### 8.3 Frozen layout

`layout: "terrific"` 最多两行：

```text
line 1: path · branch                         model · thinking · mode · fast
line 2: spinner/state · duration · progress   tokens · context · cost/quota
```

响应式规则：

- `>=120`列：两行完整zones，左右对齐。
- `80..119`列：两行，按现有priority整段drop，不截断ANSI。
- `<80`列或terminal rows `<20`：一行 `state · model · context`，其他按priority省略。
- right zone优先保留model/context；left zone优先保留state。
- path、branch、mode、fast等只显示真实值；不根据theme或文案推断状态。

### 8.4 实现任务

1. 按4.1的全局路径与8组向量读取profile；不得读取project override。
2. 扩展`StatuslineLayout`、config parser和配置UI，接受`terrific`；现有single/stacked默认不变。
3. 计算唯一`effectiveLayout`：profile active且configured layout为terrific时取terrific；profile inactive且configured layout为terrific时取single；其他layout原样。
4. 在render层基于现有segments做left/right zone，不复制widget formatter。
5. 使用`visibleWidth`、`truncateToWidth`、现有drop priority和bar shrink。
6. `effectiveLayout === "terrific"`时调用`ctx.ui.setWorkingVisible(false)`，footer成为turn status主renderer；当前generation内layout切换，或profile文件修改后的`/reload`、shutdown、dispose，都共用同一同步函数恢复native working visibility。
7. 复用现有duration timer驱动spinner；active cadence目标约133ms，idle时timer必须停止。不得增加并行第二timer。
8. statusline仍读取真实mode/fast/taskboard/aux statuses；不新增appearance status。
9. 配置损坏继续使用当前fail-safe，不阻断Pi。

### 8.5 Team C验收

- 全仓仍只有statusline调用 `setFooter()`。
- single/stacked现有测试不回归。
- terrific layout在idle/thinking/working/waiting、80/120/160列通过。
- 40列和低高度不throw、不负repeat、editor仍可见。
- 只有generation缓存的profile + 当前layout双激活时native working line隐藏；layout切换、退出和profile修改后的reload时恢复。
- idle无133ms timer，reload无stale render callback。
- mode/fast/taskboard状态不重复进入generic progress。
- `npm test`通过。

## 9. Team D - Task HUD

### 9.1 目标

只调整现有task widget视觉，不改变 `process_update` schema、state reducer、telemetry、durable entry或widget placement。

### 9.2 独占文件

- `extensions/taskboard/extensions/taskboard.ts`，仅传递profile/style和lifecycle需要时
- `extensions/taskboard/lib/config.ts`
- `extensions/taskboard/lib/types.ts`，仅展示style类型需要时
- `extensions/taskboard/lib/render.ts`
- `extensions/taskboard/tests/**`
- `extensions/taskboard/README.md`

### 9.3 实现任务

1. 按4.1的全局路径与8组向量读取`appearance.profile`；不得读取project override，inactive保持当前render。
2. Active compact view：
   - pending `□`、active `▶`、done `✓`、failed `✗`。
   - 保留title、done/total、current step、elapsed和waiting/blocked文字。
   - 低宽最多2行，正常最多3行。
3. Active expanded view：
   - 只保留一层pane，不嵌套card。
   - Header、Tasks、Runtime、latest update/artifacts维持现有事实。
   - 最大15行或更低；空间不足优先保留current、blocker和failed step。
4. Status flash如实现，只允许单次1200ms component timer并在dispose清理；没有证据需要时可以不实现。
5. `taskboard` status key继续只在waiting/blocked时写，statusline负责摘要。
6. `process_update` native tool result和widget不能重复展示完整步骤。

### 9.4 Team D验收

- Profile inactive golden保持当前行为。
- Active覆盖running/waiting/blocked/completed/interrupted及telemetry unavailable。
- 40/80/120/160列所有输出visible width不超过viewport。
- 低高度行数上限稳定，动态数据不改变固定几何。
- 状态同时由glyph + text + tone表达。
- 不改变tool schema、state persistence、telemetry或widget key。
- `npm run check`通过。

## 10. Team E - First-party Modal Polish

### 10.1 目标

统一本仓自己拥有的 `mode` 菜单和 `btw` overlay视觉；Pi built-in settings/model/session/dialog保持原生，只受theme token影响。

### 10.2 独占目录

- `extensions/mode/**`
- `extensions/btw/**`

### 10.3 实现任务

1. 两包分别按4.1的全局路径与8组向量读取`appearance.profile`；必须新增独立global-only parser，不得复用现有trusted-project effective loader；inactive保持现状。
2. Active菜单使用同一语义：
   - 单层边界，标题紧凑。
   - 选中行accent，说明文字muted。
   - 循环选择。
   - 二级Esc返回上级，顶层Esc关闭。
   - 长列表支持已有filter；不得为短列表强加搜索。
   - tips低噪音且从实际keybindings生成。
3. BTW TextOverlay保留scroll、copy、retry、editor和cancel语义；只改chrome、spacing和glyph。
4. Mode不得因视觉profile改变active tools、ask/plan/edit/auto语义。
5. BTW不得写主session、加载主tools或继承fast状态。

### 10.4 Team E验收

- Profile inactive行为与snapshot不变。
- Active菜单在80/120/160列、低高度和长文本下无溢出。
- Mode工具集测试全部通过。
- BTW isolated session、cancel、retry、copy、scroll测试全部通过。
- 无private panel patch、无新global UI setter。
- 两包 `npm run check`通过。

## 11. Team F - Integration、默认配置与发布

Team F必须等A-E各自通过package gate后再修改共享文件。

### 11.1 独占共享文件

- `README.md`
- `docs/CAPABILITIES.md`
- `agent/settings.packages.example.json`
- `agent/terrific.example.json`
- `agent/statusline.example.json`
- `snapshot/agent/*`，仅在rollout批准后通过规定snapshot流程刷新
- `scripts/test-install.sh`，仅当需要增加自动发现断言
- `scripts/pack.sh`、`scripts/install.sh`，仅当appearance自动发现/安装产生可复现失败；否则禁止修改
- 本计划与最终验收报告

### 11.2 集成任务

1. 登记 `appearance` package和职责。
2. 明确加载关系：
   - `taskboard` 在 `presentation` 前。
   - `appearance`、`statusline` 不依赖加载顺序，但不得与其他相同setter owner同时启用。
3. 在temporary `PI_CODING_AGENT_DIR`建立opt-in配置：

```jsonc
// settings.json relevant fields
{
  "theme": "terrific-night",
  "editorPaddingX": 1,
  "outputPad": 1
}
```

Pi宿主把`editorPaddingX`同步给native与appearance editor；1是集成profile的推荐值，不是appearance renderer硬编码。

```jsonc
// terrific.json relevant field
{
  "appearance": {
    "profile": "terrific-native-v1"
  }
}
```

```jsonc
// statusline.json relevant field
{
  "layout": "terrific",
  "iconMode": "plain"
}
```

4. 在temporary agent dir对A-E执行4.1全部8组parser向量，证明结果一致。
5. 对实际enabled package源码执行setter allowlist审计：本仓生产`setHeader()`与`setEditorComponent()`只允许appearance，`setFooter()`只允许statusline；同时检查`$PI_CODING_AGENT_DIR/npm`和`$PI_CODING_AGENT_DIR/git`中可用的第三方源码。任何未知或第二owner都阻塞启用对应surface。
6. 运行组合matrix并生成text/ANSI/PNG evidence。
7. 用户视觉验收前不修改live `~/.pi/agent` 或snapshot默认。
8. 用户批准rollout后，按11.4先备份并hash相关live配置，再应用默认并运行`./scripts/snapshot.sh`。
9. `pack.sh`/`install.sh`预计无需生产修改：两者应自动发现新package。只有appearance自动发现或安装出现可复现失败，Team F才可在11.1列出的条件文件做最小修复。
10. 用户明确要求离线发布时，按11.4运行pack、manifest断言与临时home install smoke；dist不提交。

### 11.3 集成验收

- README package表与磁盘一致。
- `appearance/package.json`的extension/theme路径真实存在并进入archive manifest。
- temporary home安装后Pi能选择`terrific-night`并加载全部package。
- live user配置在rollout批准前hash不变。
- 无密钥、session、`.pi-subagents`、本机绝对路径进入package。
- 删除appearance package、恢复theme/statusline/profile即可回到当前原生Pi。

### 11.4 Rollout 与离线发布runbook

以下命令只在用户分别授权rollout或离线发布后执行。

Rollout备份与snapshot：

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$AGENT_DIR/backups/terrific-native-v1-$STAMP"
install -d -m 700 "$BACKUP_DIR"
: >"$BACKUP_DIR/SHA256SUMS"
: >"$BACKUP_DIR/ABSENT_FILES"
for name in settings.json terrific.json statusline.json; do
  if [ -f "$AGENT_DIR/$name" ]; then
    cp -a "$AGENT_DIR/$name" "$BACKUP_DIR/$name"
    ( cd "$BACKUP_DIR" && sha256sum "$name" ) >>"$BACKUP_DIR/SHA256SUMS"
  else
    printf '%s\n' "$name" >>"$BACKUP_DIR/ABSENT_FILES"
  fi
done
# 通过structured JSON工具原子应用已批准配置后：
./scripts/snapshot.sh
```

发布与安装smoke：

```bash
TMP_RELEASE="$(mktemp -d "${TMPDIR:-/tmp}/terrific-native-release.XXXXXX")"
trap 'rm -rf "$TMP_RELEASE"' EXIT
DIST_KEEP=0 ./scripts/pack.sh "$TMP_RELEASE/dist"
ARCHIVE="$(find "$TMP_RELEASE/dist" -maxdepth 1 -type f -name 'terrific-pi-*.tar.gz' -print -quit)"
tar -xOf "$ARCHIVE" --wildcards '*/MANIFEST.txt' \
  | grep -Fx '../vendor/terrific-pi/extensions/appearance'
./scripts/test-install.sh
```

Rollback时先复制backup中的原文件，并按`ABSENT_FILES`删除本轮新增文件；然后执行`( cd "$AGENT_DIR" && sha256sum -c "$BACKUP_DIR/SHA256SUMS" )`确认原文件hash，再`/reload`或重启Pi。不得用snapshot覆盖真实密钥或session。

## 12. 并行执行DAG

```text
Wave 0 - Integration lead
  冻结base commit、owner matrix、profile/theme/widget key、baseline captures
       |
       +--> Team A appearance -------------------+
       +--> Team B presentation -----------------+
       +--> Team C statusline -------------------+--> Wave 2 Team F merge/integration
       +--> Team D taskboard -----------------+            |
       +--> Team E mode/btw ---------------------+            v
                                                     Wave 3 PTY/terminal matrix
                                                               |
                                                               v
                                                     Wave 4 independent review/fix
                                                               |
                                                               v
                                                     Wave 5 rollout checkpoint
```

### 12.1 Worker启动条件

- 先由用户授权把计划与必要基线放入一个clean coordination commit。
- 当前dirty working tree不能直接作为parallel worktree基线。
- A-E从同一base commit创建isolated branch/worktree。
- 每个worktree只有一个writer；reviewer只读。
- Worker不得更新root docs、snapshot、pack/install或其他team目录。
- Worker发现合同必须改变时停止并回报，不跨目录“顺手修”。

### 12.2 推荐branch

- `feat/native-tui-appearance`
- `feat/native-tui-presentation`
- `feat/native-tui-statusline`
- `feat/native-tui-taskboard`
- `feat/native-tui-modals`
- `integration/native-tui-v1`

### 12.3 Merge顺序

1. Team A，先让theme/package可加载。
2. Team C，terrific layout默认仍不激活。
3. Team B，运行两处patch与expanded fallback gate。
4. Team D，运行presentation + process组合测试，确认`process_update`不重复。
5. Team E，运行mode/btw语义回归。
6. Team F共享文件、temporary home、PTY和release验证。

B-E实现可并行，以上仅是integration branch的确定合并顺序。

## 13. 测试与证据矩阵

### 13.1 Package tests

| Package | 从仓库根执行的gate |
|---|---|
| appearance | `cd extensions/appearance && npm run typecheck && npm test` |
| presentation | `cd extensions/presentation && npm run check` |
| statusline | `cd extensions/statusline && npm test` |
| taskboard | `cd extensions/taskboard && npm run check` |
| mode | `cd extensions/mode && npm run check` |
| btw | `cd extensions/btw && npm run check` |

每个worker先写失败测试，再写最小实现；不得只更新snapshot让错误输出“通过”。

### 13.2 Core surface matrix

| Surface | States |
|---|---|
| Header | normal、narrow、low-height、profile off |
| Editor | empty、focused、multiline、paste、completion、custom-editor conflict |
| Shortcuts | defaults、remapped、missing binding、hidden responsive state |
| User | single/multiline、Markdown、OSC、CJK、narrow、profile off |
| Tool | pending、running、success、error、expanded、artifact、unknown |
| Assistant/thinking | native visible、native folded、theme colors |
| Footer | idle、thinking、working、waiting、terrific off、low-height |
| Task HUD | running、waiting、blocked、done、interrupted、telemetry missing |
| Mode/BTW | select、filter/scroll、back/cancel、long content、profile off |

每个适用surface至少覆盖80/120/160列；40列只要求安全退化。高度至少覆盖16/20/24。

### 13.3 Cross-package invariants

- Production target allowlist只有`UserMessageComponent.prototype`与`ToolExecutionComponent.prototype`，各一个安装点。
- `setHeader()`、`setEditorComponent()`生产调用只属于appearance；`setFooter()`只属于statusline。
- `terrific-pi:taskboard`只属于taskboard。
- `terrific-pi:appearance-shortcuts`只属于appearance。
- 没有appearance status key。
- 在相同theme和非terrific/effective-single layout下，profile inactive的结构与renderer golden等价当前基线。
- Profile on时同一事实不在header/editor/footer/widget重复。
- `process_update`完整steps只由taskboard pane显示。
- `mode`/`fast`仍由真实status值驱动。

### 13.4 PTY与terminal matrix

Tier 1：

- WSL2 + Windows Terminal。
- VS Code terminal。
- tmux。
- `TERM=xterm-256color`。
- truecolor与256-color。

Evidence：

- `80x24`、`120x40`、`160x50`的ANSI/text capture。
- idle、working、tool error、edit receipt、blocked task、BTW overlay。
- reload、new/resume、Ctrl+O expanded、Ctrl+C cancel。
- 退出后cursor、paste、terminal input正常。

PNG只作视觉审查，ANSI/plain render assertions是自动回归真源。

### 13.5 性能与生命周期

- idle无appearance timer。
- profile不使用watcher；所有consumer只在activation读取，文件修改经`/reload`或重启生效。
- statusline fast tick只在generation缓存的profile + terrific layout双激活且agent active时运行，目标约133ms；agent end/shutdown后为0。
- presentation 200ms timer只在running tool存在时运行。
- taskboard 1s timer只在active task telemetry存在时运行。
- 160列下单次纯render p95目标 `<16ms`，记录30次样本。
- 连续10次`/reload`后无重复widget、footer、timer或patch ref。

## 14. 完成定义

### 14.1 视觉

- [ ] `terrific-night`全token通过Pi 0.81.1 loader。
- [ ] 原生Pi root结构保留，但theme、header、editor、user、tool、footer、task和first-party modal形成统一视觉。
- [ ] 80/120/160无溢出、控制序列截断和不可解释重叠。
- [ ] 40列、16行可输入、可取消、可恢复。
- [ ] 中性品牌，无Grok/xAI logo或产品名。

### 14.2 行为

- [ ] Editor保留Pi native input行为。
- [ ] Assistant/thinking保持Pi native renderer。
- [ ] Expanded tools保持Pi native详情。
- [ ] Mode不放宽权限，BTW不污染主session。
- [ ] Process state与artifact state各有一个owner。
- [ ] Profile inactive在相同Pi theme与non-terrific/effective-single layout下与当前行为兼容。

### 14.3 工程

- [ ] A-E独立package tests通过。
- [ ] 组合PTY/terminal matrix通过。
- [ ] 无新增runtime dependency、host fork、overlay frontend或private patch。
- [ ] README/CAPABILITIES/package manifest一致。
- [ ] temporary home安装与rollback通过。
- [ ] 独立reviewer没有P0/P1 findings。

## 15. 风险与处理

| 风险 | 级别 | 处理 |
|---|---:|---|
| header/editor/footer last-writer-wins | 高 | package审计、明确owner、冲突时拒绝覆盖 |
| presentation private shape随Pi升级 | 高 | pin 0.81.1、fail-open、CAS/reload tests、patch上限 |
| 视觉目标误写成完整Grok复刻 | 高 | release固定称Grok-styled native Pi并列出非目标 |
| statusline隐藏native working后未恢复 | 高 | layout switch/shutdown/reload对称测试 |
| profile parser多包漂移 | 中 | 4.1冻结全局路径与8组向量，各包复制测试，不抽runtime library |
| ANSI/CJK宽度错误 | 中 | pi-tui width helpers + 40/80/120/160 tests |
| low-height chrome挤压editor | 中 | shortcuts/footer/header明确退化规则 |
| 第三方代码复制许可遗漏 | 中 | 默认不复制；复制前记录MIT来源和attribution |
| worker同时改共享根文件 | 高 | A-E禁改root，Team F最后唯一写入 |
| 当前工作区已有用户修改 | 高 | clean coordination commit后创建isolated worktrees，不覆盖dirty files |

## 16. Rollback

### 模块级

- Appearance：移除package或把`appearance.profile`设为`off`，theme切回`dark`。
- Presentation：profile off恢复当前frame/tool style；`/presentation user off`或`tools off`可进一步回native。
- Statusline：layout切回`single`/`stacked`，native working visibility恢复。
- Taskboard：profile off恢复当前render；`/taskboard off`关闭pane；`/process off`仅为兼容别名。
- Mode/BTW：profile off恢复当前menu/overlay。

### 整体

1. 从11.4 backup还原`settings.json` theme、editor/output padding与package entry，并验证原hash。
2. 删除 `terrific.json.appearance` profile。
3. 还原 `statusline.json` layout。
4. `/reload`或重启Pi。
5. 不需要session migration、Git reset或删除历史JSONL。

## 17. Worker交付模板

每个team回传：

```text
Module:
Branch/worktree:
Owned files changed:
Contract version: terrific-native-v1
Tests run:
Width/height cases:
Profile-off regression evidence:
Known gaps:
No-touch confirmation:
  - no root/shared files
  - no new prototype patch
  - no new runtime dependency
  - no live ~/.pi changes
```

## 18. 第一执行动作

在启动并行worker前，只做以下协调动作：

1. 用户确认本计划内容与default rollout是否需要同一轮完成。
2. 将计划与比较报告置于clean coordination commit；不混入当前auxiliary/pilot/scripts用户改动。
3. 在同一theme与single layout下记录Pi 0.81.1当前profile-inactive的80/120/160基线。
4. 从同一commit创建A-E五个isolated worktree。
5. 向每个worker发送对应section和冻结合同，不发送其他team写权限。

A-E完成后才启动Team F。Commit、push、snapshot和pack仍分别需要用户明确授权。
