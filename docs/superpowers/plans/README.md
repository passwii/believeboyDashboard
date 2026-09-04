# Plans 目录约定

> **适用对象：** `docs/superpowers/plans/` 下所有 plan 文档（人类 + 子智能体）。
> **确立时间：** 2026-07-12
> **首例：** [`2026-07-11-frontend-motion-system`](./2026-07-11-frontend-motion-system/)（commit `614fbaf4`，已 push origin/main）
> **配套引用：** [AGENTS.md](../../AGENTS.md) "关键约定" 段 + [.claude/skills/writing-plans/SKILL.md](../../.claude/skills/writing-plans/SKILL.md) "计划保存位置"

---

## 一、命名规则

### 平铺 plan（默认，单文件足够时）

```
docs/superpowers/plans/
└── YYYY-MM-DD-<feature-name>.md          ← 主 plan
```

例：`2026-07-02-auto-report-http-ingest.md`、`2026-07-09-customer-service.md`

### 子目录 plan（plan 会被拆成多文件时）

```
docs/superpowers/plans/
└── YYYY-MM-DD-<feature-name>/             ← 子目录名 = 主 plan 文件的 basename（去掉 .md）
    ├── YYYY-MM-DD-<feature-name>.md       ← 主 plan（与子目录同名）
    ├── YYYY-MM-DD-<feature-name>-phase0.md
    ├── YYYY-MM-DD-<feature-name>-phase1.md
    ├── ...
    ├── YYYY-MM-DD-<feature-name>-v2-...md          ← 调研报告（可选）
    └── YYYY-MM-DD-<feature-name>-pr-description.md ← PR 描述（可选）
```

**规则：**
- **子目录名** = 主 plan 文件的 basename（去掉 `.md`），保留完整日期前缀
- **子目录内文件名**保留完整日期前缀（保持"自描述"，避免 git rename 时路径歧义）
- **拆分粒度自由**：phase / 调研 / PR 描述 / follow-up / implementation-review / 任何你认为有助于回看的子文档

---

## 二、二态规则：进行中 vs 已完成

| 状态 | 文件位置 | 说明 |
|------|----------|------|
| **进行中** | 平铺在 `docs/superpowers/plans/`（或子目录，取决于你建 plan 时的选择） | 子智能体按节奏持续往 plan 根目录写新文件 |
| **已完成** | 归集到 `docs/superpowers/plans/YYYY-MM-DD-<slug>/` 子目录 | 完成那一刻一次性 `git mv` + 内部引用更新 + `index.md` 收尾 |

**"完成"判定（满足任一即可）：**
- 最后阶段（最后一个 phase / follow-up / implementation-review）顶部明确写 `> **状态：** ✅ **完成**`
- 全部相关 git tag 已 push 到 remote
- PR 已 merge 或已创建等待合并

**为什么二态：**
- 进行中 plan 不强制归集：避免打扰正在按节奏推进的子智能体
- 已完成 plan 归集：完成态凝固，便于历史回看（git blame / 阶段检索 / PR 引用）
- **下一个新 plan 起**：建议**从一开始就建子目录**（主 plan + 所有 phase 直接进子目录，避免"完成时迁移"那次破坏性 git mv）

---

## 三、归集操作清单（已完成 plan 的收尾动作）

按顺序执行，一次 commit 收尾。

### 步骤 1：准备

```bash
# 确认所有相关文件已 commit（working tree 干净）
git status docs/superpowers/plans/
```

### 步骤 2：创建子目录 + `git mv`

```bash
SLUG="2026-07-11-frontend-motion-system"   # 替换为实际 slug
mkdir -p docs/superpowers/plans/${SLUG}/
git mv docs/superpowers/plans/${SLUG}*.md docs/superpowers/plans/${SLUG}/
```

**为什么 `git mv` 而非 `mv`：** 保留 git rename detection（默认 >50% similarity），`git log --follow` 与 blame 仍能追溯原历史。

### 步骤 3：写子目录 `index.md`

子目录入口，至少含以下 5 个段：
1. **状态 + 分支 + 日期**（一行元信息）
2. **入口表**（主 plan + PR 描述）
3. **Phase 进度表**（所有 phase + 状态 + 主题）
4. **Git tag 清单**（所有相关 tag）
5. **外部关联**（用户文档 / CHANGELOG / CI）
6. **数据快照**（commit 数 / 测试数 / token 数 等关键数字）

### 步骤 4：同步更新交叉引用

归集会让"指向这些文件的路径"全部失效。同步更新三处：

- **子目录内**：所有 phase 文件第 3 行的"父 plan"引用 + 各 phase 之间的"详细任务在 `xxx-phaseN.md`"指引
- **子目录外**：`frontend/docs/...`、`backend/docs/...` 等所有指向这些文件的 markdown 链接与文字引用（`grep -rn 'docs/superpowers/plans/<slug>'` 找全）
- **shell 命令**：phase 文档里 `--body-file <path>` / `cat <path>` 等命令文本（用户复制粘贴用，路径错了会踩坑）

**替换模式：**

```
docs/superpowers/plans/<basename>
  → docs/superpowers/plans/<slug>/<basename>
```

例：`docs/superpowers/plans/2026-07-11-frontend-motion-system-phase0.md` → `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase0.md`

### 步骤 5：验证（无残留旧引用）

```bash
# 全仓扫旧路径残留（应为空）
grep -rn "docs/superpowers/plans/<slug>[^/]" --include="*.md" .
```

### 步骤 6：提交 + 推送

```bash
git add docs/superpowers/ <其他改动路径>
git commit -m "docs(plans): 归集 <feature-name> 已完成 plan 到子目录"
git push origin main
```

按 AGENTS.md push 规则：本次 commit 不涉及 `backend/`，pre-push hook 会自动跳过 VPS 部署。

---

## 四、过渡期：暂不归集的进行中 plan

B2 策略下，下表里的 plan 是"已完成判定标准未满足"的实例，**暂不强制归集**。新写 plan 应直接采用子目录形式（见第二节末尾）。

| Plan slug | 当前文件 | 状态 |
|-----------|----------|------|
| `2026-07-10-ai-chat-pydantic-ai-native` | 主 + phase1 + tracker + phase2（待起草） | 进行中 |
| `2026-07-10-scheduled-report-to-celery` | 主 + follow-up + implementation-review（待写） | 进行中 |

---

## 五、相关引用

- **仓库级全局约定**：[AGENTS.md](../../AGENTS.md) "关键约定" 段
- **写新 plan 时引用**：[.claude/skills/writing-plans/SKILL.md](../../.claude/skills/writing-plans/SKILL.md) "计划保存位置"
- **首例操作 commit**：`614fbaf4 docs(plans): 归集 frontend-motion-system 已完成 plan 到子目录`

---

## 变更记录

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-07-12 | 确立本约定 + 首例归集 frontend-motion-system | 用户拍板 B2 策略 |