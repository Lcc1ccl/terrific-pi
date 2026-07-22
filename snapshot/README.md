# Snapshot

本目录是 **可迁移的本机配置快照**（无密钥），由 `scripts/snapshot.sh` 从当前机器采集，经 `scripts/pack.sh` 打进离线包，再由 `install.sh` 在目标机还原。

## 布局

```text
snapshot/
├── README.md
└── agent/                 # -> ~/.pi/agent/
    ├── models.json
    ├── settings.json
    ├── statusline.json
    ├── terrific.json
    ├── AGENTS.md
    └── extensions/
        ├── pi-tool-display/config.json
        └── pi-compact-transcript/config.json
```

配套技能在仓库根 `skills/`（安装到 `~/.agents/skills/`），不放在本目录。

## 包含 / 不包含

| 包含 | 不包含（刻意） |
|------|----------------|
| `models.json`（无 apiKey） | 真实 `auth.json` 密钥 |
| `settings.json` | `sessions/` |
| `statusline.json`、`terrific.json` | `models-store.json`（pi 运行时刷新） |
| `extensions/pi-tool-display/config.json`、`extensions/pi-compact-transcript/config.json` | `trust.json`（路径/机器相关） |
| `AGENTS.md` | `sessions/` |
| `auth.template.json`（provider 结构 + **空 key**） | `*.bak*`、日志、真实 token |

迁移模型：**一键还原全部非密钥配置** → 目标机只打开 `~/.pi/agent/auth.json` 填 key → 直接投用。
不依赖 `/login`。

## 刷新快照（源机器）

```bash
./scripts/snapshot.sh
# 可选：只采 agent / 只同步 skills 源
# SNAPSHOT_ONLY=agent ./scripts/snapshot.sh
# SNAPSHOT_ONLY=skills ./scripts/snapshot.sh
```

默认从：
- `~/.pi/agent/` 采集白名单文件（nested renderer config 保留相对目录；机器绝对 `docsflow.vaultRoot` 会被移除，`AGENTS.md` 中 `/home/<user>`/`/Users/<user>` 会改写为 `~`）
- `~/.agents/skills/<name>/` 同步到仓库 `skills/<name>/`（仅已在 `skills/` 登记的名称）

## 还原（目标机器）

```bash
# 完整迁移：覆盖 vendor + skills + agent 快照
FORCE=1 RESTORE=1 ./install.sh
# 或从归档：
FORCE=1 RESTORE=1 ./scripts/install.sh terrific-pi-*.tar.gz
```

| 环境变量 | 含义 |
|----------|------|
| `RESTORE=1` | 用 `snapshot/agent/*` **覆盖**写入 `~/.pi/agent/`（除密钥外） |
| 默认（无 RESTORE） | 仅 seed 缺失的 agent 模板/快照文件，不覆盖已有 |
| `FORCE=1` | 替换 `~/.pi/vendor/terrific-pi` 树 |
| `AGENTS_SKILLS_DIR` | skills 安装根，默认 `~/.agents/skills` |

skills **始终**从包内 `skills/` 同步到本机（与 RESTORE 无关），保证迁移后技能一致。

### auth 处理

- 包内只有 `auth.template.json`（空 key）
- 安装时写入/合并为 `~/.pi/agent/auth.json`
- **已有非空 key 永不覆盖**
- 缺失 provider 会补结构；新机得到完整空壳 auth.json

## 迁移后手工作业（仅此）

1. 编辑 `~/.pi/agent/auth.json`，填写各 provider 的 `key`
2. 若 `settings.json` 含 `npm:` / `git:` 包，首次启动需联网拉取；当前两个 renderer fork 为 private GitHub repo，目标机还需 GitHub SSH 访问
3. 启动 pi 即可；需要时 `/model` 确认模型
