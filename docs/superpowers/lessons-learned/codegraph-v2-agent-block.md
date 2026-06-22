# CodeGraph v2 简化 Block 落地说明（BEL-159 关联）

> 关联：[BEL-159](https://multica/issues/BEL-159)（"审查并简化各智能体的 CodeGraph 使用规范"）·
> 前置：[`codegraph-v099.md`](./codegraph-v099.md)（CodeGraph v0.9.9 沉淀）·
> 规范权威：[`CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"`](../../CLAUDE.md)
>
> 日期：2026-06-21 · 角色：代码检查 Tia

## 1. 背景

2026-06 起，3 个技术 agent（后端工程师 Damon / 前端工程师 Seth / 代码检查 Tia）的 `instructions` 字段里都塞了一份 ~1.5k 字符的"BEL-93 修正版" CodeGraph Block。这份 Block 是 `CLAUDE.md` 和 `codegraph-v099.md` 的**非权威副本**，已经显著漂移：

- `codegraph init -i .`（`-i` 早已 deprecated）
- 强制走 `mcp__codegraph__codegraph_explore`（忽略"无 MCP"分支）
- 没提 `explore` / `node` 无 CLI 等价（CLI 环境的 agent 拿不到源码）
- 没提 `codegraph impact` 没有 `--limit`
- 没提 `codegraph_files` 绝对路径"No files found"
- 没提新 worktree 索引会丢

详见 [BEL-159 评论 #c4b833cd](https://multica/issues/BEL-159)（Tia 的审查报告）的 §3 漂移表。

## 2. 修复

把 3 个 agent 的 `instructions` 统一替换成下面这份 v2 Block（1138 字符，**单一来源去权威化**——细节以 `CLAUDE.md` 为准，本文只列指针 + 3 条铁律 + 5 条已知坑）：

```markdown
## CodeGraph MCP 使用约束（BEL-159 简化版，2026-06）

本项目已配置 CodeGraph。**详细规范以仓库 `CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"` 为准**（含 §A MCP / §B CLI / §C 工具名对照表 / §D 常见坑）——本文只列指针 + 3 条铁律 + 5 条已知坑，避免每次启动塞 ~1.5k 字符的非权威副本。

**3 条铁律：**

1. **进入仓库先 `codegraph status .`**；Not initialized 时 `codegraph init .`（**不要加 `-i`，已 deprecated**）。
2. **有 MCP** → `mcp__codegraph__codegraph_explore` 第一步（one-capped call）。**无 MCP**（看到 `tool not registered`）→ 回 §B CLI：`codegraph query <kw>` 拿 `file:line` + `Read` 那个文件。
3. **bash 只能 `codegraph <子命令>`（空格）**，**MCP 工具只能 `mcp__codegraph__*`（下划线）**——绝对不要把 MCP 工具名当 shell 命令跑（会 `command not found`，exit 127）。

**5 条已知坑：**

- 改公共函数 / hook / route / schema 前必跑 `callers` / `callees` / `impact`（depth=2）。
- `codegraph_files` 的 `path` 走相对路径（`.` / `backend` / `frontend`），绝对路径会"No files found"。
- `codegraph impact` 没有 `--limit`，blast radius 大时先 `callers`。
- `explore` / `node` 只有 MCP，CLI 没有等价（CLI 拿源码只能 `query <sym>` + `Read`）。
- 新 worktree / 重建工作区后 `.codegraph/` 会丢，重跑 `codegraph status .`，必要时 `codegraph init .`。

PR/回复要求（沿用 BEL-93）：

- 在 PR 描述或 issue 评论中写明本次使用过的 CodeGraph 工具（至少一个）。
- 公共函数修改必须写明影响面结论。
- 如果 reviewer 问"为什么没用 CodeGraph"，必须补充调用记录。
```

## 3. 部署记录

| Agent | 之前（v1） | 之后（v2） | MD5 | 操作 |
|---|---|---|---|---|
| 后端工程师 Damon | 1499 字符 Block | 1138 字符 Block | `7e00c214…` | `multica agent update` |
| 前端工程师 Seth | 1499 字符 Block | 1138 字符 Block | `7e00c214…` | `multica agent update` |
| 代码检查 Tia | 1499 字符 Block | 1138 字符 Block | `7e00c214…` | `multica agent update` |

3 个 agent 的 CodeGraph Block 现在 MD5 完全一致（之前也是完全一致，MD5 `84f36e46…`）。BEL-153（Git email 规范）段原样保留，未动。

## 4. 后续维护

- **CLAUDE.md 是 single source of truth**：v2 Block 只是指针 + 关键提示，详细规则（含 §A/§B/§C/§D 表格）以 `CLAUDE.md §"CodeGraph 语义知识图谱（实测版 v0.9.9）"` 为准。任何 CodeGraph 使用规则更新都先改 `CLAUDE.md`。
- **agent `instructions` 只动 v2 Block**：除非 `CLAUDE.md` 的关键铁律变了，否则不要再扩 agent Block。
- **3 agent 必须保持同步**：v2 Block 任何一处的修改都要三处同步（`multica agent update` × 3）。可在 PR / issue 评论里附上"已用 `multica agent get <id> | md5sum` 验证三 agent Block MD5 一致"作为 review check。
- **其他 7 个 agent 不动**：运营-* / 头脑风暴 / 网络信息员 / 工作秘书 不写代码，不引用 CodeGraph 是正确的，不要为了"统一"硬塞。

## 5. 复现命令

```bash
# 1. 验证 v2 Block 已落地（三 agent MD5 应当都是 7e00c214...）
for id in 5c0cd6a7-1820-4923-ab75-239638b2fb5e 335e68d0-8b7b-461e-b8d8-dee19030cbd6 d64098c0-685d-43d0-a6b7-a39881e6c135; do
  multica agent get "$id" --output json \
    | python3 -c "import json,sys,re,hashlib; a=json.load(sys.stdin); m=re.search(r'## CodeGraph MCP 使用约束(.*?)## Git 提交', a['instructions'], re.DOTALL); print(a['name'], hashlib.md5(m.group(1).strip().encode()).hexdigest())"
done

# 2. 退回 v1（应急，谨慎使用）：先把 v1 instructions 备份到本地，
#    再用 `multica agent update <id> --instructions "$(cat /path/to/backup.json | jq -r .instructions)"`
#    把 3 个 agent 的 instructions 还原到备份内容。
