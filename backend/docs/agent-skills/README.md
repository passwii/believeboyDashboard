# Agent Skills（业务域调用方法 · 固化副本）

> 本目录是 **Multica workspace skill 的本地固化副本**（双写维护）。
> 仓库文件 = 权威副本；Multica 里的 skill 内容与此处保持一致。

## 用途

每个文件对应一个 `believeboy-*` workspace skill：把 BelieveBoy Agent API 某个业务域的**调用方法**（鉴权 / 项目解析 / 端点 / 参数 / 响应要点 / 已知坑）写成可分配、可执行的 skill，按角色绑定给各个 Multica agent。

## 命名与约定

- **文件名 / skill 名**：`believeboy-<业务域>`，业务域与后端 Agent API 路由域一一对应（权威索引见 [BLF-479](https://multica.ai/issues/8b9ad3e7-ebd2-4f5c-a4ea-d99f362db5c0)「Agent API 设计汇总」）
- **env 变量名（统一三件套）**：`AGENT_KEY`（明文 Key）/ `AGENT_ID`（X-Agent-Id 业务主键）/ `API_BASE`（Base URL，可省略走默认 `https://dash-api.believeboy.com/api/v1/agent`）
- **凭据纪律**：skill 内**禁止**写明文 Key——方法进 skill，凭据进各 agent 的 `custom_env`（skill 是共享制品，会分配给多个 agent）

## 文件清单

| 文件 | 业务域 | 路由数 | 说明 |
|---|---|---|---|
| `believeboy-sku-info.md` | sku-info（商品主数据） | 6（读3+写3） | R1 列表 / R2 详情 / R3 审计 / W1 upsert / W2 成本 / W3 上下架（写走 confirm 两步） |
| `believeboy-inventory-ledger.md` | inventory-ledger（库存台账） | 10（纯读） | months/snapshot/events/receipt-clusters/integrity/trend/detail/summary/batches/consistency；含已知线上 bug 与规避 |
| `believeboy-replenishment-analysis.md` | replenishment-analysis（补货分析） | 6 | R1 决策清单 / R2 单 SKU / R3 总览矩阵 / R4 覆盖度 / R5 设置读 / R6 设置写 confirm |

## 维护规约（双写）

1. **新增 skill**：先在 Multica 创建并验证（`multica skill create` + 绑定测试），再把最终内容同步落盘到本目录，文件名与 skill 名一致
2. **修改 skill**：Multica 更新后同步覆盖本目录文件；反向修改（改文件）后用 `multica skill update <id> --content-file` 回写
3. **路由核对**：端点一律以 `backend/app/api/v1/endpoints/agent/` 源码为准（本仓库即权威），不凭记忆写
4. 本目录只有 `.md` 纯文本，改动不触发后端部署逻辑；如 push 触发 pre-push 部署可加 `SKIP_POST_PUSH_DEPLOY=1`
