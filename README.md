# terrific-pi

`terrific-pi` 是个性化 [pi](https://pi.dev) 增强组件 monorepo：统一维护独立插件、package 内 agents/chains、可迁移 skills、agent 配置、跨包 workflows、无密钥快照与离线发布物。它不是必须整体加载的 runtime；每个 package 都可以独立安装、启用和发布。

## 目录结构

```
terrific-pi/
├── extensions/          # pi packages / extensions（一插件一目录）
│   ├── appearance/      # terrific-night theme、header、editor 与 shortcuts
│   ├── statusline/      # 可配置底栏
│   ├── fast/            # OpenAI Priority processing (/fast)
│   ├── context/         # /context 上下文占用
│   ├── auxiliary/       # task-scoped 辅助模型 runtime
│   ├── mode/            # /mode 工具权限模式
│   ├── pilot/           # 手动人机共驾 Copilot（/pilot）
│   ├── btw/             # /btw 旁路问答
│   ├── taskboard/       # 结构化任务里程碑与等待/阻塞 HUD
│   ├── presentation/    # 受控原生渲染、系统条与文件变更回执
│   ├── docsflow/        # 项目文档流水线 (/docsflow)
│   └── model-profile/   # 常用 model+thinking 短列表 (/profile)
├── skills/              # Agent skills（安装到 ~/.agents/skills）
│   └── pi-provider-sync # 自定义 provider /models 同步与 vision 字段补全
├── snapshot/            # 可迁移本机配置快照（无密钥）
│   └── agent/           # -> ~/.pi/agent/
├── agent/               # 可公开 agent 配置模板与外部 package 清单
├── workflows/           # 跨 package workflow 契约与配方
├── docs/                # 能力地图、历史复盘与已批准设计
├── scripts/
│   ├── snapshot.sh      # 从本机采集 snapshot + 刷新 skills 源
│   ├── pack.sh          # allowlist 打包 + 成功后保留最新 5 个
│   ├── install.sh       # 离线安装 / 合并 packages / 还原技能与快照
│   └── test-install.sh  # 归档与安装冒烟
└── dist/                # 可再生成的 pack 产出（gitignore）
```

## Monorepo 边界

- 根仓统一 Git、治理、迁移与离线发布；`extensions/<name>` 仍是独立可安装、可测试、可独立启用的 pi package。
- 每个 package 只拥有自己的运行事实和 UI 表面；兼容 package 通过 Pi 公共 API、status key 和 `terrific.json` 的显式契约组合，不存在根级隐式 runtime。
- 单包解决单一问题；组合启用可获得更完整体验。例如，`appearance` 提供当前可用的 `terrific-night` theme、header、editor 与 shortcuts；`statusline`、`taskboard`、`presentation` 分别保留自己的 footer、任务 HUD 和 transcript surface。它们可独立安装，任何一个 package 都不是其他 package 的安装前提。
- 单个 package 自有的 `agents/`、`chains/`、`skills/` 留在包内并由 manifest 暴露；根 `workflows/` 只放跨 package 编排。
- `agent/` 是公开模板，`snapshot/agent/` 是经消毒的迁移 payload，live `~/.pi/agent` 与 sessions 不属于仓库。
- 根 `workflows/` 不会因存在于仓库而被 Pi 自动发现，加载入口见 [`workflows/README.md`](./workflows/README.md)。

## 已收录插件

| 插件 | 路径 | 说明 |
|------|------|------|
| appearance | `extensions/appearance` | `terrific-night` theme 与 opt-in `terrific-native-v1` 公共 UI shell：startup header、保留原生输入模型的 editor、动态 shortcuts；不接管 footer、transcript 或 status |
| statusline | `extensions/statusline` | 可配置底栏：single/stacked/terrific HUD、minimal profile、emoji/plain、原生 OAuth quota、token/cache/cost、git、运行状态；`/statusline` 仅在相关 widget 启用时显示 Context & usage |
| fast | `extensions/fast` | `/fast [on\|off\|toggle\|status]` 全局开关 OpenAI Priority processing（`service_tier=priority`）；仅 **GPT 模型** + openai 家族 Responses 生效，切走/非 GPT 自动退让；badge 跟生效态 |
| context | `extensions/context` | `/context [summary\|details\|config]` 上下文占用拆解；`c` 复制，`x` 确认后压缩 session |
| auxiliary | `extensions/auxiliary` | task-key 辅助模型 runtime：裸 `/aux` 管理器、`/aux status`、compression/title/summary/web research/Git finalize、独立 usage 与 HUD |
| mode | `extensions/mode` | `/mode ask\|plan\|edit\|auto\|config` 工具权限模式与全局默认管理；status key `mode` |
| pilot | `extensions/pilot` | 手动 `/pilot` 接管：完整 plan + exact-digest Work Gate、trusted clean-Git `primary-solo`、Pilot 自有 one-shot policy + child write-root guard、package lifecycle-script 验证、actual-diff fresh review、acceptance evidence 与 terminal receipt；失败回到人类，不自动修复/提交 |
| btw | `extensions/btw` | `/btw` 旁路问答（独立内存 session，不写主会话）；`status`/`config` 与单次 `context=none` |
| taskboard | `extensions/taskboard` | `process_update` 结构化任务里程碑、步骤计时、等待/阻塞与验证；`/taskboard` 管理视图、展开、确认清除与新会话默认模式 |
| presentation | `extensions/presentation` | 受控 native render compatibility、用户边框、运行中探索/Skill 身份、单一安全失败行、请求级文件回执与最终答案契约；`/presentation` 管理开关 |
| docsflow | `extensions/docsflow` | 项目文档流水线：research→product→interface→delivery；裸命令管理器、阶段 model/thinking/timeout 覆盖；默认写 `./docsflow/`，可选 Obsidian vault |
| model-profile | `extensions/model-profile` | 常用 3–5 套 model+thinking 短列表；`/profile` 快速应用、全局 CRUD、可信项目覆盖编辑、热键、冷启动短列表 |

> 共享插件配置主文件：`~/.pi/agent/terrific.json`。Taskboard `0.2.0` 只注册 `/taskboard`；`process_update` 与历史 session types 保持稳定，旧 `processView` 配置和 `process` status 仍只读兼容，并在下一次 `/taskboard default <mode>` 时原子迁移。Auxiliary 模型路由只读取 global config，不接受 project override。Pilot 已加入开发机/离线 packages，但启动后保持 inactive，只有显式 `/pilot` 才接管；其 constrained preflight/Worker guard 由 Pilot 自身实现，固定 `pi-subagents` pin 只承载公开 V1 前台请求；standalone mode 与 docsflow 保持独立。

## 已收录技能

| 技能 | 路径 | 安装到 | 说明 |
|------|------|--------|------|
| pi-provider-sync | `skills/pi-provider-sync` | `~/.agents/skills/pi-provider-sync` | 从 OpenAI-compatible 或 Anthropic Messages `/models` 同步 `models.json`；补全 `input`/`reasoning`/`maxTokens`/`cost` 等；支持 vision 修复 |

## 安装与迁移

### A. 源机器：刷新快照并打包

```bash
cd ~/.pi/vendor/terrific-pi   # 或本仓库路径
./scripts/snapshot.sh         # 采集 ~/.pi/agent 白名单文件 + 刷新 skills/
./scripts/pack.sh
# -> dist/terrific-pi-<utc>-<sha>.tar.gz
```

`MANIFEST.txt` 记录 `git_sha`、packages、skills、workflows 与 snapshot；若打包时工作树尚有未提交修改，也会标记 `git_dirty=true`。

成功打包后默认只保留同一输出目录最新 5 个 `terrific-pi-*.tar.gz`。可用 `DIST_KEEP=N` 调整，或用 `DIST_KEEP=0` 单次禁用清理；无关文件不会被删除。

把 `dist/terrific-pi-*.tar.gz` 拷到目标机器。

### B. 目标机器：一比一还原（推荐迁移）

```bash
tar -xzf terrific-pi-*.tar.gz
cd terrific-pi-*/
FORCE=1 RESTORE=1 ./install.sh
# 或：FORCE=1 RESTORE=1 ./scripts/install.sh /path/to/archive.tar.gz
```

效果：
- 安装/覆盖 `~/.pi/vendor/terrific-pi`
- 同步技能到 `~/.agents/skills/<name>`
- 用 `snapshot/agent/*` **覆盖**写入 `~/.pi/agent/`（models/settings/statusline/AGENTS、`terrific.json` 等无密钥配置）
- 生成/合并 `~/.pi/agent/auth.json`：**只带 provider 结构，key 为空**（已有非空 key 绝不会被覆盖）

迁移后只需：
1. 编辑 `~/.pi/agent/auth.json`，把各 provider 的 `key` 填上
2. 若 settings 含其他 `npm:` / `git:` 包，首次启动仍可能需要联网拉取；presentation 本身不依赖外部 renderer fork
3. 直接启动 pi（必要时 `/model` 确认模型）

### C. 目标机器：温和安装（不覆盖已有 agent 配置）

```bash
./install.sh
# 或 FORCE=1 ./install.sh  # 仅强制替换 vendor 树
```

- packages：合并进 `settings.json`（保留无关 npm:/git:，并清理已废弃的 renderer fork pin）
- skills：始终从包同步
- snapshot agent 文件：仅 seed 缺失项

环境变量：

| 变量 | 默认 | 含义 |
|------|------|------|
| `PI_HOME` | `~/.pi` | pi 根目录 |
| `AGENTS_SKILLS_DIR` | `~/.agents/skills` | 技能安装根 |
| `FORCE=1` | off | 替换 `vendor/terrific-pi` |
| `RESTORE=1` | off | 1:1 覆盖 agent 快照文件 |

### D. 开发机相对路径

以下是开发机组合示例，不是默认加载清单。除各包 README 明确声明的依赖和加载顺序外，`extensions/*` 均可独立选择；实际启用项以目标机 `settings.json` 为准。

```bash
# settings.json packages（相对 ~/.pi/agent）
"git:github.com/nicobailon/pi-subagents@bd32df2cc1a951b588f6f93f67f3b9adac406303" # detached runner TypeBox 修复
"npm:pi-web-access@0.13.0"        # 可选：固定 web tools
"../vendor/terrific-pi/extensions/statusline"
"../vendor/terrific-pi/extensions/fast"
"../vendor/terrific-pi/extensions/context"
"../vendor/terrific-pi/extensions/auxiliary"
"../vendor/terrific-pi/extensions/mode"
"../vendor/terrific-pi/extensions/pilot"
"../vendor/terrific-pi/extensions/btw"
"../vendor/terrific-pi/extensions/taskboard"
"../vendor/terrific-pi/extensions/presentation"
"../vendor/terrific-pi/extensions/appearance"
"../vendor/terrific-pi/extensions/docsflow"
"../vendor/terrific-pi/extensions/model-profile"
```

## Terrific native v1（opt-in）

[`agent/settings.packages.example.json`](./agent/settings.packages.example.json)、[`agent/terrific.example.json`](./agent/terrific.example.json) 与 [`agent/statusline.example.json`](./agent/statusline.example.json) 是 Pi 0.81.1 的 opt-in 组合示例：选择 `terrific-night`，设置 `editorPaddingX: 1`、`outputPad: 1`，并以 `appearance.profile: "terrific-native-v1"` + `layout: "terrific"` + `iconMode: "plain"` 激活结构视觉。示例不会自动写入 live `~/.pi`；共享 snapshot 也保持现状，等待人工视觉验收与 rollout 授权。

加载与 owner 契约：

- `taskboard` 必须排在 `presentation` 前；两者分别拥有 `terrific-pi:taskboard` HUD 和仅有的 user/tool prototype patches，避免同一过程事实重复展示。
- `appearance` 与 `statusline` 顺序无关，但启用前必须审计 setter 冲突：只有 appearance 可调用 `setHeader`/`setEditorComponent`，只有 statusline 可调用 `setFooter`。发现未知 owner 即阻塞 rollout。
- `pi-vision-handoff@0.8.1` 的可选 paste-time `PrewarmEditor` 与 `TerrificEditor` 竞争同一 slot，因此不在 native profile example 中。完整 Terrific profile 选择 appearance；要保留该 prewarm editor 时应保持 profile off。应用 live rollout 前必须从 proposed settings 移除其中一个并让 `AUDIT_UI_OWNERS_SETTINGS=<proposed-settings> ./scripts/audit-ui-owners.sh` 通过。
- appearance 只拥有 theme/header/editor/shortcuts；statusline 只拥有 footer/turn status；Pi core 继续拥有 assistant、thinking、内建 dialog 和 terminal lifecycle。
- appearance、presentation、statusline、taskboard、mode、btw 的 profile parser 只读 `$PI_CODING_AGENT_DIR/terrific.json`，不接受 project-local override；配置错误 fail closed，只有 appearance 发一次提示。

回滚无需迁移 session：从 packages 移除 appearance（或把 profile 设为 `off`），theme 切回原值，statusline layout 切回 `single`/`stacked`，还原 editor/output padding后执行 `/reload` 或重启 Pi。

人工终端验收清单：

1. 在 Windows Terminal 与 VS Code terminal 分别检查 80x24、120x40、160x50；确认 truecolor 和 256-color 下文字、边界、状态 glyph 可辨且不溢出。
2. 验证 editor 输入、多行、粘贴、历史、补全与动态 shortcuts，窗口缩窄/降低时仍可输入和取消。
3. 执行 `/reload`、一次 `Ctrl+O` 展开/折叠，并检查退出后 cursor、paste 与 terminal input 正常。
4. 有可用模型时人工覆盖 working/error/edit/blocked/BTW 真实流程；离线 package pure-render tests 是自动化布局真源，不能替代交互手感验收。

## 安全约定

- **禁止**提交真实密钥：只允许 `snapshot/agent/auth.template.json`（空 key 结构）
- 不提交 token、session 日志等敏感内容
- `snapshot/` 与 `agent/` 仅放可公开/可迁移的非密钥文件
- 目标机真实密钥只写在本机 `~/.pi/agent/auth.json`
- 详情见 [`snapshot/README.md`](./snapshot/README.md)

## 能力全景与插件决策

- 全盘能力、调用入口、协作关系、插件「为何新建」账本：[`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md)
- 62 个顶层 session 的历史复盘、踩坑和长期契约：[`docs/SESSION_LESSONS.md`](./docs/SESSION_LESSONS.md)
- 跨 package workflow 归属与加载边界：[`workflows/README.md`](./workflows/README.md)
- 单特性设计/实施计划：[`docs/plans/`](./docs/plans/)

## 开发约定

完整规范见根目录 [`AGENTS.md`](./AGENTS.md)（开发前检索、插件结构、技能/快照、提交、离线打包）。

- 文本文件统一使用 `LF` 换行
- 每个 extension 保持独立可安装的 pi package 结构（含 `package.json` 与 `pi.extensions`）
- 新增插件放在 `extensions/<name>/`，并在本 README 表格中登记
- 新增可迁移技能放在 `skills/<name>/`（含 `SKILL.md`），并在本 README 技能表登记
- **开发前**先扫官方文档与社区实现，避免重复造轮子
