# AGENTS.md

> 本文件是仓库根的 agent 指引，**与 `CLAUDE.md` 配合使用**。当两者内容冲突时，以 `CLAUDE.md` 为准（`CLAUDE.md` 是仓库的"主权威"指引，文件更早出现、覆盖更广；本文件只补充 BEL-127 修复范围内的内容）。
>
> **重要**：本仓库还在 Multica 平台工作流中运行，平台会向 workdir 注入自己的 `AGENTS.md` 模板。**注入的模板会覆盖本文件**——这是平台行为，本仓库目前无法绕开。所以**仅靠本文件无法修复 BEL-127 根因**，根因需要平台侧改 `workdir/AGENTS.md` 模板（见 BEL-127 评论、PR 描述与 [platform follow-up](#platform-follow-up) 段）。本文件作为文档沉淀和兜底，任何**只读 workdir 中 `AGENTS.md` 而不会读到仓库根 `AGENTS.md` 的 agent** 看不到这里的内容。

---

## CodeGraph 使用规范（BEL-127 修复 + 实测版）

本仓库已配置 CodeGraph v0.9.9。下面按"你能用什么工具"分流——**MCP agent 看 §A；只剩 CLI 看 §B**。本节所有命令均经过实测。

### §0 一次性健康检查（必跑）

```bash
codegraph status .   # `.` 可省；看到 "Index is up to date" 即可
```

- 若提示 `Not initialized`：在仓库根 `codegraph init .`（**`-i` 已 deprecated，不用加**）。
- **新 worktree / 重建工作区后必须重跑**——`.codegraph/` 不入 Git，本地索引会丢。
- CLI 在仓库根目录运行；`codegraph status backend` 也能跑（用当前目录的索引）。

### §A MCP agent 路径（Claude Code / Cursor / Codex / 装了 `mcpServers.codegraph` 的 agent）

工具名 = `mcp__codegraph__*`（**带下划线**，那是 MCP 工具名）。

| 意图 | 工具 |
|---|---|
| "X 怎么工作 / 架构 / 某 bug / X 在哪 / 概览某模块" | `mcp__codegraph__codegraph_explore`（主路径，one-capped call） |
| 只要 location 列表 | `mcp__codegraph__codegraph_search` |
| 看单个符号完整 body / 重载 / 精确消歧 | `mcp__codegraph__codegraph_node`（带 `file` + `line` 消歧） |
| 谁调用 / X 调用谁 / 改 X 会破什么 | `mcp__codegraph__codegraph_callers` / `..._callees` / `..._impact`（depth=2） |
| 浏览项目树 | `mcp__codegraph__codegraph_files`（`path` 传相对目录，如 `.` / `backend`） |
| 索引健康 | `mcp__codegraph__codegraph_status` |

如果 agent 报"tool not registered"或"未注册"，说明本环境**没有 MCP**，回到 §B。

### §B 纯 CLI 路径（ZCode / 无 MCP 的 agent / 在终端里）

工具 = `codegraph <子命令>`（**带空格**）。**`explore` 和 `node` 没有 CLI 等价**——这是 BEL-127 之后实测确认的最大坑。

| 意图 | CLI 命令 | 备注 |
|---|---|---|
| 索引健康 | `codegraph status .` | `.` 可省 |
| 找符号位置 | `codegraph query <kw> --kind <kind>` | **只返回 location，不带源码**——这是 CLI 故意行为 |
| 看一个符号的源码 | `codegraph query <sym>` 拿到 `file:line` → 用 `Read` 工具看那个文件 | CLI 唯一办法；可用 `--limit` 控制结果数 |
| 谁调用 | `codegraph callers <sym>` | `--limit` 默认 20 |
| X 调用谁 | `codegraph callees <sym>` | |
| 改前 blast radius | `codegraph impact <sym>` | 默认 `--depth 2` |
| 浏览项目树 | `codegraph files --path .` | `--path` 传相对目录（`backend` / `frontend`），绝对路径也能跑 |
| 重新建索引 | `codegraph init .` 或 `codegraph index .` | 第一次用 `init`；只想增量更新用 `sync` |

### §C 工具名对照表（CLI ↔ MCP）

| CLI（`codegraph <子命令>`） | MCP 工具 | 等价？ |
|---|---|---|
| `codegraph status [path]` | `codegraph_status` | ✓ |
| `codegraph query <kw>` | `codegraph_search` | ✓（CLI 名是 `query`，MCP 名是 `search`，名字不一样但行为一致） |
| `codegraph callers <sym>` | `codegraph_callers` | ✓ |
| `codegraph callees <sym>` | `codegraph_callees` | ✓ |
| `codegraph impact <sym>` | `codegraph_impact` | ✓ |
| `codegraph files --path X` | `codegraph_files` | ✓ |
| **—** | **`codegraph_explore`** | **❌ 无 CLI 等价** |
| **—** | **`codegraph_node`** | **❌ 无 CLI 等价**（重载消歧只能 Read 文件确认） |

**核心结论**：`explore` 和 `node` 是 MCP-only。CLI 用户拿不到"一次调用返回所有相关符号源码"的能力，只能 `query` + `Read` 手动凑。

### §D 常见坑（实测踩过的）

1. **`command not found`** → 你在 bash 里跑了 MCP 工具名。换成 `codegraph <子命令>`（带空格）即可。
2. **`codegraph query foo` 没源码** → CLI 故意只给 location。想看源码：`Read <file:line>`。
3. **`codegraph_explore` / `codegraph_node` 没有 CLI** → 别试 `codegraph explore`（`command not found`）。要么换 MCP 环境，要么 `query` + `Read`。
4. **`codegraph files --path /abs/path` 报错** → 实测现在能跑，但建议传相对目录（`.` / `backend`）以保持稳定。
5. **新 worktree 索引丢失** → `.codegraph/` 不入 Git，worktree 切完必须 `codegraph status .` 重新确认。
6. **`.test.ts` 后缀不被识别为覆盖测试** → `codegraph_explore` 的 blast radius 会标 "⚠️ no covering tests found"——可能是误报，人工核对。
7. **索引滞后约 1 秒** → 写完代码等几秒再查，否则可能漏新加的符号。
8. **环境判断不准** → 看到 `command not found` 先怀疑你跑错了形式；看到 `tool not registered` 说明是纯 CLI 环境——两种错法对应两种修法。

---

## Platform follow-up

BEL-127 的根因是平台注入的 `workdir/AGENTS.md` 模板（BEL-93 段）写错了——它把 MCP 工具名（`codegraph_status`、`codegraph_explore` 等）当成 shell 命令让 agent 直接跑。仓库内任何文档（包括本文件）都**无法**修复这个根因，因为平台每次启动会**覆盖** `workdir/AGENTS.md`。

**给平台 owner 的修复建议**（平台 `workdir/AGENTS.md` 注入模板 BEL-93 段第 1-6 条替换为以下内容）：

```text
本项目已配置 CodeGraph v0.9.9。

§0 健康检查（必跑）
  codegraph status .            # 看到 "Index is up to date" 即可；. 可省
  # Not initialized 时：codegraph init . （-i 已 deprecated）

§A MCP agent 路径（已配 mcpServers.codegraph 时用）
  主工具：mcp__codegraph__codegraph_explore（架构/工作流/位置 第一步）
  其它：mcp__codegraph__codegraph_search | _node | _callers | _callees |
        _impact | _files | _status
  注意：工具名带下划线；看到 "tool not registered" 跳到 §B

§B 纯 CLI 路径（无 MCP 时用 / 在终端里）
  codegraph status .            # 健康检查
  codegraph query <kw>          # 找符号位置（只 location，不带源码）
  codegraph callers|callees|impact <sym>   # 影响面
  codegraph files --path .      # 项目树
  说明：explore / node 没有 CLI 等价；想看源码就 Read <file:line>

§C 常见坑
  - bash 里跑 mcp__codegraph__* 会 command not found → 改 codegraph <子命令>
  - codegraph query 只给 location → 想要源码用 Read 工具
  - 新 worktree 索引隔离 → 重新 codegraph init .
```

该改动**不在本仓库 PR 范围内**，需要单独联系 Multica 平台 owner。仓库侧能做的是把本文件 + `CLAUDE.md` 的 CodeGraph 章节写成"实测 + 分流"版本，让任何走不到 `workdir/AGENTS.md` 模板的 agent 也能找到正确路径。

## Project Overview

`believeboyDashboard` 是公司内部的销售/库存/AI 看板系统，仓库结构（详细见 `CLAUDE.md`）：

- `frontend/` — Next.js 14 App Router 前端
- `backend/` — FastAPI + PostgreSQL + Redis 后端
- `autoReportUpload/` — 桌面端 Excel 报表上传与字段识别
- `productEnvAgent/` — 本地产品/环境 agent
- `docs/` — 架构与运维文档

## Quick Reference

- **进入仓库**：
  - CLI: `codegraph status .`（确认索引健康；新 worktree 跑 `codegraph init .`）
  - MCP: `mcp__codegraph__codegraph_status`
- **定位代码**：
  - 有 MCP → `mcp__codegraph__codegraph_explore`（主） / `..._search`（仅 location） / `..._node`（单符号 body）
  - 只有 CLI → `codegraph query <kw>` 拿 `file:line` → `Read` 那个文件
- **改前影响面**：
  - `codegraph callers|callees|impact <sym>`（CLI）↔ `mcp__codegraph__codegraph_callers|callees|impact`（MCP），默认 depth=2
- **PR 模板**：`.github/pull_request_template.md` 强制 CodeGraph 使用确认（CLI 或 MCP 都算）
- **测试**：`backend/` 用 pytest，`frontend/` 用 vitest，CI 在 `.github/workflows/`
- **完整文档**：本文件是简化版；详细工具表、实战经验、PR 模板说明见 `CLAUDE.md` 的 "CodeGraph 语义知识图谱" 章节
