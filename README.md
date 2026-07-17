# terrific-pi

个性化 [pi](https://pi.dev) agent 配置仓库：插件（extensions）、工作流（workflows）与 agent 配置模板。

## 目录结构

```
terrific-pi/
├── extensions/          # pi packages / extensions（一插件一目录）
│   ├── statusline/      # 可配置底栏
│   ├── fast/            # OpenAI Priority processing (/fast)
│   ├── context/         # /context 上下文占用
│   ├── mode/            # /mode 工具权限模式
│   └── btw/             # /btw 旁路问答
├── workflows/           # 工作流与自动化（待补充）
└── agent/               # agent 配置模板（勿提交密钥）
```

## 已收录插件

| 插件 | 路径 | 说明 |
|------|------|------|
| statusline | `extensions/statusline` | 可配置底栏：路径、session、模型、token/cache/cost、context bar、git、运行状态；`/statusline` 交互配置 |
| fast | `extensions/fast` | `/fast` 开关 OpenAI Priority processing（`service_tier=priority`）；开启后 footer 显示 `⚡` |
| context | `extensions/context` | `/context` 上下文占用拆解（不调模型、不写 session） |
| mode | `extensions/mode` | `/mode ask\|plan\|edit\|auto` 工具权限模式；status key `pi-essentials-mode` |
| btw | `extensions/btw` | `/btw` 旁路问答（独立内存 session，不写主会话） |

> 原 monorepo 包 `vendor/pi-essentials` 已按插件拆入上表三项。配置文件仍兼容 `~/.pi/agent/pi-essentials.json`。

### 安装

```bash
# settings.json packages（相对 ~/.pi/agent）
"../vendor/terrific-pi/extensions/statusline"
"../vendor/terrific-pi/extensions/fast"
"../vendor/terrific-pi/extensions/context"
"../vendor/terrific-pi/extensions/mode"
"../vendor/terrific-pi/extensions/btw"

# 或
pi install /path/to/terrific-pi/extensions/<name>
```

## 安全约定

- **禁止**提交 `auth.json`、token、API key、session 日志等敏感内容
- `agent/` 仅放可公开的模板（如 AGENTS.md 骨架、settings 示例）
- 私密配置继续保留在本机 `~/.pi/agent/`

## 开发约定

- 文本文件统一使用 `LF` 换行
- 每个 extension 保持独立可安装的 pi package 结构（含 `package.json` 与 `pi.extensions`）
- 新增插件放在 `extensions/<name>/`，并在本 README 表格中登记
