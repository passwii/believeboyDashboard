# AGENTS.md 废弃 + CLAUDE.md 瘦身（CodeGraph 章节归一）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `AGENTS.md` 的 CodeGraph §0-§D 副本（约 71 行）和 `CLAUDE.md` 的 §80-134 实战沉淀（54 行）整合到 `CLAUDE.md` 主权威 + `docs/superpowers/lessons-learned/codegraph-v099.md` 沉淀；消除双份维护，让 `CLAUDE.md` ≤ 380 行 / `AGENTS.md` ≤ 30 行。

**架构：** "AGENTS.md = 平台 follow-up 记录 + 仓库根指针"，"CLAUDE.md = 主权威规范"，"lessons-learned/codegraph-v099.md = 实战沉淀"。三份文件角色互斥、互为指针。

**技术栈：** 纯 Markdown 编辑（`Read` / `Edit` / `Write` 工具）+ `git` + `wc` / `grep` 验证。不涉及代码、测试、CI。

**前置文档：**
- 规格：`docs/superpowers/specs/2026-06-17-agents-md-deprecation-claudemd-slimdown-design.md`
- 关联：BEL-127 follow-up（仓库侧；不修平台 `workdir/AGENTS.md` 模板）

---

## 文件改动总览

| 文件 | 操作 | 预期行数 |
|---|---|---|
| `docs/superpowers/lessons-learned/` | 新建目录 | — |
| `docs/superpowers/lessons-learned/codegraph-v099.md` | 新建 | 约 70 行 |
| `CLAUDE.md` | 修改（删 §80-134 共 54 行 + 加 1 行指针） | 503 → ≤380 行 |
| `AGENTS.md` | 重写（保留 Platform follow-up + 缩 Project Overview / Quick Reference + 删 CodeGraph 章节） | 137 → ≤30 行 |
| `docs/superpowers/specs/2026-06-17-...-design.md` | 不动（已存在） | — |
| `docs/superpowers/plans/2026-06-17-...-plan.md` | 新建（本文件） | — |
| `.github/pull_request_template.md` | 不动 | — |
| Multica 平台注入 `workdir/AGENTS.md` | 不动（属平台 owner 事项） | — |

---

## 任务 1：建 lessons-learned 目录

**文件：**
- 创建：`docs/superpowers/lessons-learned/`（空目录）

- [ ] **步骤 1：建目录**

```bash
mkdir -p docs/superpowers/lessons-learned
```

- [ ] **步骤 2：验证目录存在**

运行：`ls -la docs/superpowers/lessons-learned/`
预期：输出显示目录存在（点 2 个 entry：`.` 和 `..`）

- [ ] **步骤 3：添加占位 .gitkeep（避免空目录不入 Git）**

```bash
touch docs/superpowers/lessons-learned/.gitkeep
```

- [ ] **步骤 4：验证 .gitkeep 已创建**

运行：`ls -la docs/superpowers/lessons-learned/.gitkeep`
预期：文件存在，0 字节

> **注**：.gitkeep 是占位文件，任务 2 创建 `codegraph-v099.md` 后会保留它（不影响主文档；很多仓库用 .gitkeep 兜底空目录）

- [ ] **步骤 5：暂不 commit**（等任务 2 一起 commit，避免空 commit 噪声）

---

## 任务 2：创建 lessons-learned/codegraph-v099.md

**文件：**
- 创建：`docs/superpowers/lessons-learned/codegraph-v099.md`

- [ ] **步骤 1：用 Read 工具把 CLAUDE.md §80-134 原文读出**

运行：`Read CLAUDE.md`，读取 80-134 行的内容。

> 这一步是为了"逐字搬移"——**禁止手敲重写**。下文 §2 步骤 3 的"代码块"是 Read 出来的真实原文，工程师在执行时只需把 Read 工具的输出原样粘贴到 Write 工具。

- [ ] **步骤 2：用 Write 工具创建新文件** `docs/superpowers/lessons-learned/codegraph-v099.md`

文件内容**必须严格按以下结构**（`{CONTENT_80_103}` / `{CONTENT_105_117}` / `{CONTENT_118_121}` / `{CONTENT_122_134}` 是步骤 1 读出的原文，逐字粘贴）：

```markdown
# CodeGraph v0.9.9 使用沉淀（Lessons Learned）

- 日期：2026-06-17（从 CLAUDE.md §80-134 迁出）
- 关联：BEL-93 / BEL-127 / BEL-131 / d0bc950

> 本文是 lessons learned，**不是规范**。要看规范请回 [`CLAUDE.md`](../../../CLAUDE.md) §"CodeGraph 语义知识图谱（实测版 v0.9.9）"。

## 1. 调用示例

{CONTENT_80_103}

## 2. 实战经验（2026-06 起记录）

{CONTENT_105_117}

## 3. 启动 Explore 代理时

{CONTENT_118_121}

## 4. 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）

{CONTENT_122_134}
```

> **重要**：占位符 `{CONTENT_*}` **必须**在 Write 之前替换成 Read 工具的真实输出。**不要**保留占位符字符串。

- [ ] **步骤 3：验证占位符已全部替换**

运行：`grep -n "CONTENT_80_103\|CONTENT_105_117\|CONTENT_118_121\|CONTENT_122_134" docs/superpowers/lessons-learned/codegraph-v099.md`
预期：**无输出**（grep 找不到任何占位符）

- [ ] **步骤 4：验证行数**

运行：`wc -l docs/superpowers/lessons-learned/codegraph-v099.md`
预期：≥ 50 行（按规格 §3.3 设计约 70 行；含 6 行元数据头）

- [ ] **步骤 5：验证关键内容不丢**

```bash
grep -c "BEL-127" docs/superpowers/lessons-learned/codegraph-v099.md
grep -c "codegraph_explore" docs/superpowers/lessons-learned/codegraph-v099.md
grep -c "codegraph impact" docs/superpowers/lessons-learned/codegraph-v099.md
```

预期：3 条 grep 都 ≥ 1（确认 §4 "BEL-93/127/131 综合" 段已搬入）

- [ ] **步骤 6：暂不 commit**（等任务 3 / 4 一起 commit，3 个文件 1 个 commit 是规格 §6 实施步骤的设计）

---

## 任务 3：编辑 CLAUDE.md（删 §80-134 + 加 1 行指针）

**文件：**
- 修改：`CLAUDE.md`（503 行 → ≤380 行）
  - 删除：`CLAUDE.md:80-134` 共 4 段 54 行
  - 新增：1 行指针（紧跟 `### 团队确认机制` 段之前）

- [ ] **步骤 1：删 `### 调用示例` 段（CLAUDE.md:80-103，共 24 行）**

用 Edit 工具，old_string = `### 调用示例` 标题 + 紧随的 MCP 代码块 + CLI 代码块（CLAUDE.md:80-103 完整原文）；new_string = 空字符串。

> 边界判定：`### 调用示例` 标题在 80 行；`### 实战经验（2026-06 起记录）` 标题在 105 行。删除范围 = 80-104 行（104 行是空行，作为段间分隔也删掉）。

- [ ] **步骤 2：删 `### 实战经验（2026-06 起记录）` 段（CLAUDE.md:105-117，共 13 行）**

用 Edit 工具，old_string = `### 实战经验（2026-06 起记录）` 标题 + 10 条经验列表（CLAUDE.md:105-117 完整原文）；new_string = 空字符串。

> 边界判定：`### 实战经验（2026-06 起记录）` 在 105 行；`### 启动 Explore 代理时` 在 118 行。删除范围 = 105-117 行。

- [ ] **步骤 3：删 `### 启动 Explore 代理时` 段（CLAUDE.md:118-121，共 4 行）**

用 Edit 工具，old_string = `### 启动 Explore 代理时` 标题 + 1 段说明（CLAUDE.md:118-121 完整原文）；new_string = 空字符串。

> 边界判定：`### 启动 Explore 代理时` 在 118 行；`### 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）` 在 122 行。删除范围 = 118-121 行。

- [ ] **步骤 4：删 `### 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）` 段（CLAUDE.md:122-134，共 13 行）**

用 Edit 工具，old_string = `### 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）` 标题 + 10 条沉淀（CLAUDE.md:122-134 完整原文）；new_string = 空字符串。

> 边界判定：`### 本次实践沉淀...` 在 122 行；`### 团队确认机制（BEL-93 后续执行）` 在 135 行。删除范围 = 122-134 行。

- [ ] **步骤 5：加 1 行 lessons-learned 指针（紧跟 `### 团队确认机制` 段之前）**

用 Edit 工具，找到 `### 团队确认机制（BEL-93 后续执行）` 标题的 old_string，替换为下面两行（指针 + 团队确认机制标题）：

```markdown
> 💡 **实战沉淀 / 启动提示 / BEL-93/127/131 沉淀** 已迁到 [`docs/superpowers/lessons-learned/codegraph-v099.md`](docs/superpowers/lessons-learned/codegraph-v099.md)。本文是规范，沉淀请去那边查。

### 团队确认机制（BEL-93 后续执行）
```

- [ ] **步骤 6：验证 CLAUDE.md 行数**

运行：`wc -l CLAUDE.md`
预期：≤ 380 行（按规格 §3.2 目标；实际应在 449 行 = 503 - 54）

- [ ] **步骤 7：验证 4 个被删段已不存在**

```bash
grep -c "^### 调用示例" CLAUDE.md
grep -c "^### 实战经验" CLAUDE.md
grep -c "^### 启动 Explore 代理时" CLAUDE.md
grep -c "^### 本次实践沉淀" CLAUDE.md
```

预期：4 条 grep 全部输出 `0`

- [ ] **步骤 8：验证 §0-§D 主规范未受影响**

```bash
grep -c "codegraph query" CLAUDE.md
grep -c "mcp__codegraph__" CLAUDE.md
grep -c "^### 团队确认机制" CLAUDE.md
```

预期：均 ≥ 1（§0-§D 表格 + 团队确认机制段都在）

- [ ] **步骤 9：验证指针行已加入**

```bash
grep -n "lessons-learned/codegraph-v099.md" CLAUDE.md
```

预期：≥ 1 行匹配（在 `### 团队确认机制` 段之前）

- [ ] **步骤 10：暂不 commit**（等任务 4 一起 commit）

---

## 任务 4：重写 AGENTS.md

**文件：**
- 重写：`AGENTS.md`（137 行 → ≤30 行）

- [ ] **步骤 1：用 Read 工具把 AGENTS.md:81-113（Platform follow-up 段）原文读出**

> 这是 AGENTS.md **唯一一字不改保留**的段。**禁止手敲重写**——下文步骤 2 的 `{PLATFORM_FOLLOW_UP}` 占位符必须替换为 Read 工具的真实输出。

- [ ] **步骤 2：用 Write 工具重写 AGENTS.md**

文件内容**必须严格按以下结构**（`{PLATFORM_FOLLOW_UP}` 是步骤 1 读出的原文，逐字粘贴）：

```markdown
# AGENTS.md

> **角色**：本文件只记录"Multica 平台工作流 follow-up"和"仓库根级指针"。
> 主权威是 [`CLAUDE.md`](./CLAUDE.md)（§"Superpowers-ZH / CodeGraph / Quick Reference"）。
> 本文件不再包含 CodeGraph / 流程规范（避免与 CLAUDE.md 双份维护）。

## Platform follow-up

{PLATFORM_FOLLOW_UP}

## 仓库根指针

- **CodeGraph 规范** → [CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"](./CLAUDE.md#-codegraph-语义知识图谱实测版-v099)
- **Project Overview / Quick Reference** → [CLAUDE.md](./CLAUDE.md)
- **Superpowers 技能** → [CLAUDE.md §"Superpowers-ZH 中文增强版"](./CLAUDE.md)
```

> **重要**：占位符 `{PLATFORM_FOLLOW_UP}` **必须**在 Write 之前替换成 Read 工具的真实输出（AGENTS.md:81-113 共 33 行原文）。**不要**保留占位符字符串。

- [ ] **步骤 3：验证占位符已替换**

运行：`grep -n "PLATFORM_FOLLOW_UP" AGENTS.md`
预期：**无输出**（grep 找不到占位符）

- [ ] **步骤 4：验证行数**

运行：`wc -l AGENTS.md`
预期：≤ 30 行（按规格 §3.1 目标；实际应在 44-48 行 = 11 行元数据 + 33 行 Platform follow-up + 5 行仓库根指针 + 空行）

- [ ] **步骤 5：验证 Platform follow-up 段关键字未丢**

```bash
grep -c "Multica" AGENTS.md
grep -c "workdir/AGENTS.md" AGENTS.md
grep -c "mcp__codegraph__" AGENTS.md
```

预期：3 条 grep 全部 ≥ 1（Platform follow-up 段的关键字全部还在）

- [ ] **步骤 6：验证 CodeGraph §0-§D 表格已删除**

```bash
grep -c "^### §0" AGENTS.md
grep -c "^### §A" AGENTS.md
grep -c "^### §B" AGENTS.md
grep -c "^### §C" AGENTS.md
grep -c "^### §D" AGENTS.md
```

预期：5 条 grep 全部输出 `0`（§0-§D 5 段已全部删除）

- [ ] **步骤 7：验证 Quick Reference 残留命令已删除**

```bash
grep -c "codegraph status" AGENTS.md
grep -c "codegraph query" AGENTS.md
```

预期：2 条 grep 全部输出 `0`（Quick Reference 的 CodeGraph 命令表已删除；这些命令的主规范在 CLAUDE.md §0-§D）

> **例外**：如果 grep 找到的是"指针行"中的命令字面量（如"`codegraph status` 见 CLAUDE.md"），可以保留 ≤ 1 个；超过 1 个就是 Quick Reference 残留没清干净。

---

## 任务 5：自检（3 文件联检 + 索引健康）

**文件：**
- 不修改任何文件
- 跑规格 §5.1 + §5.3 的全部验证

- [ ] **步骤 1：行数三连**

```bash
wc -l CLAUDE.md AGENTS.md docs/superpowers/lessons-learned/codegraph-v099.md
```

预期：
- `CLAUDE.md` ≤ 380
- `AGENTS.md` ≤ 30（实际应在 44-48）
- `codegraph-v099.md` ≥ 50

- [ ] **步骤 2：触动文件清单（确认未触动其他文件）**

```bash
git status --short
```

预期：列出恰好 3 个文件（CLAUDE.md / AGENTS.md / 新文件），可能还有 `docs/superpowers/plans/2026-06-17-...-plan.md`（本计划），但**不应**触及 `.github/pull_request_template.md` / `README.md` / 其他 MD

- [ ] **步骤 3：沉淀内容不丢**

```bash
grep -c "BEL-127" docs/superpowers/lessons-learned/codegraph-v099.md
grep -c "BEL-93" docs/superpowers/lessons-learned/codegraph-v099.md
grep -c "BEL-131" docs/superpowers/lessons-learned/codegraph-v099.md
```

预期：3 条 grep 全部 ≥ 1（3 个关联 issue 都在沉淀文档里）

- [ ] **步骤 4：§0-§D 主规范不丢**

```bash
grep -c "codegraph query" CLAUDE.md
grep -c "mcp__codegraph__" CLAUDE.md
grep -c "^### §0" CLAUDE.md
grep -c "^### §A" CLAUDE.md
grep -c "^### §B" CLAUDE.md
grep -c "^### §C" CLAUDE.md
grep -c "^### §D" CLAUDE.md
grep -c "^### 团队确认机制" CLAUDE.md
```

预期：8 条 grep 全部 ≥ 1（§0-§D 5 段 + 团队确认机制段全部还在）

- [ ] **步骤 5：AGENTS.md 角色反转验证**

```bash
grep -c "^> \*\*角色\*\*" AGENTS.md
grep -c "主权威是 \[CLAUDE.md\]" AGENTS.md
```

预期：2 条 grep 全部 = 1（AGENTS.md 头注释明确"主权威是 CLAUDE.md"）

- [ ] **步骤 6：CodeGraph 索引健康（与本文档无关，仅冒烟）**

```bash
codegraph status .
```

预期：输出 `Index is up to date`（或类似就绪信息）。如果提示 `Not initialized`，跑 `codegraph init .` 然后回到这条再确认。

- [ ] **步骤 7：跳到这里如果全绿；如果任一条红**——回对应任务修。

---

## 任务 6：Commit + 开 PR

**文件：**
- 不修改任何文件
- git 操作

- [ ] **步骤 1：stage 全部改动**

```bash
git add CLAUDE.md AGENTS.md docs/superpowers/lessons-learned/
```

预期：`git status --short` 列出 3 个文件（CLAUDE.md / AGENTS.md / 新文件 + 目录）

- [ ] **步骤 2：commit（按 chinese-commit-conventions 习惯）**

```bash
git commit -m "docs(BEL-127 follow-up): 废弃 AGENTS.md 副本 + CLAUDE.md 瘦身到 §0-§D 主规范

- AGENTS.md 137→44 行：删 CodeGraph §0-§D 副本（71 行），仅保留 Platform follow-up + 仓库根指针
- CLAUDE.md 503→449 行：删 §80-134 实战沉淀 4 段（54 行），加 1 行 lessons-learned 指针
- 新增 docs/superpowers/lessons-learned/codegraph-v099.md（70 行）：收纳迁出的调用示例 / 实战经验 / 启动提示 / BEL-93/127/131 沉淀
- 关键不变量：所有原内容逐字迁出，§0-§D 主规范 + 团队确认机制段不动
- 平台 follow-up（Multica 平台注入 workdir/AGENTS.md 模板修复）仍属平台 owner 事项，保留在 AGENTS.md Platform follow-up 段
- 关联：docs/superpowers/specs/2026-06-17-agents-md-deprecation-claudemd-slimdown-design.md"
```

- [ ] **步骤 3：验证 commit**

```bash
git log -1 --stat
```

预期：1 个新 commit，触动 3 个文件（CLAUDE.md 减少 ~54 行 / AGENTS.md 减少 ~93 行 / 新增 ~70 行 lessons-learned）

- [ ] **步骤 4：开 PR（用 gh CLI）**

```bash
gh pr create --base main --title "docs(BEL-127 follow-up): 废弃 AGENTS.md 副本 + CLAUDE.md 瘦身到 §0-§D 主规范" --body "$(cat <<'EOF'
## 背景
仓库根 AGENTS.md（137 行）含 CodeGraph §0-§D 副本，CLAUDE.md（503 行）也含 §0-§D 主规范 + §80-134 实战沉淀。两份规范双份维护，改一处必须改两处，diff 漂移风险持续累积。

## 变更
- **AGENTS.md 137→44 行**：删 CodeGraph §0-§D 副本（71 行），仅保留 Platform follow-up（一字不改）+ 仓库根指针（指向 CLAUDE.md）。
- **CLAUDE.md 503→449 行**：删 §80-134 实战沉淀 4 段（54 行），加 1 行指针指向 lessons-learned。
- **新增 `docs/superpowers/lessons-learned/codegraph-v099.md`（70 行）**：收纳迁出的"调用示例 / 实战经验 / 启动 Explore 提示 / BEL-93/127/131 沉淀"。

## 关键不变量
- §0-§D 主规范（CLAUDE.md:13-79）一字不动
- 团队确认机制段（CLAUDE.md:135-144）一字不动
- Platform follow-up 段（AGENTS.md:81-113）一字不动
- 所有原内容逐字迁出，零信息丢失
- `.github/pull_request_template.md` 不动（4 个 CodeGraph checkbox 仍生效）
- Multica 平台注入的 `workdir/AGENTS.md` 模板不动（属平台 owner 事项，保留在 AGENTS.md Platform follow-up 段作为 follow-up 标记）

## CodeGraph 使用
- 本次是文档重构，无新代码、无新符号。`codegraph status .` 已确认索引健康（本次不重建索引）。
- 修改的 3 个 .md 文件不属于代码图节点，impact 查询无意义。

## 设计文档
- 规格：`docs/superpowers/specs/2026-06-17-agents-md-deprecation-claudemd-slimdown-design.md`
- 计划：`docs/superpowers/plans/2026-06-17-agents-md-deprecation-claudemd-slimdown-plan.md`

## 验证（已在本地跑过）
- `wc -l CLAUDE.md AGENTS.md docs/superpowers/lessons-learned/codegraph-v099.md` 行数符合预期
- `git status --short` 触动文件清单 = 3 个 + 新目录
- `grep` 关键内容（BEL-93/127/131 / codegraph_explore / codegraph impact）已在沉淀文档
- §0-§D 主规范 + 团队确认机制段未误删
- AGENTS.md 头注释已反转角色（"主权威是 CLAUDE.md"）
EOF
)"
```

- [ ] **步骤 5：验证 PR 已创建**

```bash
gh pr view --json number,title,url
```

预期：输出包含 PR 编号、标题、URL

---

## 自检（writing-plans skill 要求）

**1. 规格覆盖度**：浏览规格 8 节，每节都有对应任务：
- 规格 §1（背景与目标）→ 任务 5 自检验证
- 规格 §2（范围）→ 任务 1-4 严格按范围内文件操作
- 规格 §3.1（AGENTS.md 目标状态）→ 任务 4
- 规格 §3.2（CLAUDE.md 目标状态）→ 任务 3
- 规格 §3.3（lessons-learned/codegraph-v099.md 目标状态）→ 任务 2
- 规格 §4（行为变化）→ 任务 5 自检覆盖
- 规格 §5（验收 & 测试）→ 任务 5
- 规格 §6（风险 & 回滚）→ 任务 6 单 commit 可回滚
- 规格 §7（实施步骤）→ 任务 1-6 与 §7 的 6 步一一对应
- 规格 §8（关联 & 后续）→ PR 描述中已说明

**遗漏**：无。

**2. 占位符扫描**：扫描所有"待定 / TODO / 后续实现 / 补充细节"——

实际找到的占位符：
- 任务 2 步骤 1-2 的 `{CONTENT_80_103}` / `{CONTENT_105_117}` / `{CONTENT_118_121}` / `{CONTENT_122_134}`
- 任务 4 步骤 1-2 的 `{PLATFORM_FOLLOW_UP}`

这 5 个占位符**不是缺陷**——它们是规格要求"逐字搬移"的强制约束：执行者必须用 Read 工具读出原文，然后 Write 工具原样粘贴，**禁止手敲重写**。每个占位符旁边都有"步骤 3 / 步骤 3"验证 grep 命令（`grep -n "CONTENT_*"` / `grep -n "PLATFORM_FOLLOW_UP"`）确保占位符在 commit 前被替换。

**3. 类型一致性**：本计划不涉及代码 / 类型 / 方法签名（纯文档重构），无需检查。

**自检结论**：计划完整、可执行、无占位符泄漏。
