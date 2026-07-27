# terrific-pi monorepo 能力全景

> 本文件是个性化 Pi 增强组件 monorepo 的**能力地图 + 插件决策账本**。
> 目标：一眼看清「有什么、怎么调用、彼此如何协作、为什么存在」。  
> 更新时机：新增/大改 extension、skill、agent 或 workflow，引入外部 pin 包，改变跨插件约定时。

相关文档：

| 文档 | 用途 |
|------|------|
| [README.md](../README.md) | 安装/迁移/插件表（对外摘要） |
| [AGENTS.md](../AGENTS.md) | monorepo 全局与目录契约（检索、结构、打包） |
| [SESSION_LESSONS.md](./SESSION_LESSONS.md) | 全量历史 session 复盘、踩坑与长期契约 |
| [workflows/README.md](../workflows/README.md) | 跨 package workflow 归属与加载边界 |
| [docs/plans/](./plans/) | 单特性设计与实施计划 |
| [snapshot/README.md](../snapshot/README.md) | 快照白名单与密钥消毒 |

---

## 1. 仓库结构（运行视角）

```text
terrific-pi/
├── extensions/          # 可安装 pi packages（本机能力主体）
├── skills/              # 可迁移 agent skills → ~/.agents/skills
├── snapshot/agent/      # 无密钥配置快照（迁移用）
├── agent/               # 可公开配置模板
├── scripts/             # snapshot / pack / install
├── docs/
│   ├── CAPABILITIES.md  # 本文件
│   └── plans/           # 设计与实施计划
├── workflows/           # 跨 package workflow 契约；不隐式自动加载
└── dist/                # 可再生成的离线包，默认仅保留最新 5 个
```

`terrific-pi` 是产品与治理边界，不是根级 runtime：每个 extension 可独立安装、启用和测试；兼容扩展才通过 Pi 的公共 API 和明确配置/status 契约组合。`terrific-night` 是计划中的中性 theme id，只有未来 `appearance` package 落地后才可选择；它与 `statusline`、`taskboard`、`presentation` 的组合是完整原生 TUI profile，而非任何单包的前置条件。

**加载关系（开发机典型）**：

```text
~/.pi/agent/settings.json
  packages: [
    "../vendor/terrific-pi/extensions/<name>",   # 本仓插件
    "npm:pi-subagents@…",                        # 外部 pin
    …
  ]
       │
       ▼
   pi 启动加载 extensions
       │
       ├─ statusline 接管 footer HUD
       ├─ mode / fast / … 注册 slash 与 status
       ├─ auxiliary 提供旁路 runtime + 工具
       └─ skills 另路径：~/.agents/skills（install/snapshot 同步）
```

---

## 2. 能力总表（调用入口）

### 2.1 本仓 extensions

| 能力 | 包路径 | 怎么调用 | 解决什么 | 实现性质 |
|------|--------|----------|----------|----------|
| 底栏 HUD | `extensions/statusline` | 自动 footer；`/statusline` 配置 | 一眼看 path/model/tokens/mode/fast/状态；仅相关 widget 启用时显示 Context & usage | **本仓实现**（可配置 widget） |
| 工具权限模式 | `extensions/mode` | `/mode ask\|plan\|edit\|auto\|config` | 会话内限制可写/可执行工具，并管理全局默认 | **本仓实现** |
| Pilot control plane | `extensions/pilot` | Phase 0 未启用；后续 `/pilot` + `/mode` | 双激活、direct role contract、AUTO input routing 与共享 Auxiliary router 的安全前提 | **本仓 Phase 0 spike**；不创建 Bundle/Worker/写入授权 |
| OpenAI Priority | `extensions/fast` | `/fast [on\|off\|toggle\|status]` | 仅 GPT 模型 + openai 家族 Responses 时注入 `service_tier=priority` | **本仓实现**（窄注入） |
| 上下文拆解 | `extensions/context` | `/context [summary\|details\|config]`；`c` 复制、`x` 确认压缩 | 不调模型查看占用；压缩为显式动作 | **本仓实现** |
| 旁路问答 | `extensions/btw` | `/btw …`、`status`、`config`、`context=none` | 独立内存会话问答，不污染主 session | **本仓实现**；模型可走 auxiliary 路由 |
| 辅助模型 runtime | `extensions/auxiliary` | 裸 `/aux` 管理器、`/aux status`；工具 `aux_summarize`/`web_research`/`git_finalize`；compact/title 钩子 | 任务级旁路模型，不改主会话模型 | **本仓实现**；研究/视觉 **委托外部 pin** |
| 任务进度 HUD | `extensions/taskboard` | 模型调 `process_update`；`/taskboard` 管理、`default <mode>`；`Ctrl+O` 展开 | 多步任务里程碑、等待/阻塞与验证；可提供稳定的运行中活动行 | **本仓实现** |
| 低噪音过程流 | `extensions/presentation` | 自动；`/presentation` 管理；`Ctrl+O` 下钻 | 受控兼容 renderer、探索/失败摘要、Skill 身份、系统条和文件回执 | **本仓实现**；不依赖外部 renderer fork |
| 文档流水线 | `extensions/docsflow` | 裸 `/docsflow` 管理器、`settings`、阶段 override | research→product→interface→delivery | **本仓编排**；执行靠 `pi-subagents` |
| 模型常用配置 | `extensions/model-profile` | `/profile` 管理/快速应用、可信项目 overrides、`list/status/startup`、`<id\|alias>`、`alt+N`、冷启动/`/new`；见 [计划](./plans/2026-07-20-model-profile-plan.md) | 3–5 套 model+thinking；全局/project 来源；session/global；启动 | **本仓薄封装**；配置 `terrific.json` |

### 2.2 本仓 skills

| 能力 | 路径 | 怎么用 | 解决什么 | 实现性质 |
|------|------|--------|----------|----------|
| Provider 模型同步 | `skills/pi-provider-sync` | 对话触发 / 按 SKILL 指引 | 从 OpenAI 兼容或 Anthropic Messages `/models` 刷 `models.json`、补 `input`/`reasoning`/`cost` 等字段 | **本仓 skill**（非 extension） |

### 2.3 本机常 pin 的外部包（不在本仓实现，但构成能力）

以当前开发机 `settings.json` 为准（迁移后可能不同）：

| 包 | 典型调用 | 角色 | 与本仓关系 |
|----|----------|------|------------|
| `npm:pi-subagents@…` | `subagent` 工具；docsflow / web_research | 子代理运行时 | auxiliary `web_research`、docsflow **依赖** |
| `npm:pi-web-access@…` | `web_search` / `fetch_content` / … | 联网检索与抓取 | 研究链路；不进 auxiliary 内核 |
| `npm:pi-vision-handoff@…` | vision 相关工具 | 多模态交接 | auxiliary 只桥 usage |
| `npm:cc-safety-net@…` | 自动拦截高危 shell | 安全网 | 正交 |
| `npm:@ayulab/pi-rewind@…` | rewind 相关 | 会话回滚 | 正交 |
| `git:…/ponytail` | 技能：偷懒实现纪律 | 开发风格 | 正交 |

### 2.4 官方 pi 内建（不重复造）

| 能力 | 调用 | 备注 |
|------|------|------|
| 全量模型选择 | `/model`、`Ctrl+L` | 长列表权威入口 |
| 模型循环 | `Ctrl+P` / `Shift+Ctrl+P` | 受 enabled/scoped models 影响 |
| 保存默认模型 | `Ctrl+S` | 写 defaultProvider/Model（thinking 另设） |
| 思考强度 | `Shift+Tab` 等 | 与 model-profile 的 profile.thinking 互补 |
| 设置 | `/settings` | 全局项 |

---

## 3. 协作与数据流

### 3.1 主会话 vs 旁路

```text
                    ┌──────────── 主会话 ────────────┐
 用户输入 ─────────►│ model / thinking / tools       │
                    │ mode 限制工具集                 │
                    │ fast 注入 Priority（若开启）    │
                    │ process_update → taskboard      │
                    │ docsflow 编排（父）              │
                    └───────────┬────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
     /btw 旁路            auxiliary 任务          pi-subagents
   (独立内存 session)    compact/title/summarize   researcher 等
          │                     │                     │
          └──────────► 不写主 session 历史 ◄──────────┘
                       usage 可由 statusline/aux 展示
```

### 3.2 HUD 分层

| 层 | 谁负责 | 内容 |
|----|--------|------|
| Footer 常驻 | **statusline** | path、branch、model+thinking、cache、cost、mode、fast、progress/state/duration；默认不启用 `toolActivity`、tokens、session、branchDiff |
| 任务 HUD | **taskboard** | 多步任务目标、步骤、blocker、等待/阻塞与验证；`activityMode: full` 在紧凑 HUD 提供聚合运行态、在展开面板提供详情 |
| 过程历史 | **presentation** | 受控折叠原生工具行；运行中探索/Skill 身份与单一安全失败行，`app.tools.expand` 恢复 Pi 原生细节 |
| 扩展 status key | 各插件 `setStatus` | mode / fast / taskboard / auxiliary 等；statusline 对部分 key **排除重复展示**（见 `EXCLUDED_PROGRESS_KEYS`） |

约定：

- 有专用 badge 的 key（如 `mode`、`fast`）不要再塞进通用 progress 区抢位  
- 长时任务优先 `process_update`，不要刷屏自然语言进度  

### 3.3 配置文件归属

| 文件 | 谁读 | 内容 |
|------|------|------|
| `~/.pi/agent/settings.json` | pi 核心 + 全局默认 | packages、defaultProvider/Model/ThinkingLevel、theme… |
| `~/.pi/agent/terrific.json` | mode / btw / context / auxiliary / docsflow / model-profile / fast / taskboard / presentation | 本仓插件共享配置；Taskboard `0.2.0` 不再注册 `/process`，仍可读取并迁移旧 `processView` |
| `~/.pi/agent/statusline.json` | statusline | widget 布局与 profile |
| `~/.pi/agent/models.json` | pi + pi-provider-sync | 自定义 provider/models |
| `~/.pi/agent/auth.json` | pi | **密钥；禁止入库** |
| 项目 `.pi/*` | 各插件（受 trust） | 项目覆盖；auxiliary 路由**禁止** project 覆盖模型 |

### 3.4 交互矩阵（简化）

|  | statusline | mode | fast | context | btw | auxiliary | taskboard | docsflow | model-profile* |
|--|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| statusline | — | 读 mode badge | 读 fast badge | 无 | 无 | 可展示 aux usage | 排除 taskboard 重复 | 可选阶段 | 已有 model 行 |
| mode | badge | — | 无 | 无 | 无 | ask/plan 限制工具是否含 aux | 无 | apply 需可写模式 | 无 |
| fast | badge | 无 | — | 无 | 无 | 不继承 | 无 | 不继承 | 无 |
| btw | 无 | 无 | 无 | 无 | — | **可走 btw 路由** | 无 | 无 | 无 |
| auxiliary | usage/status | 工具可见性 | 无 | 无 | 路由 | — | web_research 活动文案 | 无 | **不改主模型** |
| taskboard | HUD 分工 | 无 | 无 | 无 | 无 | 活动标签协作 | — | 可报阶段 | 无 |
| docsflow | 可选 | 落盘权限 | 无 | 无 | 无 | 不占用 | 阶段进度 | — | 无 |
| model-profile* | model 行（原生）；官方切换 notify | 无 | 无 | 无 | 无 | 正交 | 无 | 无 | — |

\* 计划中，见 §5。

---

## 4. 插件决策账本

> 规则：新增插件必须登记。**优先安装/引用社区；仅当缺口明确时本仓新建。**

| 名称 | 状态 | 为何要有 | 解决的问题 | 实现策略 | 明确不做什么 |
|------|------|----------|------------|----------|--------------|
| statusline | 已收录 | 官方 footer 不够密/不可配 | 可配置 HUD、quota、stacked/minimal | 本仓实现 | 不替代 taskboard 任务面板 |
| mode | 已收录 | 需要会话级工具策略 | ask/plan/edit/auto | 本仓实现 | 不切换模型/thinking |
| fast | 已收录 | Priority 无一键开关 | `service_tier` 注入 | 本仓窄实现 | 不控制 thinking、不通用 header 框架 |
| context | 已收录 | 需要可解释上下文占用 | `/context` 拆解 | 本仓实现 | 不压缩、不调模型 |
| btw | 已收录 | 主会话外快速问一句 | 旁路内存 session | 本仓实现 | 不写主历史、不加载工具 |
| auxiliary | 已收录 | Hermes 式任务槽 | compact/title/summary/research/git | 本仓 runtime + 外部 pin | 不做万能 agent 框架 |
| pilot | Phase 0 实施中，未启用 | 现有 workflow 包不覆盖双激活、权限闭环与 Canonical Bundle 契约 | 验证 Pilot activation、single-path routing 与 Auxiliary bridge | 本仓薄控制面，复用 Auxiliary 与 pi-subagents | 不复制 tmux/runtime；不在 Phase 0 写项目或取代 mode/docsflow |
| taskboard | 已收录 | 多步任务可见性 | `process_update` + HUD | 本仓实现 | 不为每句回复建任务或重复文件/结论 |
| presentation | 已收录 | 摆脱外部 renderer fork，同时保留低噪音过程流与用户输入边框 | 受控 compatibility renderer + 原生工具历史 | 本仓实现 | 仅受控 patch 两个 render 方法；不重写最终 Markdown、不接管工具执行 |
| docsflow | 已收录 | 文档流水线要可迁移 | 四阶段 + 落盘 | 本仓编排 + pi-subagents | 不自研 subagent runtime |
| **model-profile** | **已收录** | 社区单包无法一次满足 6 点 | 短列表 model+thinking；session restore；全局；startup/`new`；热键；status | **本仓薄封装**；模式来自 preset / presets-plus / startup-picker | 不重写全量选择器；官方 `/model` 仍改全局默认（pi 核心） |
| pi-provider-sync (skill) | 已收录 | 自定义 provider 模型易过期 | `/models` 同步与字段补全 | skill 而非 extension | 不在 skill 里藏密钥 |

### 4.1 社区对照（模型相关，避免重复建设）

| 社区包 | 本仓态度 |
|--------|----------|
| `pi-model-picker` / `pi-model-cycler` | **不收录**；长列表用官方 `/model` |
| `@sherif-fanous/pi-presets-plus` | **不 vendoring**；若用户要 tools+prompt 工作流可自行 `pi install`；与 model-profile 目标不同 |
| `pi-startup-picker` | **不强制依赖**；启动短列表由 model-profile 自做（同源配置） |
| `pi-session-model` | 语义参考；功能并入 model-profile 的 session scope |
| `pi-model-router` | 不同需求（自动路由）；本仓暂不收录 |

### 4.2 新增插件登记模板（复制到表中）

```markdown
| name | 计划/已收录 | 为何不用社区 X | 用户问题一句话 | 本仓实现 or 包装 | 联动 statusline? |
```

---

## 5. 路线图条目：model-profile

| 项 | 内容 |
|----|------|
| 计划 | [docs/plans/2026-07-20-model-profile-plan.md](./plans/2026-07-20-model-profile-plan.md) |
| 用户动机 | 多 provider 列表过长；常用 3–5 个；要绑定 thinking；输入中可切；会话/全局；启动可选 |
| 策略 | 薄插件 + 官方 API；CRUD 用原生 `select/input/confirm`，启动列表薄包装 `SelectList`；不重写全量 model TUI |
| 调用 | `/profile` 管理/快速应用、`list/status/startup`、`<id> [session\|global]`、hotkey、冷启动 |
| 配置 | `terrific.json` → `modelProfile` |
| 联动 | 默认无；statusline 已有 model 行足够；global 写 `settings.json` 三默认字段 |
| 配置 | `~/.pi/agent/terrific.json` → `modelProfile`（与 mode/fast/auxiliary 等同文件） |
| 联动 | session snapshot/restore settings 三默认字段；官方 `/model`/cycle/thinking 弹出 defaults-updated 警告 |
| 状态 | **已交付** |

---

## 6. 运维与迁移能力

| 能力 | 怎么调用 | 说明 |
|------|----------|------|
| 采集快照 | `./scripts/snapshot.sh` | 白名单 agent 文件 + skills 源；密钥消毒 |
| 打离线包 | `./scripts/pack.sh` | allowlist 打包；manifest 含 workflows；成功后默认保留最新 5 个 |
| 安装/迁移 | `./install.sh` 或 `FORCE=1 RESTORE=1 ./install.sh` | 合并 packages；RESTORE 覆盖快照；auth 只 seed 空 key |
| 开发引用 | settings `packages` 相对路径 `../vendor/terrific-pi/extensions/...` | 相对 `~/.pi/agent` |

---

## 7. 维护约定

1. **改能力先改本文件**：命令名、配置键、跨插件/workflow 约定变更必须同步。
2. **新插件必须写决策账本行**：为何新建、是否基于社区、非目标。  
3. **README 插件表保持一句话**；目录治理看 `AGENTS.md`，历史理由看 `SESSION_LESSONS.md`。
4. **禁止**把真实 `auth.json`、原始 session、subagent 运行态或本机私密路径写入仓库/归档。

---

## 8. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-20 | 初版：结构、能力表、协作矩阵、决策账本；登记 model-profile 计划 |
| 2026-07-20 | model-profile P0 落地：`/profile` session apply + 热键 + 单测 |
| 2026-07-20 | model-profile P1：global settings 写入 + 冷启动短列表 + `/profile startup` |
| 2026-07-20 | model-profile review 全修 + status key |
| 2026-07-20 | slash 交互首批：Process 管理器、Profile 全局 CRUD、Context 动作分离、共享配置安全与语义修复 |
| 2026-07-20 | slash 交互后续：Aux/Docsflow 管理器补全、轻量命令 `status`/`config`、Process 默认模式、Profile 项目覆盖与 Statusline 条件菜单 |
| 2026-07-22 | presentation 使用受控 native render compatibility layer 恢复用户边框、Bash 三态、Skill/探索与请求级文件回执；移除外部 renderer fork 依赖 |
| 2026-07-22 | 正式定义个性化 Pi enhancement monorepo；补目录/workflow 边界、历史 session 契约与 dist 保留策略 |
| 2026-07-22 | Pilot Phase 0：登记双激活、input routing 与 Auxiliary `pilot_router` bridge；未启用 settings 或 legacy cutover |
| 2026-07-22 | `process-view` 更名为 `taskboard`：canonical package/path/command/config/status key 均迁移；Taskboard `0.2.0` 移除重复 `/process` 命令，长期保留 `process_update`、历史 session entry 和旧配置/status 的只读迁移兼容 |
