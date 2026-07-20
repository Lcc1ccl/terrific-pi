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
    "projectBase": "2_Career/01-INDIE/开发"
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
/docsflow start [--project slug] <requirement>
/docsflow resume
/docsflow status
/docsflow reset
/docsflow apply-drafts
/docsflow remind on|off
```

`/docsflow remind off` 关闭 session 启动与 `/docsflow start` 的配置提醒，写入 `terrific.json` 的 `docsflow.configReminder`。

## 流水线

```text
research → product → interface → delivery → ready
```

Hermes/外部评审为可选附加，不阻断。

## 安装

```json
"packages": [
  "npm:pi-subagents@0.35.1",
  "../vendor/terrific-pi/extensions/docsflow"
]
```

```bash
npm test
```
