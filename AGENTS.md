# AGENTS.md

> **角色**：本文件只记录"Multica 平台工作流 follow-up"和"仓库根级指针"。
> 主权威是 [`CLAUDE.md`](./CLAUDE.md)（§"Superpowers-ZH / CodeGraph / Quick Reference"）。
> 本文件不再包含 CodeGraph / 流程规范（避免与 CLAUDE.md 双份维护）。

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
