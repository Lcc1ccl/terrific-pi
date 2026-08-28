# Taskboard 从 rpiv-todo 迁移体验能力的开发需求

日期：2026-08-28

状态：Wave A / Wave B 已完成；Wave C 未触发（缺少真实非线性依赖用例）

来源：`@juicesharp/rpiv-todo@2.7.1` 与 `packages/interface/taskboard/` 的代码级对照评估

## 1. 结论

Taskboard 应继续保持唯一任务事实源、唯一进度工具 `process_update` 和唯一任务 HUD，不引入第二套 Todo 系统。

建议迁移五类能力：

1. 稳定步骤身份与正确的遥测归属。
2. 单调状态转换与防误完成。
3. 语义 no-op 检测。
4. 语义化 HUD 行预算。
5. 可配置面板快捷键和一次性只读检查入口。

步骤依赖图仅作为 P2 可选能力，在出现真实的非线性任务需求后再实现。

## 2. 设计约束

- 保留单一 `process_update` 工具，不增加 Todo CRUD 工具。
- 保留 Taskboard 对 HUD、任务状态和 `git_finalize` 联动的所有权。
- 不新增普通 runtime dependency。
- 保持旧 `process_update` 调用兼容。
- 优先对 `process-view-state-v1` 做可选字段扩展；除非验证证明无法兼容，否则不新建持久化协议版本。
- 不把内部步骤 ID 默认展示给用户或加入模型必填参数。
- 所有状态更新必须先完整验证，再原子提交。
- 先运行变更组件测试，再运行根目录 `npm run check`。

## 3. P0：状态正确性

### TB-01 稳定步骤身份与遥测归属

#### 问题

Taskboard 当前主要依赖步骤文本和数组位置继承计时及 token 遥测。步骤改名并重新排序时，旧步骤的遥测可能被归到新步骤。

#### 需求

- 为持久化步骤增加内部稳定 `id`。
- 新快照按以下顺序协调步骤身份：
  1. 稳定 ID。
  2. 精确文本匹配。
  3. 无歧义的位置匹配。
- 无法可靠确认身份时创建新 ID，且不得继承旧遥测。
- 恢复旧版无 ID session 时自动补充 ID。
- `process_update` 现有输入格式继续有效。
- HUD 默认不显示内部 ID。

#### 验收标准

- 步骤改名、插入、删除和重排后，计时与 token 不串位。
- 同名或同时改名重排造成歧义时，新步骤从零开始记录遥测。
- 旧版无 ID session 可以正常恢复。
- 现有 `process_update` 调用无需修改。
- 覆盖 migration、rename、reorder、insert、delete 和 telemetry reconciliation 测试。

### TB-02 单调状态转换与防误完成

#### 需求

- 同一稳定步骤进入 `done` 后，不允许退回 `pending` 或 `active`。
- 被识别为全新步骤时不受上一条限制。
- 允许 `failed -> active -> done`，支持修复重试。
- `completed` 在当前用户请求内保持终态。
- 新用户请求继续按现有逻辑清理或 tombstone 上一任务。
- 非法转换必须拒绝整次快照，内存状态、timer 和 session entry 均不得变化。

#### 验收标准

- `done -> active` 返回明确、可操作的验证错误。
- `failed -> active -> done` 正常完成。
- 非法快照不会产生部分写入。
- 新用户请求不受上一任务 `completed` 状态阻塞。
- 批量真实完成继续兼容。

### TB-03 语义 no-op 检测

#### 需求

- 对忽略 `updatedAt` 和派生 runtime telemetry 的规范化快照做语义比较。
- title、status、steps、update、blocker、verification 和 artifacts 全部不变时：
  - 不追加 custom entry。
  - 不重置步骤 timer。
  - 不刷新 telemetry。
  - 工具返回 `Taskboard unchanged`。
- update、artifact 或其他事实字段发生真实变化时，仍记录新里程碑。

#### 验收标准

- 连续提交相同快照只保留一个持久化 entry。
- no-op 前后 timer 连续。
- 任一事实字段变化均正常持久化。
- 覆盖 entry count、timer continuity 和 normalized equality 测试。

## 4. P1：HUD 与检查体验

### TB-04 语义化行预算

#### 问题

完整面板最终使用固定行数截断。随着 runtime、activity、blocker 和 verification 信息增加，重要信息可能被普通明细挤出。

#### 需求

- 增加 `taskboard.maxPanelLines`，建议合法范围 `8-20`，默认 `15`。
- 超出预算时按以下优先级保留内容：
  1. 标题、状态和进度。
  2. 当前、失败或阻塞步骤。
  3. blocker、verification 和 latest update。
  4. 其他未完成步骤。
  5. 已完成步骤。
  6. runtime 明细。
- 被隐藏内容显示摘要，例如 `+3 hidden (2 done, 1 pending)`。
- blocker 和 verification 不得被普通 telemetry 行挤掉。
- compact 模式保持简洁，不复制 full 模式明细。

#### 验收标准

- 40、60、80、120 列下不出现越界或错位。
- 8、12、15、20 行预算下输出不超过上限。
- blocker 始终可见。
- 隐藏数量和状态分类准确。
- 默认 15 行下现有可见行为尽量保持兼容。

### TB-05 可配置快捷键与只读检查入口

#### 需求

- 增加 `taskboard.toggleShortcut`，默认 `shift+alt+o`，支持值 `off`。
- 按 Pi KeyId 规则严格校验快捷键。
- 无效值回退默认值，并只通知一次。
- 配置重新加载后解除旧键并注册新键。
- 增加 `/taskboard inspect`：
  - 展示全部步骤、当前状态、blocker、verification、artifacts 和 telemetry。
  - 不改变 `compact/full/off` 持久模式。
  - 不写入新的任务状态 entry。
  - 非 TUI 环境输出等价的纯文本摘要。
- 保留 `/taskboard full` 作为持续固定面板。

#### 验收标准

- 改键后 `/reload` 生效，旧键不再触发。
- `off` 不注册面板快捷键。
- `inspect` 不改变 view mode 或任务快照。
- TUI、print 和 RPC 场景行为明确并有测试。

## 5. P2：可选步骤依赖图

### TB-06 步骤依赖关系

该需求只有在真实任务需要非线性依赖时才实施。最多五个线性里程碑已经覆盖的场景不应引入此复杂度。

#### 需求

- `process_update.steps[]` 可选增加稳定 `key` 和 `blockedBy: key[]`。
- 校验重复 key、悬空引用、自依赖和循环依赖。
- 依赖未完成的步骤不能设为 `active` 或 `done`。
- full HUD 显示 `blocked by: key1, key2`。
- compact HUD 只显示当前阻塞原因。
- 未使用依赖字段时，旧 schema、UI 和模型负担保持接近现状。

#### 验收标准

- 合法 DAG 可正常推进。
- cycle、dangling reference 和 self-block 均原子拒绝。
- 旧调用不需要提供 `key`。
- context reminder 可以保留依赖，但必须有严格长度上限。

## 6. 明确非目标

- 不增加第二个 `todo` 工具、`/todos` 命令或 `rpiv-todos` widget。
- 不迁移 create/update/get/list/delete/clear 逐任务 CRUD。
- 不迁移任意 `metadata` 字段。
- 不迁移 Todo 的 tool-result 快照持久化；继续使用 Taskboard custom entry。
- 不让 `Ctrl+O` 控制 Taskboard。
- 不引入 `@juicesharp/*` runtime dependency。
- 不把 Taskboard 改造成跨请求长期项目 backlog。
- 不允许多个组件同时拥有任务 footer 或 HUD。

## 7. 实施顺序

### Wave A：状态正确性

实施 TB-01、TB-02、TB-03。

建议先写失败测试，再修改 `lib/types.ts`、`lib/state.ts` 和 extension 持久化路径。完成后运行 Taskboard 局部测试和根目录检查。

### Wave B：HUD 体验

实施 TB-04、TB-05。

修改 `lib/config.ts`、`lib/render.ts`、`extensions/taskboard.ts` 及对应测试。验证窄宽终端、配置 reload、TUI 和非 TUI 行为。

### Wave C：可选依赖图

只有在确认存在真实非线性依赖用例后实施 TB-06。否则保持未开发状态。

## 8. 预计涉及文件

- `packages/interface/taskboard/lib/types.ts`
- `packages/interface/taskboard/lib/state.ts`
- `packages/interface/taskboard/lib/render.ts`
- `packages/interface/taskboard/lib/config.ts`
- `packages/interface/taskboard/extensions/taskboard.ts`
- `packages/interface/taskboard/tests/*.test.ts`
- `packages/interface/taskboard/README.md`
- `docs/CAPABILITIES.md`

## 9. 完成定义

每个 Wave 只有在以下条件全部满足后才算完成：

- 对应验收测试通过。
- Taskboard 组件检查通过。
- 根目录 `npm run check` 通过。
- 旧 session 与旧 `process_update` 调用兼容。
- 没有新增 runtime dependency 或第二套任务状态源。
- README 与 capability 文档和实际行为一致。
