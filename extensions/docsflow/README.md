# docsflow

项目文档流水线：`pi-subagents` 执行 + 可选 Obsidian 落盘。

## 输出位置（重要）

| `docsflow.vaultEnabled` | 产物目录 |
|---|---|
| **`false`（默认）** | session 工作目录下：`./docsflow/` |
| `true` | Obsidian vault：`<vaultRoot>/<projectBase>/<project>/docsflow/` |

安装/启动后会 **显式提醒** 当前模式（可用 slash 关闭）。默认关闭 vault，避免静默写库。

### 配置

`~/.pi/agent/terrific.json`：

```json
{
  "docsflow": {
    "vaultEnabled": false,
    "configReminder": true,
    "vaultRoot": "/mnt/g/Mindriver",
    "projectBase": "2_Career/01-INDIE/开发",
    "stageOverrides": {
      "research": {
        "model": "openai/gpt-5.6-sol",
        "thinking": "high",
        "timeoutMs": 900000
      }
    }
  }
}
```

环境变量：

```bash
DOCSFLOW_VAULT_ENABLED=true
DOCSFLOW_VAULT=/mnt/g/Mindriver
DOCSFLOW_CONFIG_REMINDER=off
```

### 目录结构（两种模式内部一致）

```text
docsflow/
  00_Research.md
  01_Product_Spec.md
  02_Interface_Spec.md
  03_Engineering_Handoff.md
  *.draft.md
```

- 本地默认：`<cwd>/docsflow/...`
- vault 开启：`G:\Mindriver\2_Career\01-INDIE\开发\<project>\docsflow\...`

## 命令

```text
/docsflow                              TUI manager: status, wizard, retry, drafts, reset, settings
/docsflow start [--project slug] <requirement>
/docsflow resume
/docsflow status
/docsflow reset
/docsflow apply-drafts
/docsflow settings
/docsflow remind on|off
```

`/docsflow settings` 在 TUI 中编辑本地/vault、提醒与每个阶段的 model/thinking/timeout 覆盖；模型必须是当前可用的 text model，thinking 也会按该模型能力校验，包括单字段 reset 后的最终组合。`projectBase` 必须是 `vaultRoot` 内的相对路径。`/docsflow remind off` 关闭 session 启动与 `/docsflow start` 的配置提醒，写入 `terrific.json` 的 `docsflow.configReminder`。

## 流水线

```text
research → product → interface → delivery → ready
```

Hermes/外部评审为可选附加，不阻断。只有 agent contract 返回 `completed` 才推进阶段；`blocked`、`needs_input`、`failed` 保留当前阶段，`/docsflow resume` 会重试而不会跳过。

## 安装

```json
"packages": [
  "git:github.com/nicobailon/pi-subagents@bd32df2cc1a951b588f6f93f67f3b9adac406303",
  "../vendor/terrific-pi/extensions/docsflow"
]
```

```bash
npm test
```
