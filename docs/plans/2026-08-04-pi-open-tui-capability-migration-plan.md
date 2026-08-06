# Pi Open TUI 能力迁移计划（现状重扫版）

> 日期：2026-08-04
>
> 状态：已实施（Phase 0-7）；自动化验收与当前 TUI rollout 已通过，Windows Terminal / VS Code terminal 人工矩阵待补
>
> 后续变更（2026-08-06）：本计划中的 `single`/`stacked`/`widgetGroups` 结论已被 [Statusline LINE0-4 Layout Design](./2026-08-06-statusline-line-layout-design.md) 取代。当前实现以 `lines.line0`-`lines.line4` 为唯一写入格式，旧格式仅兼容读取；下文相关内容保留为当时迁移记录，不再代表当前配置契约。
>
> 上游基线：`OldSuns/pi-open-tui@c280fcd054256e6ea080011e32d35a8f816949fb`（npm `0.2.10`）
>
> 本仓基线：`terrific-pi@cff31cfe9821bbd91ad062e1ae25bc05fab637f2`

## 1. 结论

采用“展示单位 + 独立外观包”迁移，不安装、复制或启用上游完整 package：

1. `extensions/statusline` 继续是唯一 footer owner，只吸收可独立展示的 Git worktree、runtime、TPS/TTFT/stall telemetry 和 glyph 能力。
2. `statusline` 不吸收 Open TUI 的固定两行、左右分区或最多三行等布局条件；新增单位必须进入现有 `single`、`stacked`、widget ordering 和 `widgetGroups` 体系。
3. 重新建立独立 `extensions/appearance` package，承接 Open TUI 的 header、rounded editor 和 `/appearance` 设置界面；不恢复旧 `appearance` 的 theme/profile/shortcuts/statusline layout。
4. `appearance` 初始标记 `"terrificPi": { "install": false }`，源码进入离线包但不会进入 install manifest 或 live packages。
5. 实施源码阶段不修改 live `~/.pi/agent/settings.json`、`terrific.json`、`statusline.json`，也不刷新 snapshot。live rollout 时执行唯一获准的插件替换：卸载 `pi-vision-handoff@0.8.1` 并启用 `appearance`。

该方案迁移 Open TUI 的用户可见能力，同时让当前 statusline 布局保持可组合，不把上游视觉编排变成本仓限制。上游 `index.ts` 不进入本仓。

## 2. 重新扫描后的事实

### 2.1 仓库变化

最新提交 `cff31cf chore(tui): remove terrific native UI suite` 已删除：

- `extensions/appearance`
- `terrific-night` theme
- `terrific-native-v1` profile
- header/editor/shortcuts 第一方 owner
- `terrific` statusline layout
- UI owner audit 脚本和相关 PTY fixture

因此不沿用旧计划中恢复整套 native UI suite 的路径。本计划只以同名独立 package 重新建立最小 `appearance` owner，代码和配置从零按 Open TUI 迁移边界实现，不恢复已删除的 theme、profile、shortcuts 或 `terrific` statusline layout。

### 2.2 当前 live 配置冻结面

源码实施阶段必须保持以下现状；Phase 7 rollout 只允许表后列出的显式差异：

- packages 顺序与内容不变；源码阶段不追加 `pi-open-tui` 或 `appearance`
- theme 保持 `dark`
- `outputPad` 保持 `0`
- `terrific.json` 现有 sections 与值不变
- `statusline.json` 保持当前 `stacked + emoji`、widget 顺序和 `widgetGroups`
- `taskboard.activityMode=full`、presentation 全部当前开关保持不变

Phase 0-6 使用 SHA-256 证明三个 live JSON 文件未变化。Phase 7 的允许差异只有：packages 移除 `npm:pi-vision-handoff@0.8.1`、加入 `../vendor/terrific-pi/extensions/appearance`，以及增加经批准的 `terrific.json.appearance` section；`statusline.json` 仍不得因 rollout 被重排或改写。

### 2.3 当前所有权

| UI/事实 | 当前 owner | 本计划规则 |
|---|---|---|
| footer | `statusline` | 继续唯一 owner，不新增第二个 `setFooter()` |
| task HUD | `taskboard` | 不改状态机和 renderer |
| user/tool transcript | `presentation` | 不改 prototype patch 范围 |
| editor | `pi-vision-handoff`（rollout 前） | Phase 7 卸载该包，由 `appearance` 成为唯一 owner |
| header | 无第一方 owner | Phase 7 后由 `appearance` 拥有 |
| mode/fast/aux/docsflow 状态 | 各自产生，statusline 汇总 | 继续使用现有 status key 和排除表 |

### 2.4 验证基线

- Pi / pi-tui：`0.83.0`
- `statusline`：150 tests passed
- `presentation`：typecheck + 72 tests passed
- `taskboard`：83 tests passed
- `pi-open-tui`：23 tests + typecheck passed
- 工作树：扫描时 clean

## 3. 上游能力清单与落点

| 上游能力 | 处置 | 目标 |
|---|---|---|
| Starship 两行 footer | 不迁移布局约束 | 仅拆出可独立展示的单位，沿用现有布局系统 |
| cwd/model/context/tokens/cost/cache | 复用现有实现 | `statusline`，不复制 `state.ts` |
| extension statuses | 复用现有去重逻辑 | `progress` widget；不显示专用 mode/fast/taskboard 两次 |
| working/done timer | 复用 `AgentDurationTracker` | `duration` + `state`，不建第二个 timer |
| Git dirty/staged/untracked/stash/ahead/behind | 重写 | 新 `worktree` widget |
| detached HEAD hash/tag | 重写 | `worktree` widget 可选 detail |
| runtime 检测与版本 | 选择性移植并修正 | 新 `runtime` widget |
| TPS/TTFT/stall/run cost rate | 移植纯 tracker | 六个独立 `run*` widgets + 可选 notification |
| Nerd Font/ASCII glyph | 扩展现有 icon mode | `statusline` glyph resolver |
| startup header/dashboard | 选择性移植 | `appearance` |
| rounded editor | 选择性移植 | `appearance`，rollout 前卸载 `pi-vision-handoff` |
| `/open-tui` 多 tab 设置 | 按 owner 拆分 | 外观设置迁入 `/appearance`；footer 设置仍由 `/statusline` |
| 设置中英文 | 迁移 appearance；statusline 后续可选 | 不改变现有英文默认 |
| 独立 `open-tui.json` | 拒绝 | appearance 使用 `terrific.json.appearance`；footer 使用 `statusline.json` |
| ANSI 清屏 | 拒绝 | 不直接写 stdout，不清屏 |
| 聚合 `index.ts` | 拒绝 | 不允许一个包同时抢 header/footer/editor |
| usage cache over `getEntries()` | 拒绝 | 继续按 active branch 聚合，保留 aux usage |

### 3.1 文档与实现冲突

上游 README 宣称“16-frame animated logo”，但固定提交中的 `OpenTuiHeader` 使用固定最终 frame，没有动画调度。迁移验收以源码行为为准：

- v1 迁移静态 logo/header；
- 动画属于可选增强，不计入“上游能力迁移完成”；
- 若后续增加动画，必须使用 demand-based timer，idle 时零 timer，并另行批准。

## 4. 目标架构

```text
settings.json (Phase 0-6 保持不变；Phase 7 执行明确替换)
  ├─ statusline                     唯一 footer owner
  │    ├─ existing single/stacked layouts
  │    ├─ existing widget ordering/widgetGroups
  │    ├─ worktree/runtime + six run-metric units (opt-in)
  │    └─ current /statusline config owner
  │
  ├─ taskboard                      任务事实与 HUD，不变
  ├─ presentation                   transcript owner，不变
  ├─ pi-vision-handoff              Phase 7 卸载
  └─ appearance                     Phase 7 启用
       ├─ header
       ├─ rounded editor
       └─ /appearance settings

terrific.json
  └─ appearance                     Phase 7 新增；此前 section absent

statusline.json
  ├─ current layout/config          原样有效、渲染不变
  └─ new display units              仅在用户显式选择时写入
```

## 5. 配置设计

### 5.1 `statusline.json`

本次纠正直接移除错误的 `performance`/`telemetry` 展示 schema，不为尚未发布的旧配置增加迁移层。新字段仍保持 optional，缺失时使用关闭态。

目标 schema：

```json
{
  "iconMode": "emoji | plain | nerd | ascii | auto",
  "widgets": [
    "...",
    "worktree",
    "runtime",
    "runTps",
    "runTtft",
    "runDuration",
    "runTokens",
    "runStalls",
    "runCostRate"
  ],
  "widgetGroups": { "runTtft": "activity" },
  "runNotification": false
}
```

规则：

- 不新增 `layout: open` 或任何 Open TUI 固定行列布局。
- 六个 `run*` 指标与现有 widgets 一样可独立启用、禁用、排序和编组。
- 当前 `single/stacked`、`widgetGroups` 和响应式 drop 行为保持。
- 当前 `iconMode: emoji` 保持，不自动切为 `auto`。
- 新 widgets 不加入现有 `DEFAULT_CONFIG` 和 minimal profile。
- `runNotification` 缺失等价于 `false`，并作为 `/statusline` 中的独立开关；应用 visual/minimal profile 时保留该值。
- 任一 `run*` widget 或 `runNotification` 启用时，共用的 tracker 才采集；两种输出可同时启用。
- 旧 `performance` widget 和 `telemetry` 对象不再识别。
- `/statusline reset` 仍恢复当前 package 默认，而不是 Open TUI profile。

### 5.2 `terrific.json.appearance`

建议 schema：

```json
{
  "appearance": {
    "enabled": true,
    "settingsLanguage": "en",
    "header": true,
    "editor": true
  }
}
```

规则：

- Phase 0-6 不写入该 section；Phase 7 与 package 替换一起写入。
- section 缺失或 malformed：fail closed，零 UI 副作用。
- `editor: true` 时，`appearance` 预期成为唯一 editor owner。
- 仍使用 `ctx.ui.getEditorComponent()` 做通用冲突检测；检测到未知 foreign editor 时停止 rollout，而不是覆盖。
- 不提供 `force` 模式。
- `/appearance` 只修改 `appearance` section，并采用现有 atomic section writer 模式。
- 设置变更在 `/reload` 后生效，命令不在旧 extension frame 中动态卸载 header/editor。

## 6. 分阶段实施

### Phase 0：来源、许可与特征基线

目标：建立可审计迁移基线，不改变运行行为。

任务：

1. 在计划和目标文件中固定上游 commit `c280fcd`。
2. 为实质移植代码增加 MIT attribution：
   - `extensions/statusline/LICENSES/pi-open-tui-MIT.txt`
   - `extensions/appearance/LICENSES/pi-open-tui-MIT.txt`
   - 直接派生文件顶部标注来源、固定 commit 和本仓修改范围。
3. 为当前 live 三个 JSON 文件记录临时 SHA-256，仅用于验证，不提交机器路径或摘要清单。
4. 给 current statusline output 增加 characterization fixtures：当前配置在 80/120/160 列下的 plain semantic output。

验收：

- 当前三包基线测试仍全绿。
- `git diff` 不包含 live/snapshot 配置。
- 归档不会包含 `/tmp/pi-open-tui-analysis` 或其 `node_modules`。

### Phase 1：Telemetry 纯逻辑迁入 statusline

目标：先迁移独立、价值最高且不涉及 UI owner 的能力。

目标文件：

- 新增 `extensions/statusline/lib/telemetry.ts`
- 新增 `extensions/statusline/tests/telemetry.test.ts`
- 修改 `lib/types.ts`、`lib/config.ts`、`lib/configure.ts`
- 修改 `extensions/statusline.ts` 接线生命周期

实现：

1. 移植 `TurnTelemetryTracker`，去掉 Open TUI config/icon/notify 依赖。
2. 复用 Pi 事件：`agent_start`、`turn_start`、`message_start/update/end`、`turn_end`、`agent_settled`。
3. `agent_settled` 产出一次 last-run snapshot；tool gap 不进入 generation time。
4. 在 `session_start/shutdown/tree`、中断、异常和新 generation 边界清空 transient 状态。
5. 没有 `run*` widget 且 `runNotification` 关闭时不采集、不通知、不增加 footer 行。
6. 非有限 usage 不抛出到 extension event loop；该次样本标记 unavailable 并保留 Pi 主流程。

验收：

- 移植上游 TPS/TTFT/stall/multi-turn/non-streamed tests。
- 新增 abort/retry/compact/tree/reload/10-generation 泄漏测试。
- print/json/rpc 模式零通知。
- current statusline output characterization 完全不变。

回滚：删除 tracker 与 run-metric 接线；无 session migration。

### Phase 2：Run metric widgets 与可选通知

目标：让 settled-run 指标以普通展示单位进入现有 footer owner，不新增 renderer。

目标文件：

- `lib/types.ts`：`TurnPerformanceView` 与六个 `run*` widget ids
- `lib/format.ts`：单指标 formatter 与通知聚合 formatter
- `lib/widgets.ts`：普通 widget builder
- `lib/configure.ts`：独立 `Run notification` 开关
- `lib/render.ts`：沿用现有响应式 drop

实现：

1. `runTps`、`runTtft`、`runDuration`、`runTokens`、`runStalls`、`runCostRate` 分别生成独立 segment。
2. 下一个 agent run 开始时隐藏上一次 snapshot，不能显示旧数据为当前运行事实。
3. `runNotification` 开启时每个 settled agent run 最多通知一次。
4. notification 与任意 `run*` widgets 解耦并允许同时启用，共用同一 settled snapshot。
5. run tokens/cost rate 仅表示本次 agent run；session 累计继续由现有 `tokens`/`cost` widgets 负责。
6. 各指标只按自身依赖判定可用性；缺少 cost/total 不得隐藏可用的 tokens/TPS，缺少 input 不得隐藏可用的 TPS/cost rate。

验收：

- 40/80/120/160 列不溢出。
- 六个指标均可独立排序、编组、启停和响应式 drop。
- taskboard waiting/blocked、auxiliary usage 和 subagent 工具流程不改变。

### Phase 3：Worktree 与 runtime 数据能力

目标：迁移 Open TUI footer 中现有 statusline 尚未覆盖的项目环境信息。

新增文件：

- `extensions/statusline/lib/worktree.ts`
- `extensions/statusline/lib/runtime-info.ts`
- 对应 tests

#### Worktree

不得复制上游 parser。实现要求：

1. 使用 `pi.exec("git", ["--no-optional-locks", ...])`，不用 shell 或 `child_process`。
2. 使用 `git status --porcelain=v2 --branch --show-stash` 或等价结构化输出。
3. 支持仓库子目录、linked worktree、detached HEAD、ahead+behind、stash、conflict、rename、delete、staged、modified、untracked。
4. 2 秒超时；错误返回 unavailable，不影响 footer。
5. 沿用 statusline lifecycle/request generation guard，拒绝 stale async result。
6. 仅在 `worktree` widget 启用时查询。

#### Runtime

1. 移植上游定义表，但重排优先级：专用 manifest 优先于 `Makefile`、`CMakeLists.txt` 等通用 marker。
2. 一次只显示 primary runtime；选择规则确定且有 fixture。
3. 使用 `pi.exec` 获取版本；不经过 shell。
4. 2.5 秒超时、32 cwd cache 上限；marker fingerprint 变化才刷新。
5. 仅在 `runtime` widget 启用时探测。
6. 多语言 monorepo 允许显示 `runtime ?`，不伪造唯一语言结论。

验收：

- worktree fixtures 覆盖 root/subdir/worktree/detached/diverged/stash/conflict。
- runtime fixtures覆盖 Node/Python/Rust/Go、C/CMake 冲突、多 marker、命令缺失和 timeout。
- disabled widgets 时 `pi.exec` 调用数为 0。

### Phase 4：展示单位接入与 glyph

目标：把 Open TUI 可展示事实作为普通 statusline units 接入，不迁移其固定 footer 编排。

实现：

1. `worktree`、`runtime` 与六个 `run*` 指标都注册为普通 widget，可独立启用、禁用、排序和分组。
2. 不新增 layout enum，不增加固定两行、左右区或第三 progress 行。
3. 所有事实来自现有 `StatusSnapshot` 及 Phase 1-3 新字段。
4. extension statuses 继续使用现有 `EXCLUDED_PROGRESS_KEYS`；不复制上游“显示全部 status”行为。
5. 增加 `nerd/ascii/auto` glyph resolver；`emoji/plain` 保持现有输出。
6. 宽度不足时继续按现有 priority/drop 和 `widgetGroups` 机制降级，不引入第二套 renderer framework。

验收：

- current `single/stacked` 全部 characterization 不变。
- 新 widgets 在现有 `single/stacked` 下均可单独和组合渲染。
- 40/80/120/160 列下 CJK、ANSI、OSC、超长路径和模型名不溢出。
- formatter/render benchmark 无明显回退；如无现成 benchmark，增加一个最小 p95 check。

### Phase 5：重新建立 source-only `appearance`

目标：用独立 package 承接 Open TUI header/editor/settings，但不恢复已删除的 theme/profile/shortcuts/statusline layout。

目录：

```text
extensions/appearance/
├── package.json
├── README.md
├── LICENSES/pi-open-tui-MIT.txt
├── extensions/appearance.ts
├── lib/config.ts
├── lib/header.ts
├── lib/editor.ts
├── lib/settings.ts
├── lib/utils.ts
└── tests/
```

package 规则：

- 零 runtime dependencies。
- Pi packages 只放 peerDependencies `"*"`。
- `"terrificPi": { "install": false }`，直至 Phase 7 rollout 批准。
- 不提供 theme，不恢复 `terrific-night`、profile、shortcuts 或 statusline layout。
- 不调用 `setFooter`、`setStatus` 或 transcript prototype。

Header：

1. 移植静态 logo、Pi version、model/thinking/cwd 和 command tips。
2. 24 列以下退化为单行版本标识。
3. 不执行 ANSI clear、不直接写 stdout。
4. 不启动永久动画 timer。
5. header 只在 `appearance.enabled && appearance.header` 时于 `session_start` 安装。

Editor：

1. 移植 rounded border、rail、scroll label 和 width-safe render。
2. 继续继承 `CustomEditor`，不重写 submit/history/paste/autocomplete/IME 路径。
3. rollout 前卸载 `pi-vision-handoff`；appearance 不包含该插件的 prewarm、routing 或 usage bridge。
4. 安装前仍检查 `ctx.ui.getEditorComponent()`；发现其他 foreign editor 时停止并报冲突，不覆盖。
5. 不提供 force、wrapper import 或对第三方 editor 私有源码的依赖。
6. 不在 shutdown 中无条件 `setEditorComponent(undefined)`；Pi reload/session teardown 负责清理。

Settings：

1. 注册 `/appearance`，管理 General/Header/Editor/Language。
2. 不提供 Footer/run-metrics tab；footer 配置完整留给 `/statusline`。
3. 配置写入 `terrific.json.appearance` section，复用原子 section update 模式。
4. runtime 变更写盘后提示 `/reload`，不在旧 command frame 中抢占或清空 UI owner。

验收：

- config absent/malformed/headless：零 UI 副作用。
- 无 `pi-vision-handoff` 时 appearance 是唯一 editor owner；存在任何其他 editor 时 fail closed。
- 10 次 start/shutdown/reload 无 handler/timer/widget 泄漏。
- editor 输入、newline、history、paste、原生 image input、autocomplete、IME cursor 和 border color 全部保持原生路径。
- settings 在 24/36/48/80 列中英文均不溢出。
- source scan 证明 package 无 `setFooter` 和 prototype patch。

### Phase 6：跨包集成、文档与离线生命周期

目标：把迁移能力登记完整，但保持 live rollout 未发生。

任务：

1. 更新根 README 插件表，标明 `appearance` source-only、Phase 7 前默认不安装。
2. 更新 `docs/CAPABILITIES.md`：
   - statusline 新 display units，不新增布局
   - appearance 的 header/editor owner 边界
   - `pi-vision-handoff` 将被替换及其能力影响
3. 更新 `extensions/statusline/README.md`、appearance README 和 auxiliary README 的迁移说明。
4. 为 auxiliary 增加“vision command absent” characterization，确认 Phase 7 删除 bridge 后不会影响其他六个公开 routes；Phase 0-6 保留现有 bridge 代码和运行行为。
5. 增加组合 harness：statusline + taskboard + presentation + appearance(disabled/enabled)。
6. 运行 pack self-check，确认 source-only appearance 随归档但不进入 install manifest。
7. 临时 PI_HOME install smoke；验证默认安装结果不新增 appearance package、不新增配置 section。

验收：

- 所有变更包测试/typecheck 通过。
- `./scripts/pack.sh` 和临时安装 smoke 通过。
- live 三个 JSON SHA-256 与 Phase 0 相同；Phase 7 前不允许插件替换。
- snapshot 未变化。
- `git diff --check` 通过，无密钥、绝对本机路径或 runtime 文件。

### Phase 7：`pi-vision-handoff` → `appearance` 原子 rollout

这是唯一获准修改 live 插件配置的阶段：

1. 备份并记录 live `settings.json`、`terrific.json`、`statusline.json` SHA-256。
2. 使用官方 package 命令 `pi remove npm:pi-vision-handoff@0.8.1` 从 user settings 卸载，不手工删除 npm cache。
3. 将 `appearance` 从 source-only 改为 installable，并通过本仓 installer 或明确 package entry 加入 packages。
4. 写入经批准的 `terrific.json.appearance` section；`statusline.json` 不改布局，只在用户明确选择新 units 时追加 widgets。
5. 在同一 rollout checkpoint 更新 auxiliary：删除 `/vision-handoff` 外部设置入口和 `vision-handoff:usage` bridge；保留通用 image-capable model 能力，不新建替代 routing。
6. `/reload` 后验证 editor owner 只有 appearance；若仍检测到 foreign editor，立即停止 rollout。
7. 验证 `/aux config` 不再展示 Vision external entry，其他六个公开 routes 保持。
8. Windows Terminal 与 VS Code terminal 验收 80x24、120x40、160x50、truecolor/256-color。
9. 验证 `/reload`、`/new`、`/resume`、`/tree`、Ctrl+O、paste、原生 image-capable model 输入、BTW、taskboard waiting/blocked、subagent、tool error。
10. 明确记录卸载影响：`/vision-handoff`、paste-time prewarm、非视觉模型转交和其 usage bridge 消失；不得把这些能力误报为 appearance 已替代。
11. rollout 通过后才刷新 snapshot；仍不创建 `open-tui.json`。

失败回滚：移除 appearance package/config section，重新 `pi install npm:pi-vision-handoff@0.8.1`，恢复备份配置并 `/reload`。

## 7. 明确不实施

- 不直接 `pi install npm:pi-open-tui`。
- 不把上游 `index.ts` 放进任何 package。
- 不恢复旧 `appearance` 的 `terrific-night`、profile、shortcuts 或 `terrific` statusline layout；只复用独立 package 名称和 owner 边界。
- 不引入根 Node workspace。
- 不复制上游 package-lock、node_modules 或 dev dependency allowScripts。
- 不让 appearance 接管 footer。
- 不让 statusline 接管 header/editor 或 Open TUI 固定布局。
- 不修改 presentation 的 user/tool renderer 来模拟 Open TUI。
- 不把 taskboard telemetry 与 generation TPS 混成同一事实。
- 不靠 packages 排序覆盖 editor；先正式卸载 `pi-vision-handoff`，再启用 appearance。
- 不直接写 ANSI clear-screen、mouse capture 或 alternate screen。
- 不永久保留双配置兼容层；本仓不创建 `open-tui.json`。

## 8. Acceptance Checklist

### 保留现状

- [x] Phase 0-6 live `settings.json` 未变
- [x] Phase 0-6 live `terrific.json` 未变
- [x] live `statusline.json` 未因迁移被改成固定布局
- [x] Phase 0-6 snapshot 未变；Phase 7 rollout 后已刷新并消毒
- [x] current stacked footer characterization 未变
- [x] presentation 72 tests 继续通过
- [x] taskboard 83 tests 继续通过

### Statusline

- [x] 仍只有一个生产 `setFooter()` owner
- [x] tracker 每 agent run 最多一个 settled snapshot
- [x] 六个 run metrics 是独立 widgets，notification 与其解耦并可同时启用
- [x] worktree 支持 subdir/worktree/diverged/detached
- [x] runtime disabled 时不启动版本命令
- [x] `single/stacked` 不回归
- [x] 没有新增 `layout: open` 或固定两行/三区 renderer
- [x] 新 units 可独立排序、编组、启停，并在 40/80/120/160 列安全

### Appearance

- [x] Phase 7 前 source-only，不进入默认 install manifest
- [x] config absent 时零副作用
- [x] 不调用 `setFooter`
- [x] rollout 时 `pi-vision-handoff` 已从 user packages 移除
- [x] appearance 是唯一 editor owner；未知 foreign editor 触发失败而非覆盖
- [x] 不清屏、不直接写 stdout
- [x] `/appearance` 只写 `terrific.json.appearance`
- [x] 10-generation lifecycle clean

### 发布与安全

- [x] MIT attribution 随源码和离线包分发
- [x] 无 secrets/session/runtime state
- [x] package manifest 路径真实存在
- [x] README/CAPABILITIES 与磁盘一致
- [x] pack self-check 和临时 install smoke 通过

## 9. 回滚

- Phase 1-4：新单位与通知均 opt-in；删除对应 widget/notification 接线即可，无 layout 或 session migration。
- Phase 5-6：删除 source-only `appearance` 目录及登记即可；默认安装和 live 配置尚未引用它。
- Phase 7：移除 appearance/config section，重新 `pi install npm:pi-vision-handoff@0.8.1`，恢复备份配置并 `/reload`。
- 所有阶段独立提交，禁止将 statusline 单位迁移、appearance UI 和 live 插件替换混在同一 commit。

## 10. 实施顺序与提交建议

1. `test(statusline): freeze current footer compatibility`
2. `feat(statusline): add optional turn telemetry`
3. `feat(statusline): add worktree and runtime widgets`
4. `feat(statusline): add display units and glyph modes`
5. `feat(appearance): add source-only Open TUI header and editor`
6. `docs: document open tui capability migration`
7. rollout commit：卸载 `pi-vision-handoff`、移除 auxiliary bridge 并启用 `appearance`，单独授权

每个 commit 后运行对应 package tests；Phase 6 再运行组合、pack 和 install smoke。commit、push 与 snapshot 仍需独立授权；本轮用户已批准 Phase 7 的插件替换方向，但实际卸载只在实现、测试和备份全部完成后执行。
