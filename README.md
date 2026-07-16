# terrific-pi

个性化 [pi](https://pi.dev) agent 配置仓库：插件（extensions）、工作流（workflows）与 agent 配置模板。

## 目录结构

```
terrific-pi/
├── extensions/          # pi packages / extensions
│   └── statusline/      # pi 可配置 statusline（首个插件）
├── workflows/           # 工作流与自动化（待补充）
└── agent/               # agent 配置模板（勿提交密钥）
```

## 已收录插件

| 插件 | 路径 | 说明 |
|------|------|------|
| statusline | `extensions/statusline` | pi 可配置底栏：路径、session、模型、token/cache/cost、context bar、git、运行状态；支持 `/statusline` 交互配置 |

### 安装 statusline

```bash
# 本地路径
pi install /path/to/terrific-pi/extensions/statusline

# 或从 git 安装该子目录包
pi install git:https://github.com/Lcc1ccl/terrific-pi.git
# 若 pi 需要子路径，按你本机 pi 版本文档指定 package 子目录
```

本地已安装路径示例：`~/.pi/extensions/statusline`。

## 安全约定

- **禁止**提交 `auth.json`、token、API key、session 日志等敏感内容
- `agent/` 仅放可公开的模板（如 AGENTS.md 骨架、settings 示例）
- 私密配置继续保留在本机 `~/.pi/agent/`

## 开发约定

- 文本文件统一使用 `LF` 换行
- 每个 extension 保持独立可安装的 pi package 结构（含 `package.json` 与 `pi.extensions`）
- 新增插件放在 `extensions/<name>/`，并在本 README 表格中登记
