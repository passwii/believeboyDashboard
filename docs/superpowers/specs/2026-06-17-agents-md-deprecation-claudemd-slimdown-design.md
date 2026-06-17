# AGENTS.md 废弃 + CLAUDE.md 瘦身（CodeGraph 章节归一） — 设计文档

- 日期：2026-06-17
- 作者：Claude（brainstorming 阶段，用户拍板方案 A 激进瘦身）
- 状态：待用户审查 → 实施规划
- 关联：BEL-127 follow-up（仓库侧沉淀；平台侧 `workdir/AGENTS.md` 模板仍属平台 owner 事项，不在本 PR 范围）

## 1. 背景与目标

`d0bc950`（BEL-127 修复）把 `AGENTS.md` 和 `CLAUDE.md` 的 CodeGraph 章节都升级到 v0.9.9 "实测 + CLI/MCP 分流"版本，**但 AGENTS.md 的 §0-§D 5 段是 CLAUDE.md 同段落的精简复制**。两份文件头自承"以 CLAUDE.md 为准"，但仍是物理双份维护：

- 改一处规范必须改两处，否则立刻出现 diff 漂移
- AGENTS.md 的 137 行里有 71 行是 CodeGraph 重复（占总行数 52%）
- "实战经验 / 启动 Explore 代理时 / 本次实践沉淀"是**使用记录**而非**使用规范**——它们混在主规范里会持续膨胀

加上 `CLAUDE.md` 自身 503 行（§80-134 共 55 行是叙事段落，对"agent 不会主动调用"这种激励问题没帮助）——本次目标：

1. 消除 AGENTS.md §0-§D 与 CLAUDE.md §0-§D 的双份维护（**消除未来 diff 漂移风险**）
2. 把 `CLAUDE.md` 从 503 行瘦到 ≤450 行（实际 450 行 = 删 54 行 + 加 1 行指针；规格初稿"≤380"为早期估算错误，**任务 3 完成后修正为 ≤450**）
3. 把"实战经验 / 启动 Explore / 本次实践沉淀"从主规范剥离到 `docs/superpowers/lessons-learned/`
4. 仓库根只保留 1 份"agent 规范主权威"——`CLAUDE.md`；`AGENTS.md` 降级为平台 follow-up 记录

## 2. 范围

| 维度 | 在范围内 | 不在范围内 |
|---|---|---|
| 文件 | `AGENTS.md` / `CLAUDE.md` / `docs/superpowers/lessons-learned/codegraph-v099.md`（新） | `.github/pull_request_template.md` / `README.md` / `MOBILE_ADAPTATION_RULES.md` 等 |
| 章节 | AGENTS.md 的 CodeGraph §0-§D；CLAUDE.md 的 §80-134（4 段 55 行） | CLAUDE.md 的 §0-§D 主规范、§135-144 团队确认机制、§432+ Superpowers-ZH 章节、Project Overview 等 |
| 工作流 | 仓库内 .md 文件 | Multica 平台注入的 `workdir/AGENTS.md` 模板（BEL-127 平台侧 follow-up） |
| 索引 | — | `.codegraph/`（CodeGraph 索引健康由 `codegraph status .` 决定，与本文档无关） |

## 3. 目标状态

### 3.1 `AGENTS.md`：137 行 → ≤30 行

**保留**：
- 头注释（精简到 1 段：说明本文件 = 平台 follow-up 记录 + 仓库根级指针；**主权威是 CLAUDE.md**）
- `AGENTS.md:81-113` `## Platform follow-up` 全文（这正是 AGENTS.md 存在的核心原因，**一字不改**）
- `## Project Overview` 缩到 2-3 行（链向 `CLAUDE.md` 的 Project Overview）
- `## Quick Reference` 缩成纯指针表（CodeGraph → `CLAUDE.md §"CodeGraph 语义知识图谱"`）

**删除**：
- `AGENTS.md:9-79` 整个 CodeGraph 章节（71 行）
- 头注释中"与 `CLAUDE.md` 配合使用""以 `CLAUDE.md` 为准"的措辞（角色反转后不再需要）
- `Quick Reference` 中 CodeGraph 命令表（命令全在 CLAUDE.md）

**目标最终结构**（≤30 行）：

```markdown
# AGENTS.md

> **角色**：本文件只记录"Multica 平台工作流 follow-up"和"仓库根级指针"。
> 主权威是 [`CLAUDE.md`](./CLAUDE.md)（§"Superpowers-ZH / CodeGraph / Quick Reference"）。
> 本文件不再包含 CodeGraph / 流程规范（避免与 CLAUDE.md 双份维护）。

## Platform follow-up
（…Platform follow-up 全文保留，原 AGENTS.md:81-113 一字不改…）

## 仓库根指针
- **CodeGraph 规范** → CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"
- **Project Overview / Quick Reference** → CLAUDE.md
- **Superpowers 技能** → CLAUDE.md §"Superpowers-ZH 中文增强版"
```

### 3.2 `CLAUDE.md`：503 行 → ≤450 行

**保留（不动）**：
- `CLAUDE.md:1-12` 头注释 + 项目简介
- `CLAUDE.md:13-79` §0-§D 5 个表格（**实测版主规范**——命令、坑、工具名对照表，不能动）
- `CLAUDE.md:135-144` 团队确认机制（**保留**——这是 PR 流程强约束）
- `CLAUDE.md:145+` Project Overview / Quick Reference / Superpowers-ZH 章节（与本次范围无关）

**删除**（共 4 段 54 行）：

| 行号 | 章节 | 理由 | 去向 |
|---|---|---|---|
| `CLAUDE.md:80-103` | `### 调用示例` | 示例在 §0-§D 表格中已隐含，且 §80-103 实际就是 §0-§D 表格的展开版 | 迁到 `codegraph-v099.md §1` |
| `CLAUDE.md:105-117` | `### 实战经验（2026-06 起记录）` | 10 条实战经验是**使用记录**而非规范 | 迁到 `codegraph-v099.md §2` |
| `CLAUDE.md:118-121` | `### 启动 Explore 代理时` | 操作提示（agent prompt 模板），不是规范 | 迁到 `codegraph-v099.md §3` |
| `CLAUDE.md:122-134` | `### 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）` | 10 条 issue 沉淀（BEL-93/127/131 + login 实战 + impact 实战） | 迁到 `codegraph-v099.md §4` |

**文末新增 1 行指针**（紧跟 `### 团队确认机制` 段之前）：

```markdown
> 💡 **实战沉淀 / 启动提示 / BEL-93/127/131 沉淀** 已迁到 [`docs/superpowers/lessons-learned/codegraph-v099.md`](docs/superpowers/lessons-learned/codegraph-v099.md)。本文是规范，沉淀请去那边查。
```

### 3.3 新增 `docs/superpowers/lessons-learned/codegraph-v099.md`（约 70 行）

**文件不存在**——`docs/superpowers/` 下只有 `plans/` 和 `specs/` 两个子目录，**lessons-learned 目录在实施时新建**。

**结构**：

```markdown
# CodeGraph v0.9.9 使用沉淀（Lessons Learned）

- 日期：2026-06-17（从 CLAUDE.md 迁出）
- 关联：BEL-93 / BEL-127 / BEL-131 / d0bc950

> 本文是 lessons learned，**不是规范**。要看规范请回 [`CLAUDE.md §"CodeGraph 语义知识图谱"`](../../CLAUDE.md)。

## 1. 调用示例
（…原 CLAUDE.md:80-103 全文搬入，原文不动…）

## 2. 实战经验（2026-06 起记录）
（…原 CLAUDE.md:105-117 全文搬入，原文不动…）

## 3. 启动 Explore 代理时
（…原 CLAUDE.md:118-121 全文搬入，原文不动…）

## 4. 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）
（…原 CLAUDE.md:122-134 全文搬入，原文不动…）
```

**不变量**：迁出内容**逐字不动**，仅物理位置变更。原 §80-103 / §105-117 / §118-121 / §122-134 共 4 段合计 54 行原文 100% 保留在新文件 4 个章节中。

## 4. 行为变化（对 agent 实际看到什么）

| 场景 | 改前 | 改后 |
|---|---|---|
| agent 读 CLAUDE.md | 看 503 行（§0-§D + 实战 + 沉淀 + 团队机制） | 看 ≤450 行（§0-§D + 团队机制 + 文末指针） |
| agent 读 AGENTS.md | 看 137 行（含 CodeGraph 重复） | 看 ≤30 行（平台 follow-up + 仓库根指针） |
| agent 走 Multica 平台 workdir/AGENTS.md 注入模板 | 看到的是平台模板的 BEL-93 段（错的） | **不变**——本次不修平台侧（仍属 BEL-127 follow-up） |
| 改一份规范 | 必须改 CLAUDE.md + AGENTS.md 两份 | 改 CLAUDE.md 一份 |
| 查"实战经验/BEL-127 沉淀" | 翻 CLAUDE.md | 翻 `docs/superpowers/lessons-learned/codegraph-v099.md` |
| CI / PR 模板 | 4 个 CodeGraph checkbox 强制 | **不变**（本次不动 PR 模板） |

**关键不变量**：所有原内容不丢失，仅物理位置变更。

## 5. 验收 & 测试

### 5.1 人工验收（开 PR 前自检）

```bash
# 1. 行数检查
wc -l CLAUDE.md AGENTS.md docs/superpowers/lessons-learned/codegraph-v099.md
# 预期：CLAUDE.md ≤ 450（已修正：规格初稿写"≤380"为估算错误，任务 3 完成后实测 450 行 = 删 54 行 + 加 1 行指针），AGENTS.md ≤ 30，新文件 ≥ 50

# 2. 触动文件清单
git diff --stat main
# 预期：仅触及 3 个文件（CLAUDE.md / AGENTS.md / 新文件）

# 3. 沉淀内容不丢
grep -c "BEL-127" docs/superpowers/lessons-learned/codegraph-v099.md
# 预期：≥ 2（确认 BEL-127 沉淀段已搬入）

# 4. §0-§D 主规范不丢
git grep -c "codegraph query" CLAUDE.md
# 预期：≥ 5（§0-§D 表格中多处出现 codegraph query，确认表格没被误删）

# 5. 索引健康（与本文档无关，仅冒烟）
codegraph status .
# 预期："Index is up to date"
```

### 5.2 PR 模板自动验证

- `.github/pull_request_template.md` 不动 → 4 个 CodeGraph checkbox 仍存在
- 改后 PR 描述勾"已使用 CodeGraph 查询相关符号"等条目都还能正常勾

### 5.3 冒烟测试

- `git grep -n "codegraph" CLAUDE.md AGENTS.md` — 确认 §0-§D 命令未误删，AGENTS.md 残留只在指针行
- 读 CLAUDE.md 头 + AGENTS.md 头 + 新文件头 —— 三份文件的"角色声明"自洽（CLAUDE.md 是主权威，AGENTS.md 指向 CLAUDE.md，新文件指向 CLAUDE.md）

## 6. 风险 & 回滚

| 风险 | 概率 | 缓解 |
|---|---|---|
| agent 找不到 lessons-learned 路径 | 低 | CLAUDE.md 文末加 1 行指针（设计 §3.2 已包含） |
| AGENTS.md 砍太多导致 Platform follow-up 段上下文断裂 | 中 | Platform follow-up 段开头补 1 句"承接 CLAUDE.md §D 中关于 workdir 注入的说明" |
| 新人 onboarding 时只看 AGENTS.md 漏掉规范 | 低 | AGENTS.md 顶部加粗警告"主权威是 CLAUDE.md，请优先读 CLAUDE.md" |
| 误删 §0-§D 表格某行 | 低 | §0-§D 表格区域在 PR diff 重点 review 范围内（验收 §5.1 第 4 条已用 grep 兜底） |
| 迁出内容笔误 | 低 | 实施步骤用 Edit 工具的"整段搬移"而非"手敲重写"——直接从 CLAUDE.md 复制粘贴到新文件后用 Edit 删除原段 |

**回滚**：1 个 commit 即可全量还原（PR 是单 commit 单 PR，可 `git revert` 或 `git reset --hard HEAD^`）。

## 7. 实施步骤（5 步）

1. **读 CLAUDE.md:80-134 全文**（已完成，4 段共 54 行原文已读出）
2. **建目录** `docs/superpowers/lessons-learned/`
3. **创建** `docs/superpowers/lessons-learned/codegraph-v099.md`，把 §80-134 原文按 §1-§4 顺序写入，加文末"不是规范"声明
4. **编辑 CLAUDE.md**：删除 §80-134（4 段 54 行），在 `### 团队确认机制` 段前加 1 行 lessons-learned 指针
5. **重写 AGENTS.md**：保留 Platform follow-up（一字不改）+ Project Overview 缩到 2 行 + Quick Reference 缩成指针表 + 头注释精简 + CodeGraph 章节整段删除
6. **自检 + 提交 + 开 PR**（commit message: `docs(BEL-127 follow-up): 废弃 AGENTS.md 副本 + CLAUDE.md 瘦身到 §0-§D 主规范`）

## 8. 关联 & 后续

- **平台 follow-up**（不属本 PR 范围）：Multica 平台注入的 `workdir/AGENTS.md` 模板 BEL-93 段仍需平台 owner 配合修复——这条**保留**在 AGENTS.md 的 Platform follow-up 段中（即"AGENTS.md 唯一保留的非指针内容"）。
- **后续可清理**（不属本 PR）：当 lessons-learned 目录成熟后，可考虑把 `CLAUDE.md:135-144` 团队确认机制也迁过去，让 CLAUDE.md 进一步聚焦"agent 看到什么 = 主规范"。**本次不做**——避免一次 PR 触动太多。
- **关联 issue**：本设计文档解决"AGENTS.md 重复 / CLAUDE.md 膨胀"问题，与 BEL-93（CodeGraph 工具误用）/ BEL-127（workdir 模板错误）/ BEL-131（周报渲染 bug）三个 issue 关联但**不替代**——那 3 个 issue 的根因修复仍分别在各自 PR 中完成。
