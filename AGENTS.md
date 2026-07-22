# terrific-pi AGENTS.md

本文件约束整个 **terrific-pi monorepo** 的开发、编排、迁移、提交与离线发布行为。
优先级：本文件 > 全局 `~/.pi/agent/AGENTS.md` > 默认习惯。  
默认语言：简体中文；代码、路径、命令、标识符用英文。

## 仓库定位与设计边界

terrific-pi 是**个性化 Pi 的增强组件 monorepo**：在一个 Git、治理、迁移和离线发布边界中，维护多个独立 pi package、agent/skill 资源、跨包 workflows 与无密钥配置。它不是单一运行时大包，也不是为了共享依赖而建立的 Node workspace。

- 路径通常为 `~/.pi/vendor/terrific-pi`，由 `settings.json` 使用相对 package path 引用。
- 每个 `extensions/<name>/` 独立加载、测试和发布；根仓只统一治理与打包，不制造跨插件隐式运行时耦合。
- package 私有的 agents/chains/skills 跟随该 package；只有跨 package 编排才进入根 `workflows/`。
- **禁止**入库或打包：真实 `auth.json`、token、session JSONL、trust、subagent 运行态、worktree、本机私密路径和任何密钥。
- **允许**入库：手写公开模板、经消毒的 snapshot，以及 **空 key** 的 `auth.template.json`（见 `snapshot/README.md`）。

### 真源优先级

1. 运行行为：当前代码 + 测试。
2. 仓库治理与目录边界：根 `AGENTS.md`。
3. 当前能力清单与加载关系：`README.md` + `docs/CAPABILITIES.md`。
4. 历史动机与防复发经验：`docs/SESSION_LESSONS.md`。
5. `docs/plans/` 只代表相应日期的设计/实施上下文；未批准或已被后续需求覆盖的计划不是现行规格。

### 目录契约

| 目录 | 角色 | 自身约束 |
|------|------|----------|
| `extensions/` | 独立 pi packages | 一插件一目录；package manifest 只暴露本包资源；私有 agents/chains/skills 留在包内 |
| `skills/` | 可迁移的全局 Agent Skills 源 | 一技能一目录且有 `SKILL.md`；同步到 `~/.agents/skills`；不提交 cache |
| `agent/` | 手写、可公开的 agent 配置模板与外部 package 清单 | 不是 live `~/.pi/agent`；不得放真实凭据或机器绑定状态 |
| `workflows/` | 跨 package workflow 契约与配方 | 不自动发现；必须说明加载入口、权限、状态机、产物、验收和恢复；单包 chain 不上移 |
| `snapshot/agent/` | 经消毒的迁移 payload | 由白名单采集；`snapshot/agent/AGENTS.md` 是安装 payload，不是本目录治理文件 |
| `docs/` | 能力地图、历史复盘与设计记录 | 不存原始 session/密钥；明确“现状、已批准计划、历史经验”的差别 |
| `scripts/` | snapshot/pack/install/test 生命周期 | 默认安全、可重复、失败即停；只操作声明的路径，不把 `.gitignore` 当发布 allowlist |
| `dist/` | 可再生成的离线归档 | gitignore；默认仅保留最新 5 个；不是源码或长期档案库 |
| `.pi-subagents/` 等 | 本地运行态 | 永不入库、永不打包，不作为发布输入 |

当前不为每个顶层目录复制 `AGENTS.md`；目录约束集中在本表和下文，避免漂移。只有某目录出现确实不同且稳定的安全/发布流程时，才新增更具体的嵌套规则。

### 历史会话固化的全局契约

- **真实运行态优先**：HUD、badge 和文本从真实请求/事件/完成状态派生，不能用 UI toggle 冒充执行事实。
- **单一所有权**：同一配置只保留一个真源；同一运行事实只保留一个主 renderer，其他层只做摘要或下钻。
- **完整交付**：大改按用户要求先确认方案；获批后用原始编号做 acceptance checklist，不能只完成最显眼子项。
- **交互一致**：全局菜单循环选择，二级 Esc 返回上级，长列表可筛选，tips 必要但低噪音，80/120/160 列纳入验收。
- **review 与发布分离**：实现、review/fix、commit、push 是不同 checkpoint；commit 和 push 均需用户明确授权。

完整证据、演进与踩坑见 `docs/SESSION_LESSONS.md`。

## 开发前：先扫再写（强制）

新增或大改插件前，**必须先检索是否已有可用实现**，避免重复造轮子。未完成检索不得开工写实现。

### 检索范围（按序）

1. **本仓库**：`extensions/`、`README.md` 插件表、相关 `docs/`
2. **官方 pi**
   - 已安装文档：`@earendil-works/pi-coding-agent/docs/`（尤其 `packages.md`、`extensions.md`）
   - 上游示例 / monorepo 中的 extensions 与 packages
3. **社区与生态**
   - npm 关键字：`pi-package` / `pi-extension`
   - GitHub：pi extensions、statusline、mode、context 等相关仓库与 issue
   - 本机已装包：`~/.pi/agent/npm/`、`~/.pi/agent/git/`、`settings.json` 的 `packages`
4. **结论记录**（对话中简要写出即可）
   - 已有且够用 → **直接安装/引用**，不新建插件
   - 已有但差关键能力 → 优先 **PR/包装既有包** 或薄封装，而非重写
   - 确认无合适实现 → 再在本仓库新建 `extensions/<name>/`

### 判定门槛

| 情况 | 动作 |
|------|------|
| 官方/社区包覆盖 ≥80% 需求 | 用现成的；本仓库最多做配置模板或 1 个适配层 |
| 仅缺 UI/文案/默认配置 | 改配置或 statusline 集成，不新开 extension |
| 需求与现有包语义冲突且无法配置 | 可新建；README 写明为何不能复用 |
| “以后可能要”的抽象 | 不做（YAGNI） |

## 插件开发规范

### 目录与包结构

- **一插件一目录**：`extensions/<name>/`，`<name>` 小写、短横线或单词，与命令/职责一致
- 每个目录是独立可安装的 pi package：

```text
extensions/<name>/
├── package.json          # 必填：name、pi.extensions、keywords 含 pi-package
├── README.md             # 用途、安装、配置、命令
├── extensions/           # 入口 .ts（pi 加载）
├── lib/                  # 可选：纯逻辑
├── tests/                # 推荐：node:test 单测
└── examples/             # 可选：示例配置
```

### package.json 约定

- `"type": "module"`
- `"keywords"` 包含 `pi-package`（及 `pi-extension`）
- `"pi.extensions"` 指向实际入口（如 `./extensions/<name>.ts`）
- `@earendil-works/pi-*`、`pi-tui` 等 pi 内置能力放 **`peerDependencies": "*"`**，不要打进包
- 真正的第三方运行时依赖才进 `dependencies`；本仓库插件默认 **零 runtime 依赖**
- `files` 只列发布所需路径；测试可保留在仓内但不影响加载

### 实现原则

- 最小可用：一个命令/一个关注点一个包；不要做 monorepo 大包再“内部过滤”
- 复用本仓已有模式（参考 `statusline`、`fast`、`mode`）
- 配置文件：可选、失败不抛、不阻断 pi 启动；主文件 `terrific.json`
- 文本 **LF** 换行；不引入与任务无关的格式化大扫除
- 非平凡逻辑留最小可运行校验（`npm test` / `node --test`），不强制测试框架

### 跨插件联动（feat 必做）

新增或大改插件 **feat** 时，设计与实现默认按「本仓已启用插件会同时加载」来考虑，而不是孤立交付。
先扫 `extensions/` + `settings.json` packages，再决定是否需要适配层；联动结论写进对话/PR 简述（无联动也要写「无需」）。

| 触点 | 何时考虑 | 默认动作 |
|------|----------|----------|
| **statusline / HUD** | 有运行态、模式、进度、子任务、配额、开关态等用户应可见的信息 | 专用 status key + widget；必要时改 `EXCLUDED_PROGRESS_KEYS`；避免与现有 badge 抢位/重复 |
| **mode** | 改变工具权限、写入范围、或引入可执行副作用 | 与 `/mode` 语义一致或显式声明覆盖；不静默绕过 ask/plan |
| **fast** | 发模型请求且可能走 OpenAI Priority | 复用既有 tier/开关语义，不另起冲突 header |
| **context** | 显著改变上下文构成或压缩策略 | 保证 `/context` 仍可解释占用；必要时暴露可汇总字段 |
| **btw** | 旁路会话 / 独立 memory | 不污染主 session；HUD 若展示须标明旁路 |
| **配置文件** | 新配置项 | 优先并入既有路径（如 `terrific.json` / `statusline.json`），避免再增并列配置 |

**示例**：做 subagent / 工作流插件时，默认就要设计 HUD——活跃子代理数、当前阶段、完成/失败态应出现在 statusline（或明确说明为何不展示），而不是事后补丁。

- 联动以**薄适配**为准：能在本插件 set status + statusline 读 key 就够，不抽大公共框架
- 只改被联动插件的必要接线（key 名、exclude、widget）；不做无关重构
- 无运行态、纯 slash 查询类命令可标「无需 HUD」并跳过

### 本地引用

开发机 `~/.pi/agent/settings.json`：

```json
"../vendor/terrific-pi/extensions/<name>"
```

相对路径相对 **settings.json 所在目录**。新增插件后应写入 packages（或跑 `scripts/install.sh` 合并）。

### 登记

新插件合并前更新根 `README.md` 插件表（路径 + 一句话说明）。

## Skills 规范

- 一技能一目录：`skills/<name>/`，必须含 `SKILL.md`
- 辅助脚本可同目录（如 `*.py`）；不提交 `__pycache__`
- 本机权威安装路径：`~/.agents/skills/<name>/`（可用 `AGENTS_SKILLS_DIR` 覆盖）
- 刷新仓内技能源：`./scripts/snapshot.sh`（或 `SNAPSHOT_ONLY=skills`）
- 安装时 **始终** 从包同步 skills（保证迁移 1:1）
- 新技能合并前更新根 `README.md` 技能表

## Snapshot 规范

- 源：`./scripts/snapshot.sh` 从本机白名单采集到 `snapshot/agent/`
- 白名单（当前）：`models.json`、`settings.json`、`statusline.json`、`AGENTS.md`、`terrific.json`
- 另生成：`auth.template.json`（从本机 auth 导出 provider 结构，**密钥字段清空**）
- 采集时跑 secret 消毒检查；命中 `apiKey` 值 / bearer / 私钥 / `sk-...` token 则失败
- 还原：`RESTORE=1 ./install.sh` 覆盖写入 agent 快照；`auth.json` 由模板 seed/merge，**不覆盖已有非空 key**
- 迁移手工作业只有：编辑目标机 `~/.pi/agent/auth.json` 填 key（不走 `/login`）
- 默认无 `RESTORE`：仅 seed 缺失文件，不覆盖用户现有配置

## 提交规范

### 何时提交

- 功能/修复/文档/脚本达到可验证状态再提交
- 不提交：`dist/`、`node_modules/`、密钥、本机绝对路径实验垃圾
- 不把无关清理与功能改动混在同一 commit（除非用户明确要求）

### Commit message

沿用本仓历史风格（Conventional Commits 简写）：

```text
feat(statusline): ...
fix(mode): ...
style(fast): ...
docs: ...
chore(scripts): ...
```

- `type` 常用：`feat` | `fix` | `style` | `docs` | `chore` | `refactor` | `test`
- `scope` 优先用插件名：`statusline` | `fast` | `context` | `mode` | `btw` | `scripts`
- 正文说明 **为什么**；一行能说清可省略 body
- 仅用户明确要求时才 `git push`；禁止擅自 `rebase` / `reset --hard` / force-push

### 提交前检查（最小）

1. `git status` / `git diff`：无密钥、无意外文件
2. 变更插件若有测试：在对应目录 `npm test`（或等价 `node --test`）
3. 新增 extension：`package.json` 的 `pi.extensions` 路径真实存在
4. README 插件表与磁盘一致
5. feat：已写跨插件联动结论（尤其 statusline/HUD；无联动写「无需」）

## 自动打包规范

离线包是仓库的发布物之一；内容来自当前工作树中声明的公开 monorepo payload，不读取 Git/runtime 私有状态。

### 脚本

| 脚本 | 作用 |
|------|------|
| `scripts/snapshot.sh` | 从本机采集 agent 快照并刷新 `skills/` 源 |
| `scripts/pack.sh` | 按 allowlist 打包 monorepo payload，生成归档与 `MANIFEST.txt`，成功后执行保留策略 |
| `scripts/install.sh` | 离线安装 vendor + skills；`RESTORE=1` 时 1:1 还原 agent 快照 |
| `scripts/test-install.sh` | 在临时 PI_HOME 做归档安全、保留策略与安装冒烟 |

### 何时打包

在以下情况于仓库根执行 `./scripts/snapshot.sh && ./scripts/pack.sh`，并把结果当作“可拷贝安装包”：

1. **用户要求打包 / 发版 / 迁移到其他设备**
2. **合并了插件/技能/快照或 install/pack/snapshot 脚本变更** 且用户需要离线物
3. **提交并推送后**，若用户要求“带上安装包”，再 pack 一次（包内 `git_sha` 对应该提交）

默认 **不把 `dist/*.tar.gz` 提交进 git**（已 gitignore）。需要分发时拷贝文件即可。

### dist 保留与清理

- `./scripts/pack.sh` 仅在新归档 self-check 成功后清理，默认 `DIST_KEEP=5`。
- 只删除同一输出目录下匹配 `terrific-pi-*.tar.gz` 的普通旧文件；本次新包与无关文件不删除。
- `DIST_KEEP=N` 可调整数量；`DIST_KEEP=0` 仅用于一次性禁用清理。
- 不另设 cron/systemd：`dist` 只在 pack 时增长，在成功 pack 后清理即是最小可靠周期。

### 打包要求

- pack 顶层 allowlist 固定为：`.gitignore`、`AGENTS.md`、`README.md`、`agent/`、`docs/`、`extensions/`、`scripts/`、`skills/`、`snapshot/`、`workflows/`
- pack 必须发现：全部合法插件、`skills/*/SKILL.md`、`snapshot/agent/*`，并包含根级 workflows 源
- `MANIFEST.txt` 含 `packages<<`、`skills<<`、`workflows<<`、`snapshot_agent<<` 四段
- 包内必须有根级 `install.sh` 与 `scripts/*.sh`
- 归档 self-check 必须拒绝：`.git`、`.pi-subagents`、`node_modules`、`sessions`、`__pycache__`、`.env*`、真实 `auth.json`、`*.jsonl`、`*.pem`、`*.key` 等本地/敏感成员
- install 必须：
  - 可无网运行（`npm:`/`git:` 包本身仍可能需网）
  - 合并而非盲写 `packages`（保留 npm:/git: 等外部项；`RESTORE=1` 先还原 snapshot 再合并 terrific-pi 项）
  - 只安装 `auth.template.json` 派生的空壳/合并 `auth.json`，永不打包/覆盖真实密钥
  - skills 始终同步；agent 快照默认 seed，仅 `RESTORE=1` 覆盖
- 改打包/安装脚本后，至少做一次：
  - `./scripts/snapshot.sh`（如需要）
  - `./scripts/pack.sh`
  - 对临时 `PI_HOME` + 临时 `AGENTS_SKILLS_DIR` 跑 `FORCE=1 RESTORE=1 install.sh` 冒烟

### 与开发流的衔接（推荐顺序）

```text
检索官方/社区 → 设计最小包（含跨插件联动，默认想 HUD）→ 实现 + 单测 → 更新 README
  → ./scripts/snapshot.sh（若改了本机配置/技能）
  → 提交（用户授权时 push）→ ./scripts/pack.sh → 分发 tar.gz
  → 目标机 FORCE=1 RESTORE=1 ./install.sh
```

## 安全与边界

- 插件与宿主同权：只添加可信、必要的代码
- 不在插件里硬编码本机用户名、内网地址、密钥
- 不删除用户 `~/.pi` 数据；`FORCE=1` 安装仅替换 `vendor/terrific-pi` 树
- `RESTORE=1` 可覆盖 agent 快照文件；`auth.json` 仅 seed/merge 空 key 结构，**禁止覆盖已有非空密钥**
- 破坏性 git/系统操作必须用户明确授权

## 验证清单（插件 PR/提交自检）

- [ ] 已检索官方文档与社区，结论写明“复用 / 封装 / 新建及原因”
- [ ] feat 已评估与已启用插件的联动（statusline/HUD、mode、fast、context、btw 等），有结论或「无需」
- [ ] 若有 HUD/运行态：statusline 已适配（key / widget / exclude），不与现有 badge 冲突
- [ ] `extensions/<name>/` 结构与 `package.json` 合法
- [ ] 新增 skill 有 `skills/<name>/SKILL.md` 且 README 技能表已更新
- [ ] snapshot 无密钥；`snapshot.sh` 消毒检查可通过
- [ ] 无密钥、LF、无无关大重构
- [ ] 测试或最小手动验证已做
- [ ] README 插件表已更新
- [ ] 需要离线分发时已 `./scripts/pack.sh` 且 install 冒烟通过

## 非目标

- 不在本仓维护 pi 本体或第三方大包（ponytail、npm 全局依赖等）的离线镜像，除非用户另行要求
- 不把真实密钥、sessions、trust 等私密/机器绑定运行态同步进 git（仅允许空 key 的 auth 模板）
- 不把逻辑 monorepo 升级成根 Node workspace；只有出现真实共享构建/依赖需求时再引入根 `package.json`
- 不为“完美架构”拆公共 monorepo 库；重复极小时代码可复制，重复变大再抽
