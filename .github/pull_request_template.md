## CodeGraph 使用确认

定位代码的"CodeGraph 工作流"包括 **MCP 工具**（`mcp__codegraph__*`）和 **CLI 工具**（`codegraph <子命令>`）两条路，**二选一即可**——按你当前 agent 环境挑能用的那条。

- [ ] 涉及代码定位、重构或 bug 修复时，已优先使用 CodeGraph：
  - MCP 环境：`mcp__codegraph__codegraph_explore` / `..._search` / `..._node`（**`explore` 和 `node` 是 MCP-only，CLI 无等价**）
  - 纯 CLI / 终端环境：`codegraph query <kw>` 拿 `file:line` → `Read` 文件；`codegraph callers|callees|impact <sym>` 看影响面
- [ ] 修改公共函数、hook、service、route 或 schema 前，已使用 `callers` / `callees` / `impact` 评估影响面（MCP 用 `mcp__codegraph__codegraph_callers|callees|impact`；CLI 用 `codegraph callers|callees|impact`）。
- [ ] 如 fallback 到 Read/Grep/Glob，请在 PR 描述中说明原因。
- [ ] 如 CodeGraph 在当前 worktree 不可用，请在 PR 描述中记录诊断命令（例如 `codegraph status .`）与处理结果。

## 变更说明

<!-- 简要说明本次变更、影响范围和验证方式 -->

## 验证

<!-- 说明已运行的测试、lint、手动验证或截图 -->
