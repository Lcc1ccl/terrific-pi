# model-profile 开发与实现方案

> 状态：**已交付**（P0+P1+review 修复）  
> 日期：2026-07-20  
> 决策：方案 2 —— 本仓薄插件；**基于社区/官方模式，不重写选择器大盘**

## 1. 结论（先读这个）

| 项 | 决策 |
|----|------|
| 产品形态 | **常用 3–5 套「模型 + 思考强度」配置切换器**，不是第二个全量 `/model` |
| 实现位置 | `extensions/model-profile/`（独立 pi package） |
| 实现策略 | **薄封装 + 官方 API**；UI 只用 `ctx.ui.select/confirm`；逻辑对齐社区/官方 preset 的 apply 模式 |
| 不做什么 | 不 vendoring `pi-presets-plus` 源码；不做 provider 分 tab 长列表；不做 tools/system-prompt 预设；不改 mode 语义 |
| 与社区关系 | **模式复用**（apply/baseline/startup 钩子）；**能力缺口自补**（短列表 + thinking + 会话/全局双写 + 启动同源） |
| 交付顺序 | 文档（本文件 + CAPABILITIES）→ P0 会话切换 → P1 全局/启动 → P2 联动与验收 |

**一句话**：社区包覆盖「长列表 / 完整预设 / 仅启动 / 仅 session」各自一块；你的 6 点合在一起没有单包满分，所以本仓做一个 **配置驱动的短列表切换器**，而不是再造 TUI 选择器。

## 2. 需求冻结

| # | 需求 | 验收标准 |
|---|------|----------|
| R1 | 多 provider、全量列表很长 | 主路径**不展示全量**；只展示配置的 3–5 个 profile |
| R2 | 常用 3–5 个模型 | 配置文件里显式列出；可增删改，无需代码改 |
| R3 | 选模型后默认到指定思考强度 | 每个 profile 含 `thinking`；apply 时 `setModel` + `setThinkingLevel` |
| R4 | 输入框有内容也能切换 | 主路径用 **快捷键 + slash 命令**；禁止依赖「清空编辑器才能 `/model`」 |
| R5 | 全局默认 vs 当前会话临时 | 选择后二次确认或双命令：`session` / `global` |
| R6 | 启动时选择 | 冷启动 `session_start(reason=startup)` 弹出短列表；resume/fork/reload 默认不弹 |

非目标（YAGNI）：

- 替换官方 `/model` / `Ctrl+L`
- 收藏全 registry、模糊搜索、provider tab
- 绑定 tools / system prompt（那是 `pi-presets-plus` / 官方 `preset` 的领域）
- 自动按任务路由模型（`pi-model-router`）
- 改 auxiliary / btw 路由

## 3. 检索结论（为何新建）

### 3.1 已扫范围

- 本仓：`extensions/*` —— 无模型选择插件；`auxiliary` 只做旁路任务模型
- 官方：`/model`、`Ctrl+L`、`Ctrl+P`、`Ctrl+S`、`Shift+Tab`；示例 `preset.ts`、`model-status.ts`
- 社区（npm/git）：

| 包 | 强项 | 缺口（相对 R1–R6） |
|----|------|-------------------|
| `@sherif-fanous/pi-presets-plus` | model+thinking+tools+prompt 预设、热键、TUI 编辑 | 重；无「仅本次/写全局」双写；启动不弹；心智是「工作模式」不是「常用模型」 |
| `pi-startup-picker` | 冷启动 provider/model | 无 thinking；逛全量；不覆盖会话中切换 |
| `pi-session-model` | 明确 session-only + thinking | 无短列表/收藏；无全局；无启动 |
| `pi-model-cycler` / `pi-model-picker` | 长列表/收藏 | **不绑 thinking**；无全局/启动双语义 |
| 官方 `preset.ts` | model+thinking 最小示例 | 无全局双写；无启动；配置偏「模式」 |

### 3.2 判定

- 单包覆盖 **&lt; 80%** 的 R1–R6 组合 → 允许本仓新建
- 但 **≥80% 的实现技巧** 已在官方/社区出现 → **禁止重写** 大 TUI / 预设编辑器
- 正确粒度：**薄插件 + 复用 API 与交互模式**

### 3.3 与「直接装社区」的对比

| 路线 | 结果 |
|------|------|
| 只装 presets-plus + startup-picker | 能用，但两套配置、两套心智；缺「全局 vs 会话」统一入口；tools/prompt 噪音 |
| **本仓 model-profile** | 一套短列表配置服务 R1–R6；实现量小；可离线打进 terrific-pi |

## 4. 产品设计

### 4.1 概念

```text
Profile = {
  id: "daily",
  label: "Daily Grok",
  provider: "grok",
  model: "grok-4.5",
  thinking: "high",
  hotkey?: "ctrl+alt+1"   // optional
}
```

- **Session apply**：只改当前会话 model + thinking  
- **Global apply**：session apply + 写入用户 settings 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`  
- **Startup**：仅 `reason === "startup"` 时，从同一 profile 列表选一次（默认 session apply；可选「同时设为全局」）

### 4.2 用户路径

```text
冷启动
  └─ startupOn=true → 选 profile → [仅本次 | 本次+全局默认] → 进入会话

会话中（编辑器可有草稿）
  ├─ 快捷键 ctrl+alt+1..n  → 直接 session apply（最快）
  ├─ /profile              → 列表 → 选 profile → 选 scope(session|global)
  ├─ /profile daily        → session apply
  ├─ /profile daily global → global apply
  └─ 冷门模型仍用官方 Ctrl+L / /model（不接管）
```

### 4.3 配置

优先并入既有路径，避免新并列配置爆炸：

**推荐**：`~/.pi/agent/terrific.json` 段 `modelProfile`

```json
{
  "modelProfile": {
    "startup": true,
    "startupScope": "session",
    "profiles": [
      {
        "id": "daily",
        "label": "Daily",
        "provider": "grok",
        "model": "grok-4.5",
        "thinking": "high",
        "hotkey": "ctrl+alt+1"
      },
      {
        "id": "fast",
        "label": "Fast",
        "provider": "openai",
        "model": "gpt-5.4-mini",
        "thinking": "low",
        "hotkey": "ctrl+alt+2"
      }
    ]
  }
}
```

规则：

- 配置缺失 / JSON 坏掉 → **不阻断 pi 启动**，notify 一次
- `profiles` 建议 1–8；&gt;8 仍可用但不鼓励（违背 R2）
- `thinking` 非法或模型不支持 → 按官方语义 clamp，并 info 提示（对齐 presets-plus `effectiveThinkingLevel` 模式）
- 模型不在 registry / 无 key → apply 失败，明确 notify，不静默降级

### 4.4 命令与快捷键

| 入口 | 行为 |
|------|------|
| `/profile` | 交互：选 profile → 选 `session` / `global` |
| `/profile <id>` | session apply |
| `/profile <id> session\|global` | 指定 scope apply |
| `/profile list` | 打印列表 + 当前命中 |
| `/profile startup on\|off` | 改配置中的 startup 开关（写回 terrific） |
| `/profile status` | 当前 model/thinking 与哪个 profile 匹配 |
| profile `hotkey` | 直接 session apply（R4） |

快捷键必须 `registerShortcut`，不依赖输入框清空。

### 4.5 Scope 语义（R5 精确化）

| Scope | 改会话 | 写 `settings.json` 默认 | 下次新会话 |
|-------|--------|-------------------------|------------|
| `session` | 是 | 否 | 仍用旧全局默认 |
| `global` | 是 | 是（defaultProvider/Model/ThinkingLevel） | 用新默认 |

说明：

- 官方 `Ctrl+S` 只存 model；本插件 global 额外写 thinking，这是相对官方的增量价值
- 若未来上游把 in-session 切换默认改为 ephemeral（issue #5263 方向），本插件 session 语义不变；global 仍是显式写 settings

### 4.6 启动语义（R6）

对齐 `pi-startup-picker` 边界（模式复用，不依赖其包）：

| `session_start.reason` | 行为 |
|------------------------|------|
| `startup` | 可弹 |
| `resume` / `fork` / `reload` / `new` | 不弹 |
| 无 UI / print/rpc | 不弹 |
| `startup: false` | 不弹 |
| 用户取消 | 保留 pi 已解析的默认 model，不报错 |

启动弹窗选项只含配置的 profiles（+ 可选 “Keep default”），**不** Browse all providers。

## 5. 实现方案（技术）

### 5.1 包结构（本仓惯例）

```text
extensions/model-profile/
├── package.json
├── README.md
├── tsconfig.json
├── extensions/model-profile.ts    # 入口：命令/快捷键/session_start
├── lib/
│   ├── types.ts
│   ├── config.ts                  # 读 terrific.modelProfile；失败安全
│   ├── apply.ts                   # setModel + setThinkingLevel + optional settings write
│   ├── match.ts                   # 当前状态是否命中某 profile
│   └── settings-defaults.ts       # 写 defaultProvider/Model/ThinkingLevel
├── tests/
│   ├── config.test.ts
│   ├── apply.test.ts
│   └── match.test.ts
└── examples/config.json
```

零 runtime dependencies；peer：`@earendil-works/pi-coding-agent`（及实现需要的 `pi-ai` 类型若直接引用 Model）。

### 5.2 从社区/官方复用什么（禁止整包拷贝）

| 来源 | 复用什么 | 不复用什么 |
|------|----------|------------|
| 官方 `preset.ts` | apply 顺序：find model → setModel → setThinkingLevel；失败 notify | tools / instructions / 完整 SelectList UI |
| `pi-presets-plus` apply/thinking | thinking clamp 思路、拒绝种类（no-key/unknown-model） | store 合并、drift、tools overlay、大 TUI |
| `pi-startup-picker` | `session_start` 仅 startup；cancel → fallback default；无 UI skip | recent-store 全量 browse；独立 npm 依赖 |
| `pi-session-model` | session-only 语义表述 | 独立命令体系 |

原则：**读懂模式后自写 100–200 行**，不 `bundledDependencies` 社区包，避免双命令/双配置打架。

### 5.3 核心算法（伪代码）

```ts
async function applyProfile(pi, ctx, profile, scope: "session" | "global") {
  const model = ctx.modelRegistry.find(profile.provider, profile.model);
  if (!model) return fail("unknown-model");
  const ok = await pi.setModel(model);
  if (!ok) return fail("set-model-refused");
  const level = clampThinking(profile.thinking, model);
  pi.setThinkingLevel(level);
  if (scope === "global") {
    await writeSettingsDefaults({
      defaultProvider: profile.provider,
      defaultModel: profile.model,
      defaultThinkingLevel: level,
    });
  }
  ctx.ui.setStatus?.("model-profile", profile.id); // optional
  ctx.ui.notify(`${scope}: ${profile.provider}/${profile.model} · ${level}`);
}
```

`writeSettingsDefaults` 实现选项（实现期二选一，优先更稳的）：

1. **优先**：若当前 pi 版本 extension API / SettingsManager 暴露 setDefault* —— 用 API  
2. **否则**：原子读写 `~/.pi/agent/settings.json`（只改三个字段，保留其余；写失败则 session 已生效但 global 报 warning）

实现前用本机 `0.80.x` 源码确认；**禁止**盲写整个 settings。

### 5.4 UI 策略（避免重写）

- 列表：`ctx.ui.select(title, labels)`  
- 确认 scope：`select(["session (this chat only)", "global (also update defaults)"])`  
- 不引入自定义 `pi-tui` Component（除非 select 无法满足 R4——目前快捷键路径已满足）

### 5.5 跨插件联动

| 触点 | 动作 |
|------|------|
| **statusline** | 已有 `model` widget 显示 provider/model/thinking；**默认无需新 widget**。可选 status key `model-profile` 显示 profile id；若加 key，评估是否进 `EXCLUDED_PROGRESS_KEYS`（多半不需要，id 很短） |
| **mode** | 不联动。mode 管工具权限，profile 管模型 |
| **fast** | 不联动。fast 是 Priority tier，与 thinking 正交 |
| **auxiliary / btw** | 不改主会话 profile；旁路路由独立 |
| **context / process-view / docsflow** | 无需 |
| **官方 /model** | 并存；全量选择走官方 |
| **若用户同时装 presets-plus** | 文档声明：两者可共存但易混淆；推荐只用 model-profile 做「常用模型」 |

联动结论：**无需强制改 statusline**；P0 零联动也可交付。

### 5.6 测试计划

| 层 | 内容 |
|----|------|
| 单测 | config 解析/默认值/坏 JSON；match 命中；clamp thinking；settings 合并只改三字段 |
| 手动 | 编辑器有草稿时热键切换；session 不改 settings；global 改 settings；启动弹/不弹矩阵；无 key 模型失败提示 |
| 回归 | `/mode`、`/fast`、statusline model 行仍正常 |

### 5.7 登记与安装

实现完成后：

1. 根 `README.md` 插件表加一行  
2. `docs/CAPABILITIES.md` 插件决策表 + 调用表更新  
3. 开发机 `settings.json` packages 增加  
   `"../vendor/terrific-pi/extensions/model-profile"`  
4. 需要离线分发时再 `snapshot.sh && pack.sh`（用户要求时）

## 6. 分期

### P0 — MVP（会话切换）✅ 已完成

- [x] 包骨架 + config 读写  
- [x] `/profile` 列表与 session apply  
- [x] `/profile <id>`、`list`、`status`  
- [x] 可选 hotkey → session apply  
- [x] 单测 config/apply(match)  
- [x] README 安装与示例配置  

### P1 — 全局 + 启动 ✅ 已完成（代码/单测）

- [x] scope=global 写 settings 三字段  
- [x] `session_start` startup 短列表  
- [x] `/profile startup on|off`  
- [ ] 启动矩阵手动验收（交用户真机）  

### P2 — 打磨 ✅（review 闭环）

- [x] 与 CAPABILITIES / 根 README 同步  
- [x] status key `model-profile`（alias → progress）  
- [x] session restore 对抗 pi `setModel` 持久化 + settings 文件锁  
- [x] 用户真实 3–5 profile 写在本机 `terrific.json`（示例见 package examples）  
- [ ] 若上游提供 ephemeral setModel API 再删 restore 补丁  

## 7. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 写 settings.json 并发/格式 | 只 patch 已知字段；写失败不回滚 session（已成功）但 warning |
| 与 presets-plus 同时装 | README 警告；命令名不同（`/profile` vs `/presets`） |
| thinking clamp 与用户预期不符 | notify 实际 level |
| 启动弹窗打扰 resume | 严格 reason 过滤 |
| 热键冲突 | 默认不强制热键；示例用 `ctrl+alt+1..` 避开本仓 mode/fast |

回滚：从 `settings.json` packages 移除路径即可；配置段可留可删，无副作用。

## 8. 工作量估计

| 阶段 | 约当 |
|------|------|
| P0 | 0.5–1 天 |
| P1 | 0.5 天 |
| P2 | 0.5 天内 |

刻意保持小：若实现膨胀到「半套 presets-plus」，停下来删功能，不堆。

## 9. 实现开工检查清单

开工写代码前确认：

1. [ ] 本计划与 CAPABILITIES 已入库  
2. [ ] 用户确认初始 3–5 个 profile 内容（或先用 examples 占位）  
3. [ ] 本机 pi 版本确认 `setModel` / `setThinkingLevel` / `session_start.reason`  
4. [ ] 确认 settings 写入路径（API vs 文件）  
5. [ ] 不引入 npm runtime 依赖  

## 10. 开放问题（实现前可默认）

| 问题 | 默认（可改） |
|------|----------------|
| 命令名 `/profile` vs `/mp` vs `/modelslot` | **`/profile`** |
| 启动默认 scope | **`session`**（更安全） |
| 热键是否预置 | 示例有，默认配置可空 |
| 是否做 profile CRUD TUI | **否**；手改 JSON + `/profile reload`（若需要） |
| 是否 pin 社区包作依赖 | **否** |

---

**下一步（实现阶段）**：用户确认本计划 → 建 `extensions/model-profile` → P0 → 真机 `/reload` 验收。
