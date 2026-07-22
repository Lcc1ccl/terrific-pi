# Workflows

本目录保存 terrific-pi monorepo 的**跨 package 工作流契约与可迁移配方**。

## 归属边界

放在这里：

- 协调两个及以上 extension、skill 或 agent 的流程；
- 不属于单一 package，但需要随仓库与离线包迁移的编排；
- 人类 control plane 可独立审阅、启停和回滚的 workflow 规格。

不要放在这里：

- 单个 extension 私有的 agent、chain 或 skill，它们留在 `extensions/<name>/{agents,chains,skills}/` 并由该包 manifest 声明；
- session JSONL、subagent run artifact、worktree、日志或临时输出；
- 仅供某次实现使用的计划，放在 `docs/plans/`。

## 加载规则

根 `workflows/` 是版本化源码目录，**仅存在于此不会被 Pi 自动发现**。可执行 chain 必须满足其一：

1. 由所属 pi package 的 manifest 暴露；
2. 明确安装到 Pi/subagent 支持的 user 或 project chain 目录；
3. 通过已有 extension 或脚本显式加载。

不得依赖隐式扫描或本机私有绝对路径。

## Workflow 最小契约

每个 workflow 至少说明：

- owner、触发入口与适用范围；
- 输入、阶段、产物和状态机；
- 工具权限、文件写入和外部副作用；
- model/fallback 规则及配置来源；
- HUD/presentation 所有权，避免重复展示；
- acceptance、失败恢复、取消与人工确认点；
- 最小验证命令或可重复的手工验收步骤。

优先使用现有 `pi-subagents` agent/chain 能力和本仓 extension API；不要在本目录自建第二套编排 runtime。
