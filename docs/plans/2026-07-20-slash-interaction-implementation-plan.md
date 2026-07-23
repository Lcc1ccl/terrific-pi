# Slash 交互改造实施计划

> 日期：2026-07-20
>
> 状态：Phase 0–6 代码与自动化验证已完成；真机 TUI 手动验收待执行
> 范围：terrific-pi 仓库内 9 个 extension 的 slash 交互与共享配置写入语义

## 1. 目标

把 slash 命令从单纯的“触发器”补齐为两类稳定入口：

1. 多域插件使用管理器：`/statusline`、`/process`、`/profile`、`/docsflow`、`/aux`
2. 单动作插件保留直接入口，并增加 `status` / `config` 子命令：`/btw`、`/context`、`/fast`、`/mode`

所有改造遵循以下契约：

- TUI 中显示当前值、有效值、默认值、配置路径和作用域
- 修改立即应用；保留现有参数直达和补全
- 非 TUI 模式退化为文本状态或明确 usage
- 继承配置提供 `Reset override`
- destructive 操作确认
- 共享 `terrific.json` 写入拒绝覆盖坏 JSON，保留兄弟段，并使用临时文件原子替换

## 2. 边界

- 不把 `/profile` 扩成第二个全量 `/model`
- 不允许手工编辑 Taskboard 的模型进度、状态和 usage
- 不在 `/mode` 中实现任意工具集编辑器
- 不为 `/fast` 的单一布尔配置建立多层 TUI
- 不建立跨 package 的公共运行时依赖；各 extension 必须继续可独立安装
- Phase 6 不修改 pi 上游、不补丁 `node_modules`、不等待宿主版本提供循环选择
- 不修改用户现有未提交改动的无关部分

## 3. Phase 0：语义与写入安全（已完成）

### 3.1 Docsflow 状态正确性

- 只有 contract `completed` 才加入 `completedStages`
- `blocked`、`needs_input`、`failed` 保留当前阶段供 retry/resume
- 损坏的 `terrific.json` 必须拒绝写入，不得从空对象覆盖
- 写入使用临时文件 + rename，并保留兄弟配置段

验收：回归测试证明 blocked/failed 不会被 resume 跳过；坏 JSON 原字节不变。

### 3.2 Fast 有效态一致性

- API 未知时不静默注入 Priority
- badge/effective/injection 使用同一判定
- 后续增加 `/fast status`

验收：未知 API 时既无 badge，也无 payload 注入。

### 3.3 Auxiliary 任务能力矩阵

- BTW 不显示无效的 retries
- Web Research 不显示无效的 retries / maxOutputTokens
- Git policy 和整段 reset 留到 Phase 3

验收：菜单测试只出现任务真实消费的字段。

### 3.4 Context 动作语义

- Copy 快捷键保持一致
- Compact 改为独立显式动作并继续确认
- 文档不再宣称绝对“no session writes”

## 4. Phase 1：Taskboard 管理器（已完成）

无参数 `/process` 在 TUI 打开浅层管理器：

- 当前任务摘要
- View mode：`compact` / `full` / `off`
- 临时 Expand / Collapse live panel
- Clear current task，带确认
- Done

保留：

- `/process compact|full|off`
- `/process clear`
- 非 TUI `/process` 文本摘要

不做：步骤编辑、状态伪造、usage 重置、历史任务数据库。

验收：命令测试覆盖菜单分支、即时渲染、确认取消和 direct args。

## 5. Phase 2：Model Profile 管理器（已完成）

无参数 `/profile` 在 TUI 打开管理器：

- Quick apply：选择 profile 后 session/global apply
- Add from current：捕获当前 model + thinking
- Edit profile：alias、label、model、thinking、hotkey
- Delete profile：确认后删除
- Startup settings：enabled、startupScope
- Show effective config
- Done

写入要求：

- `modelProfile` patch 支持 `profiles`、`startup`、`startupScope`、`openHotkey`
- 保留 `terrific.json` 其他顶层段
- 坏 JSON 拒绝覆盖
- hotkey 修改后明确提示 `/reload`，不假装动态解绑成功

保留：

- `/profile <id|alias> [session|global]`
- `/profile list|status|startup|help`
- profile 仍是 3-5 项短列表

首批只写 global 配置。Project override 编辑需要先补来源追踪，放入 Phase 4。

验收：CRUD 写入、兄弟段保留、坏 JSON、duplicate id/alias/hotkey、Quick apply 均有测试。

## 6. Phase 3：现有管理器补全（已完成）

### Auxiliary

- 无参数 `/aux` 打开管理器，`/aux status` 保留文本输出
- 按任务能力渲染字段
- Git finalize policy：confirm / allowHeadless / allowPush
- Show effective routes、recent errors/usage
- Confirmed reset to defaults
- 用户主动 slash 配置不受 `/mode` 的 model tool 列表限制

### Docsflow

- 上下文主菜单：Status、Start wizard、Resume/Retry、Drafts、Reset、Settings
- Start wizard：requirement、project slug、output preview
- Settings：local/vault、reminder、vaultRoot、projectBase
- 每阶段 model/thinking/timeout override 与可用性校验
- Apply drafts 后避免重复列出旧 draft

## 7. Phase 4：轻量命令补全（已完成）

### Mode

- `/mode config`：default、persistPerSession、Save current as default、Reset
- 显示 effective tools
- 不扩大为任意工具权限编辑器

### Context

- `/context config`：topEntries、global/project scope、Reset override
- `/context summary|details`

### BTW

- `/btw status`：effective route、fallback、timeout、output cap、context budget
- `/btw config`：maxContextTokens，并复用 Auxiliary 的 BTW route 编辑
- 可选单次 `context=none|current`

### Fast

- `/fast status`：preference、effective、current API
- 保留 `/fast on|off|toggle`

## 8. Phase 5：打磨（代码完成；真机 TUI 待验）

- Taskboard 全局 default view mode
- Model Profile project/global 来源追踪与 project override 编辑
- Statusline 仅在相关 widget 启用时展示相关配置项
- 统一 README、CAPABILITIES 和示例
- 真机 TUI 手动验收（待执行）

## 9. Phase 6：菜单循环与低噪音提示（已完成；真机 TUI 待验）

### 9.1 适用范围与交互契约

- 覆盖 `/statusline`、`/process`、`/profile`、`/docsflow`、`/aux`、`/btw config`、`/context config`、`/mode` 及其离散选择子菜单；`/fast` 没有选择菜单，无需改造
- 所有离散选项列表的 ↑/↓ 在首尾循环；文本滚动、输入框、确认框和左右排序不循环
- 顶层 Esc 表示 close/cancel，子菜单 Esc 表示 back；保留 Enter 确认和已有的数字直达、过滤、切换、排序等专用动作

### 9.2 仓内实现

- 每个受影响 package 提供一个包内轻量 `selectMenu` 适配器，基于 pi 已有 `SelectList`；单一调用可内联，多处调用放入本 package 的 `lib/`
- 各 extension 将现有 `ctx.ui.select` 注入点统一路由到本包适配器，覆盖顶层和嵌套菜单；不得建立跨 package 公共依赖
- `/statusline` 移除仅顶层专用的 `selectMain` 分叉并复用本包适配器；Model Profile 数字直达、Auxiliary 模型过滤和 Widgets 编辑器保留专用组件

### 9.3 Tips 层级

- 普通菜单只显示一行 dim footer：实际绑定的 navigate、select、back/cancel 键，不在标题或每个选项重复
- 功能提示只在非显然处出现：当前值、默认值、继承来源、写入作用域、即时生效或需 `/reload`；破坏性后果继续放在确认框
- Auxiliary 过滤器补全过滤/导航/确认/返回提示；Statusline 预填输入补 `submit/cancel`；Context/BTW 仅在内容溢出时显示滚动提示；`j/k/q` 等冗余别名不常驻展示

### 9.4 自动化与真机验收

- 包内组件测试必须证明首项按上到末项、末项按下到首项、空列表安全，以及 Enter/Esc 语义正确
- 专用组件测试覆盖动态 keybinding 文案、数字直达、过滤、Widgets 循环和条件滚动提示；不为每个业务菜单复制同一套行为测试
- 真机在 `80x24`、`120x40` 和自定义 keybindings 下逐个走查，确认 footer 不重复、不溢出、不遮挡选项，嵌套返回路径一致

验收：所有受影响 package 的测试与 typecheck 通过；仓内离散选择菜单全部循环；每个菜单至多一行通用快捷提示，额外功能提示仅在相关状态出现；无需任何 pi 上游或 `node_modules` 改动。

## 10. 执行顺序与质量门

每个行为变更执行 Red -> Green -> Refactor：

1. 先添加会失败的最小测试
2. 运行目标测试并确认因缺失行为失败
3. 写最小实现
4. 运行插件完整测试
5. 独立 spec review
6. 独立 code-quality review

已交付 Phase 0–6 的实现与包级自动化验证。Phase 3–5 的审查发现已回归修复：Docsflow 继承 profile thinking、拒绝不兼容的阶段 thinking，`/process clear` 的所有入口统一要求确认；配置菜单区分 global 写目标与 project 生效值，Model Profile 项目覆盖保持全局元数据继承，Docsflow 限制 vault 输出与最终 stage model/thinking 组合。Phase 6 以 package-local `SelectList` adapters 取代离散菜单中的 core selector，覆盖循环导航、层级 Esc、动态 keybinding footer，以及 Auxiliary/Model Profile/Statusline 的专用交互；8 个受影响包共 450 项测试、6 个 typecheck 和 2 个入口加载检查通过。仍需在真实 Pi TUI 的 `80x24`、`120x40` 及自定义 keybindings 下统一手动验收。
