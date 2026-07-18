# terrific-pi

个性化 [pi](https://pi.dev) agent 配置仓库：插件（extensions）、技能（skills）、配置快照（snapshot）与离线迁移包。

## 目录结构

```
terrific-pi/
├── extensions/          # pi packages / extensions（一插件一目录）
│   ├── statusline/      # 可配置底栏
│   ├── fast/            # OpenAI Priority processing (/fast)
│   ├── context/         # /context 上下文占用
│   ├── mode/            # /mode 工具权限模式
│   └── btw/             # /btw 旁路问答
├── skills/              # Agent skills（安装到 ~/.agents/skills）
│   └── pi-provider-sync # 自定义 provider /models 同步与 vision 字段补全
├── snapshot/            # 可迁移本机配置快照（无密钥）
│   └── agent/           # -> ~/.pi/agent/
├── agent/               # 可公开配置模板（勿提交密钥）
├── scripts/
│   ├── snapshot.sh      # 从本机采集 snapshot + 刷新 skills 源
│   ├── pack.sh          # 打离线包（extensions + skills + snapshot）
│   └── install.sh       # 离线安装 / 合并 packages / 还原技能与快照
├── workflows/           # 工作流与自动化（待补充）
└── dist/                # pack 产出（gitignore）
```

## 已收录插件

| 插件 | 路径 | 说明 |
|------|------|------|
| statusline | `extensions/statusline` | 可配置底栏：single/stacked HUD、emoji/plain、原生 OAuth quota、token/cache/cost、git、运行状态；`/statusline` 交互配置 |
| fast | `extensions/fast` | `/fast` 开关 OpenAI Priority processing（`service_tier=priority`）；开启后 footer 显示单列图标 `` |
| context | `extensions/context` | `/context` 上下文占用拆解（不调模型、不写 session） |
| mode | `extensions/mode` | `/mode ask\|plan\|edit\|auto` 工具权限模式；status key `pi-essentials-mode` |
| btw | `extensions/btw` | `/btw` 旁路问答（独立内存 session，不写主会话） |

> 原 monorepo 包 `vendor/pi-essentials` 已按插件拆入上表三项。配置文件仍兼容 `~/.pi/agent/pi-essentials.json`。

## 已收录技能

| 技能 | 路径 | 安装到 | 说明 |
|------|------|--------|------|
| pi-provider-sync | `skills/pi-provider-sync` | `~/.agents/skills/pi-provider-sync` | 从 OpenAI-compatible `/models` 同步 `models.json`；补全 `input`/`reasoning`/`maxTokens` 等；支持 vision 修复 |

## 安装与迁移

### A. 源机器：刷新快照并打包

```bash
cd ~/.pi/vendor/terrific-pi   # 或本仓库路径
./scripts/snapshot.sh         # 采集 ~/.pi/agent 白名单文件 + 刷新 skills/
./scripts/pack.sh
# -> dist/terrific-pi-<utc>-<sha>.tar.gz
```

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
- 用 `snapshot/agent/*` **覆盖**写入 `~/.pi/agent/`（models/settings/statusline/AGENTS 等）
- 生成/合并 `~/.pi/agent/auth.json`：**只带 provider 结构，key 为空**（已有非空 key 绝不会被覆盖）

迁移后只需：
1. 编辑 `~/.pi/agent/auth.json`，把各 provider 的 `key` 填上
2. 若 settings 含 `npm:` / `git:` 包，需联网由 pi 拉取一次
3. 直接启动 pi（必要时 `/model` 确认模型）

### C. 目标机器：温和安装（不覆盖已有 agent 配置）

```bash
./install.sh
# 或 FORCE=1 ./install.sh  # 仅强制替换 vendor 树
```

- packages：合并进 `settings.json`（保留 npm:/git:）
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

```bash
# settings.json packages（相对 ~/.pi/agent）
"../vendor/terrific-pi/extensions/statusline"
"../vendor/terrific-pi/extensions/fast"
"../vendor/terrific-pi/extensions/context"
"../vendor/terrific-pi/extensions/mode"
"../vendor/terrific-pi/extensions/btw"
```

## 安全约定

- **禁止**提交真实密钥：只允许 `snapshot/agent/auth.template.json`（空 key 结构）
- 不提交 token、session 日志等敏感内容
- `snapshot/` 与 `agent/` 仅放可公开/可迁移的非密钥文件
- 目标机真实密钥只写在本机 `~/.pi/agent/auth.json`
- 详情见 [`snapshot/README.md`](./snapshot/README.md)

## 开发约定

完整规范见根目录 [`AGENTS.md`](./AGENTS.md)（开发前检索、插件结构、技能/快照、提交、离线打包）。

- 文本文件统一使用 `LF` 换行
- 每个 extension 保持独立可安装的 pi package 结构（含 `package.json` 与 `pi.extensions`）
- 新增插件放在 `extensions/<name>/`，并在本 README 表格中登记
- 新增可迁移技能放在 `skills/<name>/`（含 `SKILL.md`），并在本 README 技能表登记
- **开发前**先扫官方文档与社区实现，避免重复造轮子
