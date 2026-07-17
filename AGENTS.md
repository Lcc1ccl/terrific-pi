# terrific-pi AGENTS.md

本文件约束在 **terrific-pi** 仓库内的插件开发、提交与离线打包行为。  
优先级：本文件 > 全局 `~/.pi/agent/AGENTS.md` > 默认习惯。  
默认语言：简体中文；代码、路径、命令、标识符用英文。

## 仓库定位

- 路径：通常为 `~/.pi/vendor/terrific-pi`（由 `settings.json` 相对路径引用）
- 内容：可公开的 pi packages（`extensions/`）、配置模板（`agent/`）、离线脚本（`scripts/`）
- **禁止**入库：`auth.json`、API key、token、session 日志、本机私密路径硬编码

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
- 配置文件：可选、失败不抛、不阻断 pi 启动；优先兼容既有路径（如 `pi-essentials.json`）
- status key / footer badge：若占用 statusline 专用位，同步改 `statusline` 的 `EXCLUDED_PROGRESS_KEYS` 或专用 widget
- 文本 **LF** 换行；不引入与任务无关的格式化大扫除
- 非平凡逻辑留最小可运行校验（`npm test` / `node --test`），不强制测试框架

### 本地引用

开发机 `~/.pi/agent/settings.json`：

```json
"../vendor/terrific-pi/extensions/<name>"
```

相对路径相对 **settings.json 所在目录**。新增插件后应写入 packages（或跑 `scripts/install.sh` 合并）。

### 登记

新插件合并前更新根 `README.md` 插件表（路径 + 一句话说明）。

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

## 自动打包规范

离线包是仓库的发布物之一；**内容以当前工作树 + 已声明 extensions 为准**。

### 脚本

| 脚本 | 作用 |
|------|------|
| `scripts/pack.sh` | 扫描 `extensions/*/package.json`，生成 `dist/terrific-pi-<utc>-<sha>.tar.gz` + `MANIFEST.txt` |
| `scripts/install.sh` | 离线安装到 `$PI_HOME/vendor/terrific-pi`，合并 `settings.json` packages |

### 何时打包

在以下情况于仓库根执行 `./scripts/pack.sh`，并把结果当作“可拷贝安装包”：

1. **用户要求打包 / 发版 / 同步到其他设备**
2. **合并了插件增删或 install/pack 脚本变更** 且用户需要离线物
3. **提交并推送后**，若用户要求“带上安装包”，再 pack 一次（包内 `git_sha` 对应该提交）

默认 **不把 `dist/*.tar.gz` 提交进 git**（已 gitignore）。需要分发时拷贝文件即可。

### 打包要求

- pack 必须能在无额外配置下发现全部合法插件（含 `pi.extensions` 的 package）
- 包内必须有根级 `install.sh` 与 `scripts/install.sh`
- 排除：`.git`、`node_modules`、`dist`、密钥类文件
- install 必须：
  - 可无网运行
  - 合并而非盲写 `packages`（保留 npm:/git: 等外部项）
  - 不覆盖已有 `auth.json` / 用户私密配置；模板仅 seed 缺失文件
- 改 `pack.sh` / `install.sh` 后，至少做一次：`./scripts/pack.sh` + 对临时 `PI_HOME` 跑 `install.sh` 冒烟

### 与开发流的衔接（推荐顺序）

```text
检索官方/社区 → 设计最小包 → 实现 + 单测 → 更新 README
  → 提交（用户授权时 push）→ ./scripts/pack.sh → 分发 tar.gz
```

## 安全与边界

- 插件与宿主同权：只添加可信、必要的代码
- 不在插件里硬编码本机用户名、内网地址、密钥
- 不删除用户 `~/.pi` 数据；`FORCE=1` 安装仅替换 `vendor/terrific-pi` 树
- 破坏性 git/系统操作必须用户明确授权

## 验证清单（插件 PR/提交自检）

- [ ] 已检索官方文档与社区，结论写明“复用 / 封装 / 新建及原因”
- [ ] `extensions/<name>/` 结构与 `package.json` 合法
- [ ] 无密钥、LF、无无关大重构
- [ ] 测试或最小手动验证已做
- [ ] README 插件表已更新
- [ ] 需要离线分发时已 `./scripts/pack.sh` 且 install 冒烟通过

## 非目标

- 不在本仓维护 pi 本体或第三方大包（ponytail、npm 全局依赖等）的离线镜像，除非用户另行要求
- 不把 `~/.pi/agent` 私密运行态同步进 git
- 不为“完美架构”拆公共 monorepo 库；重复极小时代码可复制，重复变大再抽
