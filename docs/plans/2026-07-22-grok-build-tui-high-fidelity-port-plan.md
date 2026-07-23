# Grok Build TUI 高保真 pager 移植计划（已废止）

> 日期：2026-07-22
>
> 状态：**Superseded，不得作为实施输入**
>
> 废止原因：用户明确选择路线 B，即基于原生 Pi TUI 的 theme/public API，并只扩展现有 `presentation` 受控私有补丁；不采用 Rust/Ratatui pager、RPC frontend 或 Pi host fork。

现行开发计划：

- [Grok 风格原生 Pi TUI 并行开发计划](./2026-07-22-grok-style-native-pi-tui-development-plan.md)

研究与五路线能力边界仍保留在：

- [Grok Build TUI 与 Pi 0.81.1 高保真复刻对比报告](./2026-07-22-grok-build-tui-comparison-report.md)

本文件原先描述的 Phase 0-10、`terrific-tui` standalone repo、Pi RPC adapter、SessionSupervisor、Dashboard 和 pager release 均已取消。若未来重新评估 pager 路线，必须基于新的用户决策另建计划，不得恢复执行本文件的历史内容。
