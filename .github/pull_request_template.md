## CodeGraph 使用确认

- [ ] 涉及代码定位、重构或 bug 修复时，已优先使用 CodeGraph（`mcp__codegraph__codegraph_explore` / `mcp__codegraph__codegraph_search` / `mcp__codegraph__codegraph_node`）。
- [ ] 修改公共函数、hook、service、route 或 schema 前，已使用 `mcp__codegraph__codegraph_callers` / `mcp__codegraph__codegraph_callees` / `mcp__codegraph__codegraph_impact` 评估影响面。
- [ ] 如 fallback 到 Read/Grep/Glob，请在 PR 描述中说明原因。
- [ ] 如 CodeGraph 在当前 worktree 不可用，请在 PR 描述中记录诊断命令（例如 `codegraph status .`）与处理结果。

## 变更说明

<!-- 简要说明本次变更、影响范围和验证方式 -->

## 验证

<!-- 说明已运行的测试、lint、手动验证或截图 -->
