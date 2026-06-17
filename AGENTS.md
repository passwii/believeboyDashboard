# AGENTS.md

> 本文件是仓库根的 agent 指引，**与 `CLAUDE.md` 配合使用**。当两者内容冲突时，以 `CLAUDE.md` 为准（`CLAUDE.md` 是仓库的"主权威"指引，文件更早出现、覆盖更广；本文件只补充 BEL-127 修复范围内的内容）。
>
> **重要**：本仓库还在 Multica 平台工作流中运行，平台会向 workdir 注入自己的 `AGENTS.md` 模板。**注入的模板会覆盖本文件**——这是平台行为，本仓库目前无法绕开。所以**仅靠本文件无法修复 BEL-127 根因**，根因需要平台侧改 `workdir/AGENTS.md` 模板（见 BEL-127 评论、PR 描述与 [platform follow-up](#platform-follow-up) 段）。本文件作为文档沉淀和兜底，任何**只读 workdir 中 `AGENTS.md` 而不会读到仓库根 `AGENTS.md` 的 agent** 看不到这里的内容。

---

## CodeGraph 使用规范（BEL-127 修复）

本项目已配置 CodeGraph，**通过 MCP server 暴露给 agent**。CodeGraph 工具在 shell 里跑是 **CLI 子命令**（带空格），在 MCP / Claude Code 中调用是 **`mcp__codegraph__*` 工具名**（带下划线）。**两者不要混用**——混用是 BEL-127 报错的根因（`codegraph_status: command not found`）。

### 正确的调用方式

1. **进入仓库先确认索引健康**：
   - 终端/CLI：`codegraph status .`（带路径 `.`，否则找不到仓库根）
   - MCP agent：`mcp__codegraph__codegraph_status`（带下划线，那是 MCP 工具名）
   - 若提示 `Not initialized`：在仓库根执行 `codegraph init -i .`
2. **"X 怎么工作 / 架构 / 某 bug / X 在哪 / 模块概览"**：优先 `mcp__codegraph__codegraph_explore`（一次调用给清符号集合，多数情况下 one-capped call 就够）。
3. **只要 location**：`mcp__codegraph__codegraph_search`；CLI 等价 `codegraph query <kw>`。
4. **看单个符号的完整 body / 重载 / 精确消歧**：`mcp__codegraph__codegraph_node`，尽量带 `file` 和 `line`（`explore` 被 token 限制裁剪时用）。
5. **改公共函数、hook、service、route、schema、API 工厂前**（必跑）：`mcp__codegraph__codegraph_callers`、`mcp__codegraph__codegraph_callees`、`mcp__codegraph__codegraph_impact`，默认 `depth=2`；CLI 等价 `codegraph callers <sym>` / `codegraph callees <sym>` / `codegraph impact <sym>`。
6. **浏览项目树**：`mcp__codegraph__codegraph_files`，`path` 传相对路径 `.`（**不要传绝对路径**，会命中 "No files found matching the criteria"）；CLI 等价 `codegraph files --path .`。
7. **fallback**：只有 CodeGraph 无结果或需要确认具体上下文时，才用 Read/Grep/Glob，并在 issue/PR 中说明原因。

### 反例（**绝对不要**这样写）

```bash
# ❌ 这些不是 shell 命令，bash 会报 `command not found`（exit 127）
codegraph_status
codegraph_explore query="..."
codegraph_search ProductCost
codegraph_node symbol=...
codegraph_files
codegraph_callers foo
```

看到 `command not found` 报错就改用 `codegraph <子命令>`（带空格）的 CLI 形式。

### 仓库权威指引

详细工具表、MCP 调用示例、实战经验见 `CLAUDE.md` 中 "CodeGraph 语义知识图谱" 章节；本文件是 BEL-127 修复的最小化版本。

---

## Platform follow-up

BEL-127 的根因是平台注入的 `workdir/AGENTS.md` 模板（BEL-93 段）写错了——它把 MCP 工具名（`codegraph_status`、`codegraph_explore` 等）当成 shell 命令让 agent 直接跑。仓库内任何文档（包括本文件）都**无法**修复这个根因，因为平台每次启动会**覆盖** `workdir/AGENTS.md`。

需要平台维护者改的是 `workdir/AGENTS.md` 注入模板的 BEL-93 段第 1-6 条，替换为本文件 "正确的调用方式" 段的内容。该改动**不在本仓库 PR 范围内**，需要单独联系 Multica 平台 owner。

## Project Overview

`believeboyDashboard` 是公司内部的销售/库存/AI 看板系统，仓库结构（详细见 `CLAUDE.md`）：

- `frontend/` — Next.js 14 App Router 前端
- `backend/` — FastAPI + PostgreSQL + Redis 后端
- `autoReportUpload/` — 桌面端 Excel 报表上传与字段识别
- `productEnvAgent/` — 本地产品/环境 agent
- `docs/` — 架构与运维文档

## Quick Reference

- **进入仓库**：`codegraph status .` 确认索引健康；首次进入新 worktree 跑 `codegraph init -i .`
- **定位代码**：`mcp__codegraph__codegraph_explore` 第一步；需要 location 用 `mcp__codegraph__codegraph_search`；需要完整 body 用 `mcp__codegraph__codegraph_node`
- **改前影响面**：`mcp__codegraph__codegraph_callers` / `mcp__codegraph__codegraph_callees` / `mcp__codegraph__codegraph_impact`（depth=2）
- **PR 模板**：`.github/pull_request_template.md` 强制 CodeGraph 使用确认
- **测试**：`backend/` 用 pytest，`frontend/` 用 vitest，CI 在 `.github/workflows/`
