# Agent API · crm_intent 域 API 设计（预留给本地 AI）

> 日期：2026-11-10 ｜ 状态：**设计定稿（待用户 review）**
> 配套：[意向客户工作台设计稿](./2026-11-10-crm-intent-workbench-design.md) ｜ 主协议：[docs/agent-api-design.md](../../agent-api-design.md)
> 范围声明：本 spec 只设计 Agent API（Go 实现，路径 /api/v1/agent/crm-intent/*），不包含页面实现与实施步骤。
> 实现位置：backend-go/internal/api/crm_intent（agent.go + registrar.go）+ backend-go/internal/store/crm_intent.go。

---

## 0. 拍板结论

| # | 结论 |
|---|---|
| A1 | 名称：域 <code>crm_intent</code>；agent 路径前缀 <code>/api/v1/agent/crm-intent</code>；额度与限流沿用 agentauth |
| A2 | 鉴权：Bearer agent token + X-Agent-Id（<code>agentauth.RequireAgentCredential</code>），<code>business_scope</code> 必须包含 <code>crm_intent</code> |
| A3 | 写接口必须带 <code>Idempotency-Key</code>；幂等台账落 <code>crm_intent_import_requests</code> |
| A4 | AI 写入受「人工锁」硬限制：<code>human_touched_at IS NOT NULL</code> 的记录任何字段都不可改；单条 409，批量逐行 skipped |
| A5 | AI 读接口不返回备注/跟进细节，只返回避让信号（state / owner / human_touched / converted） |
| A6 | AI 永远不能改 owner、跟进字段、锁定标记、批次归属、删除记录 |
| A7 | 业务域加入 <code>knownBusinessDomains</code>（backend-go/internal/api/agent_credentials/validation.go）后才能签发该 scope 的凭据 |

---

## 1. 认证与 scope

### 1.1 凭据

- 通过现有 <code>agent_provisioning</code> 两步确认流程签发一张 agent key，参数示例：
  - <code>agent_id</code>: <code>local-intent-screening</code>
  - <code>business_scope</code>: <code>crm_intent</code>（白名单必须包含，不能为 *）
  - <code>project_scope</code>: 签发要求显式白名单；本域数据不按项目隔离，取任意有效项目 id 即可（路由不校验 project scope）
- 请求头：

~~~http
Authorization: Bearer <agent-token>
X-Agent-Id: local-intent-screening
Idempotency-Key: <uuid>            # 写接口必填
Content-Type: application/json
~~~

- 失败语义沿用 agentauth：401（token/agent mismatch）、403（business_scope 不含 crm_intent）、429（限流）。

### 1.2 限流

| 类别 | 建议值 | 说明 |
|---|---|---|
| 读 | 120 req/min | 与现有 agent 模块一致 |
| 写 | 30 req/min | 批次导入可放宽到 60 req/min（小规模） |

内存限流器按进程生效；单实例部署下足够。多实例时需换 Redis 限流（本期不做）。

### 1.3 白名单

实现时必须改：

1. backend-go/internal/api/agent_credentials/validation.go 的 <code>knownBusinessDomains</code> 增加 <code>"crm_intent": {}</code>
2. 若签发仍走 FastAPI provisioning（当前生产 GO_API_OWNED 不含 agent_credentials），确认 Python 侧对 business_scope 为自由字符串（已确认 schemas 不做域名白名单）；否则同步 Python 校验。

---

## 2. 路由表

| 方法 | 路径 | 用途 | 是否写审计 |
|---|---|---|---|
| GET | /health | 连通性 + 域版本 | 否 |
| POST | /batches | JSON 批量导入（companies + pool） | 是 |
| POST | /batches/upload | multipart 文件导入（CSV/XLSX/JSON） | 是 |
| GET | /batches | 批次列表（分页） | 否 |
| GET | /batches/{batch_id} | 批次详情 + 逐行结果 | 否 |
| POST | /companies | 单条创建（AI 筛出的新公司） | 是 |
| PATCH | /companies/{company_id} | 补充/修正筛选资料（未锁定才可） | 是 |
| GET | /companies | 读取公司（分页，含避让信号） | 否 |
| GET | /companies/{company_id} | 读取单条（含避让信号，不含备注） | 否 |
| GET | /pool | 读取待筛池（分页） | 否 |
| PATCH | /pool/{pool_id} | 更新池记录（补充渠道/忽略；不含公司资料） | 是 |
| POST | /pool/{pool_id}/screen | 筛入：用公司 payload 创建/更新公司并置池为 screened | 是 |

路径前缀统一为 <code>/api/v1/agent/crm-intent</code>。

---

## 3. 请求 / 响应 schema

### 3.1 POST /batches（JSON 批量导入）

~~~json
{
  "batch": {
    "batch_date": "2026-11-10",
    "source": "ai-screening",
    "source_file": "名录-2026-11-10.csv",
    "note": ""
  },
  "mode": "upsert",
  "companies": [
    {
      "external_id": "row-1",
      "name": "示例·宁波岚川家居用品有限公司",
      "credit_code": "910000000000000001",
      "legal_person": "张三",
      "phones": ["13800000001"],
      "province": "浙江",
      "city": "宁波",
      "founded_year": 2012,
      "registered_capital_wan": 300,
      "products": "懒人沙发、收纳箱、地垫",
      "category": "家居用品",
      "trademarks": ["示例商标1"],
      "trademark_count": 1,
      "intent_level": "A",
      "intent_score": 86,
      "intent_basis": "…",
      "amazon_fit": "…",
      "walmart_fit": "…",
      "sources": ["https://example.com/source"],
      "risks": "",
      "screened_at": "2026-11-09",
      "phone_note": ""
    }
  ],
  "pool": [
    {
      "external_id": "p-1",
      "name": "示例·未筛企业有限公司",
      "legal_person": "李四",
      "phones": ["13900000001"],
      "website": "https://example.com",
      "channel": "展会",
      "channel_source": "展会-2026-11-10.csv"
    }
  ]
}
~~~

- <code>mode</code>：<code>upsert</code>（默认）/ <code>insert_only</code>。
- 单请求上限：companies ≤ 2000、pool ≤ 5000；超出返回 422，要求拆分。
- 响应 200（批次成功；行级失败不改变 HTTP 200）：

~~~json
{
  "batch_id": 17,
  "status": "completed",
  "created": 12,
  "updated": 3,
  "skipped_locked": 1,
  "rejected": [{"scope": "companies", "index": 4, "external_id": "row-5", "reason": "registered_capital_wan must be a number"}],
  "companies_total": 16,
  "pool_total": 80,
  "data_rev": 32,
  "request_id": "idem-xxx"
}
~~~

- 批次失败（整批不可处理）：422/503，<code>status=failed</code>，R2 已归档原始 payload 便于重放。

### 3.2 POST /companies（单条创建）

Body 同 §3.1 的 company 对象（不含 external_id 也可）。响应：

~~~json
{ "company_id": 42, "created": true, "data_rev": 33 }
~~~

- 命中已存在记录（credit_code 或 name_key）：未锁定 → 更新并返回 created=false；已锁定 → 409 INTENT_RECORD_LOCKED。

### 3.3 PATCH /companies/{company_id}（补充资料）

允许字段（严格白名单，出现未知字段返回 422）：

- credit_code、legal_person、province、city、founded_year、registered_capital_wan、products、category、channel、channels、channel_source、trademarks、trademark_count、intent_level、intent_score、intent_basis、amazon_fit、walmart_fit、sources、risks、screened_at、phone_note
- phones：**仅追加**新号码（不允许删除/覆盖；删除与覆盖是人工动作）

禁止字段（忽略或 422）：name、external_id、batch_id、owner_id、human_touched_*、converted_*、以及任何跟进字段。

响应：200 更新后的**资料视图**（不含备注/followup 细节）；409 若记录已锁定；404 不存在。

### 3.4 GET /companies、GET /companies/{id}

查询参数：<code>page</code>、<code>page_size</code>（默认 50，最大 200）、<code>since</code>（updated_at > since）、<code>level</code>、<code>state</code>、<code>owner</code>（uuid）、<code>human_touched</code>（true/false）、<code>converted</code>（true/false）、<code>batch_id</code>。

响应 item（资料视图）：

~~~json
{
  "id": 42,
  "name": "…",
  "credit_code": "…",
  "phones": ["138…"],
  "intent_level": "A",
  "intent_score": 86,
  "human_touched": true,
  "owner_id": "uuid-or-null",
  "state": "quoted",
  "converted_customer_id": null,
  "updated_at": "2026-11-10T10:00:00+08:00"
}
~~~

**不返回**：note、last_contact_at、next_contact_at、valid_phones、human_touched_by 的姓名、备注快照。理由：人工跟进内容不进入 AI 上下文；AI 只需要知道"这条不能碰"。

### 3.5 GET /pool、PATCH /pool/{id}

- 读取：<code>page/page_size/status/since/batch_id</code>；item 含 id、name、legal_person、phones、website、channel、channels、channel_source、status、screened_company_id、updated_at。
- 更新：仅允许 <code>status</code>（pending/ignored）、<code>channel/channels/channel_source</code>、<code>website/legal_person</code>；不允许改 name（身份键）。

### 3.6 POST /pool/{pool_id}/screen（筛入）

~~~json
{
  "company": {
    "name": "…", "credit_code": "…", "legal_person": "…", "phones": ["…"],
    "province": "…", "city": "…", "founded_year": 2012, "registered_capital_wan": 300,
    "products": "…", "category": "…", "trademarks": [], "trademark_count": 0,
    "intent_level": "B", "intent_score": 70, "intent_basis": "…",
    "amazon_fit": "…", "walmart_fit": "…", "sources": ["…"], "risks": "",
    "screened_at": "2026-11-10"
  }
}
~~~

响应：

~~~json
{ "company_id": 43, "pool_id": 9, "created": true, "pool_status": "screened", "data_rev": 34 }
~~~

- 若同 key 公司已存在且未锁定 → 更新；已锁定 → 409，池状态保持 pending（幂等可重试）。
- 成功后池记录 <code>status=screened, screened_company_id=company_id</code>。

---

## 4. 幂等与限流

- 所有写接口要求 <code>Idempotency-Key</code>（1–128 字符）；缺失返回 400 <code>IDEMPOTENCY_KEY_REQUIRED</code>。
- 幂等键作用域：<code>(actor_kind='agent', actor_id=&lt;agent_id&gt;, idempotency_key)</code>；请求体 SHA-256 作为 fingerprint。
  - 同 key 同 payload：返回首次响应（HTTP 200/4xx），不重复落库。
  - 同 key 不同 payload：409 <code>IDEMPOTENCY_CONFLICT</code>。
- 幂等记录保留 7 天（按 created_at 清理；规模小，可延后加清理任务）。
- 限流见 §1.2；429 带 <code>Retry-After</code>。

---

## 5. 锁定与拒绝语义

### 5.1 判定

<code>crm_intent_companies.human_touched_at IS NOT NULL</code> 即锁定（人工认领/改资料/补电话/写跟进/转客户均会设置）。

### 5.2 行为

| 场景 | HTTP | 响应 |
|---|---|---|
| 批量导入命中锁定公司 | 批次仍 200 | 行级 <code>skipped_locked</code> 计数；批次响应不中断 |
| 单条创建/更新命中锁定公司 | 409 | <code>{"detail":{"code":"INTENT_RECORD_LOCKED","message":"该记录已被人工跟进，AI 不可修改","company_id":42}}</code> |
| 池筛入命中锁定公司 | 409 | 同上；池状态保持 pending |
| 请求含禁止字段 | 422 | <code>VALIDATION_FAILED</code>，detail 指出字段 |
| 记录不存在 | 404 | <code>INTENT_NOT_FOUND</code> |

### 5.3 实现约束

- Store 层所有 AI 更新必须使用单条 SQL：<code>UPDATE ... WHERE id=$1 AND human_touched_at IS NULL</code>；若 0 行，再查一次区分 404/409。
- 禁止在 handler 先查后写（存在竞态）。
- 批量导入按行事务：单行失败不影响其他行；批次计数在末尾汇总（同一批次要么 completed 要么 failed，行级失败记 rejected）。
- 被拒绝的写入写 <code>operation_audit_logs</code>：action <code>crm_intent.ai_write_blocked</code>，context 含 agent_id、目标 company_id、原因。

---

## 6. 审计

| 动作 | 表 | 内容 |
|---|---|---|
| 批次导入 | operation_audit_logs | actor=agent_id、action=crm_intent.batch_import、batch_id、counts、r2_key、idempotency_key |
| 单条创建/更新 | operation_audit_logs | action=crm_intent.company_upsert_ai、company_id、changed_fields |
| 池筛入 | operation_audit_logs | action=crm_intent.pool_screen、pool_id、company_id |
| 锁定拒绝 | operation_audit_logs | action=crm_intent.ai_write_blocked、company_id、reason |

- 读接口不写审计（与主协议一致）。
- 审计 context 不写备注等敏感内容；号码只写是否变更，不写明文。

---

## 7. 错误码

| code | HTTP | 含义 |
|---|---|---|
| VALIDATION_FAILED | 422 | 请求体/字段校验失败 |
| INTENT_NOT_FOUND | 404 | 公司/池记录不存在 |
| INTENT_RECORD_LOCKED | 409 | 记录已被人工跟进，AI 不可修改 |
| INTENT_DUPLICATE_CONFLICT | 409 | credit_code 与 name_key 指向不同记录，无法安全 upsert |
| IDEMPOTENCY_KEY_REQUIRED | 400 | 写接口缺少 Idempotency-Key |
| IDEMPOTENCY_CONFLICT | 409 | 同 key 不同 payload |
| INTENT_R2_UNAVAILABLE | 503 | R2 未配置/不可用，无法归档批次 |
| RATE_LIMITED | 429 | 超出限流 |
| AGENT_BUSINESS_OUT_OF_SCOPE | 403 | 凭据不含 crm_intent |

错误响应沿用现有 agent 错误壳（<code>{"detail": {"code": "...", "message": "..."}}</code>），与 agentauth.WriteError 保持一致。

---

## 8. 权限与数据范围

| 能力 | 允许 |
|---|---|
| 读公司/池 | 凭据含 crm_intent 即可（全局，不按 owner） |
| 批次导入/单条创建/更新/池筛入 | 凭据含 crm_intent 即可 |
| 改 owner/跟进/锁定/转换/删除 | **任何 agent 凭据都不允许**（禁止字段） |
| 读备注/跟进细节 | **不允许**（接口不返回） |

- Agent 无用户身份，不参与 owner 隔离；导入数据默认 <code>owner_id = NULL</code>（sea），由人工领取。
- 若同一家公司被多个 AI 流水线重复导入：以 credit_code / name_key upsert，后写覆盖资料（未锁定），并写审计。
- 转换客户只能人工在页面操作；Agent 无此端点。

---

## 9. 测试

| 层 | 用例 |
|---|---|
| 契约（Go） | 401/403/429；Idempotency-Key 缺失/重放/冲突；批量导入 created/updated/skipped/rejected 计数；锁定记录单条 409、批量 skip；禁止字段 422；R2 不可用 503 |
| Store（Go） | 行级事务、upsert 键优先级（credit_code > name_key）、human_touched 竞态（并发人工写 + AI 写）、rev 递增 |
| 集成 | 本地 AI 样例 JSON 跑通；再次同 key 重放返回相同响应；人工写后 AI 再写被拒 |
| 安全 | 凭据无 crm_intent → 403；错误 agent_id → 401；请求体注入禁止字段被 422 |

---

## 10. 与人工导入共用 ingest

- 同一份解析/upsert/锁定逻辑，入参 <code>actor_kind=agent|user</code>：
  - agent：走本 spec 的 agent 端点，严格字段白名单、禁止 followup 字段。
  - user（admin）：页面 <code>POST /api/v1/crm/intent/batches/upload</code>，同样跳过锁定记录；审计 actor 为用户 UUID。
- 共用输出结构：created/updated/skipped_locked/rejected + batch_id + data_rev。
- 不允许为两条路径各写一套解析（避免语义漂移）。

---

## 11. 本地 AI 对接示例

~~~bash
curl -X POST http://127.0.0.1:8200/api/v1/agent/crm-intent/batches \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Agent-Id: local-intent-screening" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d @batch-2026-11-10.json
~~~

- 本地 Go Gateway 默认监听 127.0.0.1:8200；生产通过网关域名访问。
- 如果本地开发未把 crm_intent 加进 GO_API_OWNED，网关会把该路径反代 FastAPI（404）；联调前先确认开关。

---

## 12. 扩展位（本期不做）

- 批次作废/回滚（需新增 confirm 两步流）。
- AI 建议队列（对已锁定记录只写"建议"，人工采纳后生效）。
- 异步导出、截图/附件上传。
- 多实例 Redis 限流与幂等存储。
