# Docs Flow（基于 pi-subagents）实施方案

## 结论

- **不做**独立 Sidecar Runtime，**不扩展** `auxiliary` 为多轮 agent 框架。
- **执行层**：pin `npm:pi-subagents@0.35.1`。
- **领域层**：`extensions/docs-flow` = Profile Pack +（后续）薄状态机 / Gate / 落盘。
- **文件是真相**：正式文档在项目 `docs/`；流程状态在 `.pi/docs-flow/state.json`；Hermes 只走 review 文件。

## 为何改写原 Sidecar 计划

| 原计划 | 现状 | 决策 |
|---|---|---|
| 自研 Sidecar Runtime | `pi-subagents` 已有 profile/tools/resume/chain/structured_output | 复用，不重写 |
| 塞进 auxiliary | auxiliary 是 one-shot 任务路由，明确排除 universal agent API | 正交保留 |
| `/sidecar` 为中心 | slot UX 可后补 | 首版以 `/docs-flow` + subagent 为主 |

## 阶段

### P0 — Profile Pack ✅

- 4 个只读 agent frontmatter
- 共享 `project-docs` skill + 4 模板
- Artifact Contract JSON Schema
- 模型解析报告（禁止静默降级）
- 静态测试（frontmatter / tools / allowlist / path 规则）

### P1 — 薄 docs-flow extension ✅

- `/docs-flow start|resume|status|reset|apply-drafts`
- state.json 状态机 + Hermes 文件 Gate
- 校验 structured output → 写 `docs/**`（正式存在则 `.draft.md`）
- statusline/process-view 阶段 HUD
- 主会话只回注摘要与路径

### P2 — 真实项目试点

### P3 — 有证据再加

- `/sidecar <slot>` 糖衣（map → runId）
- 并行只读 research、第三 Gate、worktree

## 权限

- 子 agent：`read, grep, find, ls` only
- 无 `write/edit/bash/subagent`
- 落盘仅父扩展（P1）；P0 先用 structured_output contract 约束形状

## 跨插件联动

| 触点 | 结论 |
|---|---|
| statusline / process-view | P1 加 docs-flow 阶段 key |
| mode | apply-drafts 需确认；子 agent 只读 |
| fast | 不继承 |
| btw / auxiliary | 无联动 |
| context | 主会话不注入完整 transcript |

## 非目标

- 第二套 runtime
- Hermes API 直连
- 子 agent 自批 Gate
- 首版并行写 `/docs`
- 强制十份空壳文档
