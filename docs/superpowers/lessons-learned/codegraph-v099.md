# CodeGraph v0.9.9 使用沉淀（Lessons Learned）

- 日期：2026-06-17（从 CLAUDE.md §80-134 迁出）
- 关联：BEL-93 / BEL-127 / BEL-131 / d0bc950

> 本文是 lessons learned，**不是规范**。要看规范请回 [`CLAUDE.md`](../../../CLAUDE.md) §"CodeGraph 语义知识图谱（实测版 v0.9.9）"。

## 1. 调用示例

MCP（`mcp__codegraph__*` 带下划线）：

```
mcp__codegraph__codegraph_status
mcp__codegraph__codegraph_search query="ProductCost"
mcp__codegraph__codegraph_explore query="calculate_revenue 的调用链与所有实现"
mcp__codegraph__codegraph_node symbol="login" file="auth.py" line=82 includeCode=true
mcp__codegraph__codegraph_impact symbol="process_report" depth=2
```

CLI（带空格）：

```bash
cd believeboyDashboard
codegraph status .                         # 健康检查
codegraph init .                           # 首次 / 重建索引（-i 已 deprecated）
codegraph query ProductCost --kind function # 找符号位置
codegraph callers computeInvoiceTotal      # 谁调用
codegraph callees login                    # X 调用谁
codegraph impact process_report --depth 2  # 改前 blast radius
codegraph files --path .                   # 项目树
```

## 2. 实战经验（2026-06 起记录）

1. **MCP 环境首选 `codegraph_explore` 而非 `codegraph_search`**：后者只给 location，前者直接给 verbatim 源码，一次到位。`search` 适用于"我只想要 location 列表"（如 grep 替代）。
2. **CLI 环境用 `query` 拿到 `file:line` 后 `Read`**：这是 CLI 唯一拿源码的路径，绕不开——CLI 没有 `explore` 等价物。
3. **改函数前必跑 `codegraph impact`**：默认 depth=2，列出多层调用方。CLI 跑 `codegraph impact buildBackendAuthHeaders --depth 2` 实测返回 35 个 affected symbol（19 个直接 callers + 间接层）。MCP 跑 `mcp__codegraph__codegraph_impact symbol="computeInvoiceTotal" depth=2`，VAT 发票模块当时 3 处被引用（client + summary + pdf），改之前查一下能避免漏改。
4. **`.test.ts` 后缀的文件不被 codegraph 识别为"覆盖测试"**：`codegraph_explore` 的 blast radius 报告里会标 "⚠️ no covering tests found" — 这可能是误报，要人工核对。
5. **React 动态分派也能追**：`VatInvoiceClient` → `<SellerCard>` 的 JSX 渲染关系 codegraph 能识别，会在 `codegraph_explore` 输出里以 "Dynamic-dispatch links" 段单独列出。
6. **索引滞后约 1 秒**：写完代码后等几秒再查，否则可能漏新加的符号。如要即时确认可跑 `codegraph status .` 看 `Files indexed` 是否增加。
7. **MCP 静默/不可用时**：先在仓库根目录跑 `codegraph status .`；如果提示 `Not initialized`，执行 `codegraph init .`。如果工具报 "未注册" / `tool not registered`，说明当前 agent 没配 `mcpServers.codegraph`（在 `~/.claude/settings.json` 加 `mcpServers.codegraph` 段），回 §B 用 CLI。
8. **worktree / 新 checkout 路径不存在**：CodeGraph 索引是本地 `.codegraph/codegraph.db`，不会随 Git 提交；每次进入新的 Multica worktree、新建 worktree 或重建工作区后，都要重新执行 `codegraph status .`，必要时 `codegraph init .`。如果 `codegraph_files` / `mcp__codegraph__codegraph_files` 返回 "No files found matching the criteria"，先确认当前目录是仓库根，并且 `path` 传相对路径 `.`；不要用绝对路径试探。
9. **CLI 工具名 ≠ MCP 工具名**：`codegraph query` 对应 `mcp__codegraph__codegraph_search`（不是 `_query`）。MCP 那边 query 改名叫 search，习惯就好。
10. **`codegraph impact` 没有 `--limit`**（v0.9.9）：如果 blast radius 太大输出过长，先用 `codegraph callers <sym>` 看直接调用方，需要更深再 `impact`。

## 3. 启动 Explore 代理时

告诉 Explore 代理：定位代码先用 `codegraph query`（CLI）或 `mcp__codegraph__codegraph_explore`（MCP），只有在 CodeGraph 无结果时才 fallback 到 Read/Grep/Glob——**不要**让 agent 盲跑 `mcp__codegraph__*` 走 `command not found` 浪费回合。

## 4. 本次实践沉淀（BEL-93 / BEL-127 / BEL-131 综合）

1. **初始化/健康检查**：首次进入仓库先跑 `codegraph status .`（MCP 用 `mcp__codegraph__codegraph_status`）；若提示未初始化，在仓库根目录执行 `codegraph init .`（**不要加 `-i`，已 deprecated**）。
2. **文件树路径要用相对路径**：`codegraph_files` 的 `path` 参数传 `.` 或子目录（`backend` / `frontend`）；传绝对路径能跑但和文档约定不符。
3. **worktree 索引隔离**：每个 checkout/worktree 的 `.codegraph/` 都是本地索引，不随 Git 同步；换 worktree 后如果 CodeGraph 提示路径不存在、Not initialized 或查不到当前分支新增文件，先在本 worktree 根目录重新 `codegraph init .`。
4. **精准定位优先 `node` + `file/line`**（MCP）：`explore` 适合宽泛问题，但遇到 `Index` 这类泛名可能混入无关 blast radius；已知位置时用 `codegraph_node symbol="..." file="..." line=... includeCode=true` 看单个 body 最稳。CLI 没这个工具，只能 `codegraph query <sym>` 拿 `file:line` + `Read` 文件。
5. **前端登录入口实践（MCP）**：`mcp__codegraph__codegraph_search("login")` 找到 `frontend/app/login/page.tsx:6` 的 `LoginPage`，继续追到 `frontend/components/login/sign-in-card.tsx:67` 的 `handleSignIn`，其通过 `signIn("credentials", ...)` 发起登录。
6. **后端登录入口实践（MCP）**：同一个 `mcp__codegraph__codegraph_search("login")` 找到 `backend/app/api/v1/endpoints/auth.py:82` 的 `login`，`mcp__codegraph__codegraph_node includeCode=true` 显示它会先做 IP/邮箱限流，再查 `public.user_accounts`、校验密码、写审计日志并创建 Redis session。
7. **重构前必跑影响面**：对 `frontend/lib/backend-auth.ts:125` 的 `buildBackendAuthHeaders` 跑 `codegraph impact buildBackendAuthHeaders --depth 2`（CLI）↔ `mcp__codegraph__codegraph_impact symbol="buildBackendAuthHeaders" depth=2`（MCP），确认它被 admin users、AI chat、file upload、password、proxy/cache 等 19 个直接调用方使用，修改前需要覆盖这些路径。
8. **BEL-112 排查结论**：worktree 中"路径不存在"的常见根因是 `.codegraph/` 本地索引未初始化或 MCP/CLI 命令混淆（最常见是 bash 里跑 `mcp__codegraph__codegraph_status`）；修复动作是在当前 worktree 根目录执行 `codegraph status .`，必要时 `codegraph init .`，并在 PR/评论中记录 CodeGraph 不可用或 fallback 的原因。
9. **BEL-127 根因**：MCP 工具名（`codegraph_status`、`codegraph_explore` 等）被错当成 shell 命令让 agent 直接跑。修复要点：bash 里**只能**用 `codegraph <子命令>`（带空格）；MCP 工具**只能**用 `mcp__codegraph__*`（带下划线）从 agent 工具栏调用。两者绝对不要混用。本仓库 PR 范围内已修复；平台注入 `workdir/AGENTS.md` 模板的修复需 Multica 平台 owner 配合（见 `AGENTS.md` 的 Platform follow-up 段）。
10. **CLI 工具名映射**：`codegraph query` = `mcp__codegraph__codegraph_search`（**不是** `_query`）；`codegraph files` = `codegraph_files`；`codegraph status` / `callers` / `callees` / `impact` 名字一致。`explore` / `node` **只在 MCP 存在**，CLI 走 `query` + `Read` 凑。
11. **长期维护后更新索引（最佳实践）**：仓库经过大量改动（多文件新增 / 重构）或准备大范围改动前，先 `codegraph status .` 确认 `Files indexed` 是否跟上代码；若滞后跑 **`codegraph sync .`**（增量，快），不要用 `codegraph init .`（全量重建，慢）。`init` 只留给新 worktree / 索引缺失。`sync` 与 `init` 的区别：前者增量更新已有索引，后者从零重建。
