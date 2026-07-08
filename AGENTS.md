# AGENTS.md

> **角色**：本文件是 **ZCode 加载的仓库指令文件**（ZCode 只读 `AGENTS.md`，**不会自动读 `CLAUDE.md`**）。
> 因此"CodeGraph 代码定位指令"必须直接落在下面本节，不能只靠 CLAUDE.md 的链接；完整规范仍以 [`CLAUDE.md`](./CLAUDE.md) 为权威。
> 另记"Multica 平台工作流 follow-up"与"仓库根级指针"。

## CodeGraph：代码定位默认用这个（ZCode / 仓库 agent 必读）

> ⚠️ **环境事实**：本仓库的 ZCode / 无 MCP 的 agent 只有 **CLI**（`codegraph <子命令>` 带空格）。`mcp__codegraph__*` 是 MCP 工具名，**在 bash 里跑会 `command not found`**。下面全部走 CLI 路径。

### 强制指令（覆盖"先 grep / Glob / Read 全文扫描"的默认习惯）

**定位任何代码时，先用 CodeGraph，再用 Read：**
1. `codegraph status .` 确认索引健康（看到 "Index is up to date" 即可；`.` 可省）。
2. 用下面命令拿到 `file:line`。
3. **拿到位置后才用 `Read <file:line>` 看源码**——不要先大面积 Read / grep 扫描。
4. 只有 CodeGraph 确实给不出答案，才回退到 grep / Glob / Read。

### 本环境实测可用的 CLI（ZCode 走这条）

```bash
codegraph status .                       # 健康检查；. 可省
codegraph query <符号名> --kind <kind>    # 找位置（只返 file:line，不带源码）
codegraph callers <符号名>                # 谁调用它（--limit 默认 20）
codegraph callees <符号名>               # 它调用谁
codegraph impact <符号名>                 # 改它的 blast radius（无 --limit，输出可能很长）
codegraph files --path <相对目录>         # 浏览项目树（. / backend / frontend）
```

### 必记的坑（实测）

- **`explore` / `node` 没有 CLI 等价** → 别跑 `codegraph explore`，会 `command not found`（这是 MCP-only）。
- **`query` 只给位置** → 想看源码就 `Read` 那个 `file:line`。
- **新 worktree / 重建工作区后索引会丢** → `.codegraph/` 不入 Git，必须重跑 `codegraph status .`，必要时 `codegraph init .`。
- 写代码后等约 1 秒再查，避免漏新符号；即时确认可看 `status` 的 `Files indexed`。
- `query` 是按**符号名**匹配，不是文件路径/模糊子串（如 `query <文件路径>` 会 No results）。

### 长期维护后更新索引（最佳实践）

仓库经过大量改动（多文件新增 / 重构）或准备大范围改动**前**，先 `codegraph status .` 确认 `Files indexed` 是否跟上代码；若滞后就跑 **`codegraph sync .`**（增量更新，快），**不要用 `codegraph init .`**（全量重建，慢）。`init` 只留给新 worktree / 索引缺失的场景。

完整命令对照、MCP 路径（Claude Code / Cursor / Codex）、全部坑 → [`CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"`](./CLAUDE.md)。

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

## 仓库根指针

- **CodeGraph 规范** → [CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"](./CLAUDE.md)
- **Project Overview / Quick Reference** → [CLAUDE.md](./CLAUDE.md)
- **Superpowers 技能** → [CLAUDE.md §"Superpowers-ZH 中文增强版"](./CLAUDE.md)
- **autoReportUpload HTTP ingest 计划** → [`docs/superpowers/plans/2026-07-02-auto-report-http-ingest.md`](./docs/superpowers/plans/2026-07-02-auto-report-http-ingest.md)
