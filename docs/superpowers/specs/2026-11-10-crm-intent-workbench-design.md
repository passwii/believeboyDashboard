# 意向客户工作台（CRM · crm_intent）设计稿

> 日期：2026-11-10 ｜ 状态：**已实施**（2026-11-10；验证记录见 §12.1）
> 配套：[Agent API · crm_intent 域 spec](./2026-11-10-agent-crm-intent-api.md)
> 迁移：285（实施时以 backend/scripts/check_alembic.py 的 head 为准；若 main 前进则顺延序号）
> 范围声明：本文只定「做什么、为什么、契约是什么」，实施步骤进后续 plan。不改变任何现有 CRM 表与接口行为。
> 来源：用户草稿「意向客户工作台-独立演示版.html」（解析规格 /tmp/intent-workbench-spec.md）。草稿仅作**信息架构 / 数据字段 / 交互语义**参照；**视觉按 V4 Warm Ledger 重做**（用户 2026-11-10 拍板），不引入深空玻璃/极光/主题切换/Canvas 特效。

---

## 0. 拍板结论（用户已确认）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 数据来源 | 已有筛选流水线（AI/脚本）产出结果文件；本功能做**导入接口 + R2 归档 + PG 查询**；页面只读待筛池、只写跟进 |
| D2 | AI 接口 | **必须预留**：<code>/api/v1/agent/crm-intent/*</code>，agent 凭据 + <code>business_scope=crm_intent</code>；本地 AI 直接对接 |
| D3 | 人工保护 | **整条记录锁死**：人工认领/改过任一字段后，AI 不能再改该记录任何字段（数据库层强制） |
| D4 | 视觉 | **沿用 V4 Warm Ledger**；草稿视觉不落地 |
| D5 | 实时 | 首版**刷新 + 10–30s 轮询**（默认 15s），不做 SSE |
| D6 | 权限 | 按负责人隔离：<code>mine / all(admin) / sea(未领取)</code>，复用现有 CRM scope 语义 |
| D7 | 与 CRM 打通 | 做「转为客户」，写 <code>converted_customer_id</code>（crm_customers.id） |
| D8 | 数据规模 | 不大 → offset 分页、服务端统计/导出（同步），不做队列/分区/游标 |
| D9 | 命名 | 路由 <code>/dashboard/crm/intent</code>、侧栏「意向客户」、Go 模块 <code>crm_intent</code>、API 前缀 <code>/api/v1/crm/intent</code>、AI scope <code>crm_intent</code>、Agent 路径 <code>/api/v1/agent/crm-intent</code> |

---

## 1. 背景、目标与非目标

### 1.1 兰图与现状

草稿是一个 3 视图（意向客户卡片/表格、待筛池、跟进看板）+ 详情抽屉 + 8 态跟进 + 手机号共用检测 + CSV 导出的单文件演示。数据来自外部筛选流水线（batch、screenedAt、channelSource 字段与页脚 data/companies.json 均可证），页面本身没有筛选/采集动作。

现有仓库已有成熟 CRM（客户/线索/公海/跟进/任务/规则/方案），但**没有「意向客户/客户雷达」实现**；现有 crm_customers / crm_leads 语义与草稿的「筛选后的工商企业 + 意向评分 + 待筛池」不同，不能直接复用（见 §3）。

### 1.2 目标

1. 给筛选流水线一个稳定的**批次导入契约 + R2 原始文件归档**（AI 接口与人工导入共用）。
2. 给销售一个 **V4 风格的意向客户工作台**：三视图、筛选、抽屉、跟进状态/备注/下次联系、手机号共用检测、服务端导出。
3. **人工保护**：任何人工写过的记录，AI 永久不可改；AI 写入被拒绝要可审计。
4. 与现有 CRM 打通：负责人隔离 + 一键转为客户。

### 1.3 非目标（本期不做）

- 不做筛选算法/采集（流水线在外部）。
- 不做待筛池的页面内筛选动作（只读；筛选由 AI 流水线完成）。
- 不做 SSE / WebSocket；不做服务端提醒/Notification（草稿的「关页提醒」不进本期）。
- 不做手机端/多断点适配（V4 桌面规则）。
- 不做草稿的 Canvas 粒子特效、三态主题、玻璃拟态、极光背景。
- 不做批量回滚 UI、自定义字段、AI 建议队列（均留扩展位）。

---

## 2. 总体架构

~~~text
外部筛选流水线（本地 AI / 脚本）
        │  POST /api/v1/agent/crm-intent/batches（Bearer agent key）
        ▼
┌─────────────────────────────────────────────┐
│ Go Gateway（backend-go，新模块 crm_intent）  │
│  ├─ 用户接口 /api/v1/crm/intent/*  ← Next 代理 │
│  └─ Agent 接口 /api/v1/agent/crm-intent/*     │
│  ├─ PG：crm_intent_* 表（唯一数据 SOT）       │
│  ├─ R2：原始批次文件/JSON 归档（blob.ObjectStore）│
│  └─ 审计：operation_audit_logs + crm_audit_logs │
└─────────────────────────────────────────────┘
        ▲ 轮询 /meta（15s）+ 手动刷新
        │
Next.js /dashboard/crm/intent（V4 Warm Ledger）
~~~

- 前端不直连 Go；所有请求走 <code>/api/backend</code> 代理，浏览器不持 API key。
- AI 直连 Go（server-to-server），用 agent 凭据，不进 Next 代理、不受 4.5MB 请求上限影响。
- 结构化数据只存 PG；R2 只存文件字节（原始批次、可选导出产物）。

---

## 3. 数据模型（迁移 285）

### 3.1 表清单

| 表 | 用途 |
|---|---|
| crm_intent_batches | 导入批次台账（AI/人工），关联 R2 原始文件 |
| crm_intent_companies | 意向客户企业主表（筛选资料 + owner + 人工锁 + 转客户指针） |
| crm_intent_phones | 企业/待筛池的手机号（归一化、来源、有效标记）——共用检测的唯一来源 |
| crm_intent_followups | 跟进记录 1:1（8 态、备注、上次/下次联系、version） |
| crm_intent_followup_events | 跟进时间线（人工状态变更审计） |
| crm_intent_pool | 待筛池候选（只读展示；AI 筛入后置 screened） |
| crm_intent_import_requests | Agent 导入幂等台账 |
| crm_intent_meta | 单行：data_rev / followup_rev（轮询） |

所有主键 Integer（对齐仓库约定），时间 timestamptz。

### 3.2 关键 DDL 草案

~~~sql
crm_intent_batches(
  id serial PK,
  batch_date date NOT NULL,
  source varchar(16) NOT NULL CHECK (source IN ('ai','manual')),
  source_file_name varchar(255),
  r2_key varchar(1024),
  content_sha256 char(64),
  total_companies int NOT NULL DEFAULT 0,
  total_pool int NOT NULL DEFAULT 0,
  created_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  skipped_locked_count int NOT NULL DEFAULT 0,
  rejected_count int NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  error_detail text,
  created_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

crm_intent_companies(
  id serial PK,
  batch_id int REFERENCES crm_intent_batches(id) ON DELETE SET NULL,
  external_id varchar(128),
  name varchar(200) NOT NULL,
  name_key varchar(200) NOT NULL,
  credit_code varchar(32),
  legal_person varchar(100),
  province varchar(50),
  city varchar(50),
  founded_year int,
  registered_capital_wan numeric(14,2),
  products text,
  category varchar(50),
  trademarks jsonb NOT NULL DEFAULT '[]',
  trademark_count int NOT NULL DEFAULT 0,
  intent_level char(1) NOT NULL DEFAULT 'D' CHECK (intent_level IN ('A','B','C','D')),
  intent_score int CHECK (intent_score BETWEEN 0 AND 100),
  intent_basis text,
  amazon_fit text,
  walmart_fit text,
  sources jsonb NOT NULL DEFAULT '[]',
  risks text,
  screened_at date,
  phone_note text,
  owner_id varchar(36),
  human_touched_at timestamptz,
  human_touched_by varchar(36),
  converted_customer_id int REFERENCES crm_customers(id) ON DELETE SET NULL,
  converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

crm_intent_phones(
  id serial PK,
  company_id int REFERENCES crm_intent_companies(id) ON DELETE CASCADE,
  pool_id int REFERENCES crm_intent_pool(id) ON DELETE CASCADE,
  phone_raw varchar(50) NOT NULL,
  phone_normalized varchar(32) NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'list' CHECK (source IN ('list','manual','ai')),
  is_valid boolean NOT NULL DEFAULT false,
  created_by varchar(36),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((company_id IS NOT NULL)::int + (pool_id IS NOT NULL)::int = 1)
);

crm_intent_followups(
  company_id int PRIMARY KEY REFERENCES crm_intent_companies(id) ON DELETE CASCADE,
  state varchar(20) NOT NULL DEFAULT 'none'
    CHECK (state IN ('none','contacted','wechat','quoted','negotiating','won','hold','mismatch')),
  note text NOT NULL DEFAULT '',
  last_contact_at timestamptz,
  next_contact_at timestamptz,
  version int NOT NULL DEFAULT 1,
  updated_by varchar(36),
  updated_at timestamptz NOT NULL DEFAULT now()
);

crm_intent_followup_events(
  id serial PK,
  company_id int NOT NULL REFERENCES crm_intent_companies(id) ON DELETE CASCADE,
  from_state varchar(20), to_state varchar(20),
  note_snapshot text,
  actor_id varchar(36) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

crm_intent_pool(
  id serial PK,
  batch_id int REFERENCES crm_intent_batches(id) ON DELETE SET NULL,
  external_id varchar(128),
  name varchar(200) NOT NULL,
  name_key varchar(200) NOT NULL,
  legal_person varchar(100),
  website varchar(300),
  channel varchar(50),
  channels jsonb NOT NULL DEFAULT '[]',
  channel_source varchar(255),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','screened','ignored')),
  screened_company_id int REFERENCES crm_intent_companies(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

crm_intent_import_requests(
  id serial PK,
  actor_kind varchar(8) NOT NULL CHECK (actor_kind IN ('agent','user')),
  actor_id varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'processing',
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (actor_kind, actor_id, idempotency_key)
);

crm_intent_meta(
  id int PRIMARY KEY CHECK (id = 1),
  data_rev bigint NOT NULL DEFAULT 0,
  followup_rev bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
~~~

- 建表顺序：先建 crm_intent_pool，再建 crm_intent_phones（phones 反向引用 pool）；或先建 phones 后在迁移末尾补 FK。
- 迁移末尾插入 crm_intent_meta 单行（id=1），并初始化 data_rev=0 / followup_rev=0。
- rev 递增规则（同一事务内）：
  - data_rev：公司资料/电话/批次/池状态变化（AI 导入、人工资料编辑、池筛入、转客户）。
  - followup_rev：仅跟进写入（state/note/时间/有效电话）变化。
  - 巡检/轮询只读不递增。

### 3.3 索引

~~~sql
UNIQUE INDEX uq_crm_intent_companies_credit_code ON crm_intent_companies(credit_code)
  WHERE credit_code IS NOT NULL AND credit_code <> '';
UNIQUE INDEX uq_crm_intent_companies_name_key ON crm_intent_companies(name_key);
CREATE INDEX idx_crm_intent_companies_owner ON crm_intent_companies(owner_id);
CREATE INDEX idx_crm_intent_companies_level ON crm_intent_companies(intent_level);
CREATE INDEX idx_crm_intent_companies_category ON crm_intent_companies(category);
CREATE INDEX idx_crm_intent_companies_region ON crm_intent_companies(province, city);
CREATE INDEX idx_crm_intent_companies_screened ON crm_intent_companies(screened_at);
CREATE INDEX idx_crm_intent_companies_updated ON crm_intent_companies(updated_at);
CREATE INDEX idx_crm_intent_companies_touched ON crm_intent_companies(human_touched_at);

CREATE INDEX idx_crm_intent_phones_normalized ON crm_intent_phones(phone_normalized);
CREATE UNIQUE INDEX uq_crm_intent_phones_company_phone ON crm_intent_phones(company_id, phone_normalized)
  WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX uq_crm_intent_phones_pool_phone ON crm_intent_phones(pool_id, phone_normalized)
  WHERE pool_id IS NOT NULL;

CREATE INDEX idx_crm_intent_followups_next ON crm_intent_followups(next_contact_at);
CREATE INDEX idx_crm_intent_pool_status ON crm_intent_pool(status);
CREATE INDEX idx_crm_intent_pool_batch ON crm_intent_pool(batch_id);
~~~

### 3.4 枚举与口径

| 枚举 | 存储值 | 中文 label（响应同时给） |
|---|---|---|
| 跟进状态 | none/contacted/wechat/quoted/negotiating/won/hold/mismatch | 未联系/已联系/已加微信/已报价/谈判中/已成交/暂搁置/不匹配 |
| 意向级别 | A/B/C/D | 强意向/可培育/信息不足/暂不匹配 |
| 批次来源 | ai/manual | AI 导入/人工导入 |
| 电话来源 | list/manual/ai | 名录/补录/AI 补充 |

- name_key：TrimSpace + 多空格压一 + 全角括号/罗马数字不做归一（保持可预期）。
- phone_normalized：去非数字；13 位且以 86 开头去前缀；长度 < 6 拒绝入库。
- registered_capital_wan：只接受数值（万元）。草稿的 "300万人民币" 字符串视为**契约错误**，导入时按 rejected 行返回，不做模糊解析。
- category：不做硬编码白名单（草稿 16 类目与实际数据不一致），由数据 distinct 值生成筛选项，按数量降序 + 名称。
- 到期口径：next_contact_at <= now() 即「待联系/已逾期」（不做草稿的「当天 23:59」宽限）。
- stats 唯一口径在服务端；前端不再自行派生统计。

### 3.5 SQLAlchemy 模型同步

迁移同时新增 backend/app/models/crm_intent.py（并在 app/models/__init__.py 导入），保持 FastAPI 同库 ORM 可读；**FastAPI 不实现 crm_intent 路由**（Go 独占），因此不影响 OpenAPI 与 gen:api-types。若后续要让 FastAPI 兜底，再补 schema/endpoint。

---

## 4. 权限、owner 与「人工锁」

### 4.1 scope 语义（复用现有 CRM）

| scope | 定义 | 说明 |
|---|---|---|
| mine | owner_id = me | 非管理员默认 |
| all | 全部 | **仅管理员**；非管理员请求 all 时按 mine 处理（沿用 ResolveScope） |
| sea | owner_id IS NULL | 未领取/未分配，任何 CRM 用户可查看/领取 |

- 负责人键必须是 identity.UserID（user_accounts.id UUID 字符串）；禁止用 X-Operator 显示名做权限键。
- 首次人工写（认领/改状态/改备注/改资料/补电话）若记录未领，自动把 owner_id 设为当前用户（事务内完成），写入 human_touched_at/by。
- 管理员可转移 owner；普通用户不能改他人记录的 owner。
- 转为客户后 owner 同步到 crm_customers.owner_id。

### 4.2 人工锁（D3 落地规则）

**锁定触发**（服务端事务内写 human_touched_at = now(), human_touched_by = me）：

1. 认领（显式「领取」或首次人工写自动认领）
2. PATCH 跟进（任一字段）
3. 编辑公司资料
4. 补录/覆盖手机号、设置有效电话
5. 转为客户

**锁定后**：

- AI 对该公司**任何字段**的写入一律拒绝（单条 409 INTENT_RECORD_LOCKED；批量逐行 skipped_locked，批次继续）。
- AI 永远不能写：owner_id、human_touched_*、converted_*、跟进表、批次归属、删除。
- 人工可以继续编辑（owner 或 admin），但 AI 永不解除锁定。
- 被拒绝的 AI 写入写 operation_audit_logs（crm_intent.ai_write_blocked），便于追溯。

> 注：草稿的看板会展示「未联系」列，但锁定判定不以「出现在看板」为准，而以**是否发生过人工写**为准（更严格、可解释）。

### 4.3 写入矩阵

| 数据组 | 人工 UI | 人工导入（admin） | AI（未锁定） | AI（已锁定） |
|---|---|---|---|---|
| 工商/产品/类目/商标/评分/适配/来源/疑点 | ✅（owner/admin，写锁） | ✅ upsert | ✅ | ❌ |
| 电话（名录/补录/有效标记） | ✅ | ✅ 新增去重 | ✅ 新增未存在号码 | ❌ |
| owner | ✅ 领取；admin 转移 | ❌ | ❌ | ❌ |
| 跟进状态/备注/上次/下次联系 | ✅（version 409） | ❌ | ❌ | ❌ |
| 批次/删除/转换标记 | admin | ❌ | ❌ | ❌ |
| 转为客户 | ✅（owner/admin，一次） | ❌ | ❌ | ❌ |

- 人工导入与 AI 导入共用同一 ingest 服务；**默认都跳过已锁定记录**并在结果中计数。人工要修正锁定记录的资料，走抽屉「编辑资料」（人工行为，写审计）。
- 转换后的记录：跟进区只读，显示「已转客户」和客户链接；资料仍可由人工编辑（写审计）。

### 4.4 并发控制

- crm_intent_followups.version 单调递增；用户端 PATCH 必须带 If-Match: <version>（或 body version）。不匹配返回 409 INTENT_VERSION_CONFLICT + 当前完整记录，前端提示「这条刚被 %s 改过，已刷新」。
- 备注自动保存 debounce 900ms + beforeunload/visibilitychange flush，避免丢字。
- AI 不需要 followup version（它不写跟进表）；profile 更新由人工锁保护。

---

## 5. 用户端 API（/api/v1/crm/intent）

### 5.1 路由表

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | /meta?scope=&data_rev=&followup_rev= | 批次/统计/facets/rev；rev 相同返回 changed:false | CRM 登录用户 |
| GET | /companies?scope=&q=&level=&category=&channel=&province=&city=&state=&with_phone=&dup=&due=&sort=&page=&page_size= | 分页列表（卡片/表格共用） | 同上 |
| GET | /companies/{id} | 详情（含 phones/followup/共用组） | 同上 |
| PATCH | /companies/{id}/followup | 跟进写入（state/note/last_contact_at/next_contact_at/valid_phones），带 If-Match | owner/admin |
| POST | /companies/{id}/claim | 领取（sea→mine） | CRM 用户 |
| PATCH | /companies/{id}/profile | 人工编辑资料（写人工锁） | owner/admin |
| POST | /companies/{id}/phones | 补录号码 | owner/admin |
| PATCH | /companies/{id}/phones/{phone_id} | 设置有效电话 | owner/admin |
| DELETE | /companies/{id}/phones/{phone_id} | 删除补录号码（仅 manual 来源） | owner/admin |
| POST | /companies/{id}/convert | 转为客户，写 converted_customer_id | owner/admin，一次 |
| GET | /board?scope= | 8 组（count + top8 items） | CRM 登录用户 |
| GET | /pool?q=&page=&page_size= | 待筛池只读分页 | CRM 登录用户 |
| GET | /facets?scope= | 类目/渠道/地区/状态选项（可与 meta 合并） | 同上 |
| GET | /export?scope=&filters… | 服务端 CSV（当前筛选全量）+ 审计 | CRM 登录用户 |
| POST | /batches/upload | 人工导入（multipart） | admin |
| GET | /batches?page=、/batches/{id} | 批次历史/逐行结果 | admin |

分页响应：{items,total,page,page_size}；列表 DTO 含 phones[]、followup{state,label,note,last_contact_at,next_contact_at,version}、owner{id,name}、human_touched、converted_customer_id。

详情 DTO 额外返回 shared_phones（号码共用组）：

~~~json
{
  "shared_phones": [
    {
      "phone_normalized": "13800000001",
      "raw": "13800000001",
      "companies": [{"id": 42, "name": "…", "intent_level": "A"}],
      "pool": [{"id": 9, "name": "…", "status": "pending"}]
    }
  ]
}
~~~

- 共用组口径：同一 phone_normalized 关联 ≥2 个不同公司（或公司+池）时返回；只返回 scope 内可见的公司。
- 列表的 dup=true 过滤与 stats.dup_groups 使用同一查询口径，避免前端/服务端两套判定。

### 5.2 关键请求/响应

**PATCH followup**

~~~json
// request（If-Match: 3）
{ "state": "quoted", "note": "已发报价单", "last_contact_at": "2026-11-10T10:00:00+08:00",
  "next_contact_at": "2026-11-12T10:00:00+08:00", "valid_phones": ["13900000001"] }
// 200
{ "company_id": 42, "state": "quoted", "state_label": "已报价", "note": "已发报价单",
  "last_contact_at": "…", "next_contact_at": "…", "valid_phones": ["…"],
  "version": 4, "updated_by": "uuid", "updated_at": "…", "owner": {"id":"uuid","name":"张三"} }
// 409
{ "detail": { "code": "INTENT_VERSION_CONFLICT", "message": "记录已被其他人更新", "current": { … } } }
~~~

**GET meta（轮询）**

~~~json
{ "batch": {"id":7,"batch_date":"2026-11-10","updated_at":"…","total":128,"pool_total":80},
  "stats": {"total":128,"by_level":{"A":10,"B":30,"C":50,"D":38},"with_phone":120,
            "contacted":8,"followed_up":12,"pool_total":80,"dup_groups":3,"due_count":2},
  "facets": {"levels":["A","B","C","D"],"categories":["家居用品"],
             "channels":["展会"],"provinces":["浙江"],
             "cities":[{"province":"浙江","cities":["宁波"]}], "states":["…code+label…"]},
  "data_rev": 31, "followup_rev": 12, "changed": true, "server_time": "…" }
~~~

- 轮询：前端 15s 调 /meta（带当前 scope/revs）；changed=false 不重取；页面不可见时暂停；手动刷新强制重取。草稿的「在线人数」不做。

### 5.3 统计口径（服务端唯一）

- total：scope 内公司数；by_level：按 A/B/C/D 计数（不受当前级别筛选影响，与草稿口径一致：统计卡用于筛选联动）。
- with_phone：至少一个号码的公司数（口径写死：任一号码即计）。
- contacted：state ≠ none；followed_up：有 followup 记录或 state ≠ none（等价）。
- due_count：next_contact_at <= now() 且未转客户。
- dup_groups：该公司集合内被 ≥2 家公司共用的号码组数（scope 内）。
- pool_total：待筛池 pending 数。

### 5.4 导出

- 服务端按**当前筛选 + scope**生成 CSV（BOM，UTF-8，24 列 + owner + 状态 + 下次联系 + 是否转客户），文件名 客户雷达_意向客户_<batch>.csv。
- 上限 50,000 行，超过返回 422 并提示收窄筛选；写 operation_audit_logs（动作 crm_intent.export，含 actor、scope、筛选 hash、行数）。
- 浏览器经 /api/backend 代理拿 blob 下载（沿用 frontend/lib/crm/method/download-csv.ts）。

### 5.5 人工导入

- 仅 admin；multipart：file（JSON/CSV/XLSX）+ batch_date + source_note。
- 与 AI 共用 ingest：解析 → R2 归档原始文件 → upsert（未锁定更新、锁定跳过）→ 返回逐行结果（created/updated/skipped_locked/rejected）。
- 人工导入的字段契约与 Agent JSON 导入**完全一致**（见 agent spec §3.1）；XLSX/CSV 由服务端解析为同一结构，不另立第二套字段名。
- 文件 >4.5MB 走既有 3MB 分片上传范式（或本地大文件改走 AI 接口 server-to-server）。

### 5.6 转为客户

- 前置：owner/admin、未转、非已删。事务内：crm_customers（name/industry=category/rating=intent_level/source=customer_radar/owner_id/address=province+city/website? 无则空/remark 摘要）→ crm_contacts（legal_person + 主要号码，is_primary）→ 回写 converted_customer_id/converted_at → crm_audit_logs + operation_audit_logs。
- CrmCustomerSource 增加 customer_radar = 'customer_radar'（Python 常量 + 前端 CustomerSource/枚举中文「客户雷达」）；intent_basis 摘要进 remark。
- 转换后雷达记录跟进区只读，显示「已转客户」与链接；资料仍可人工编辑。

---

## 6. AI 接口（摘要）

完整契约见 [Agent API · crm_intent 域 spec](./2026-11-10-agent-crm-intent-api.md)。摘要：

- 前缀 /api/v1/agent/crm-intent，Bearer agent token + X-Agent-Id，business_scope=crm_intent。
- 端点：批次导入（JSON/multipart）、单条创建/补资料、读公司/池、池筛入。
- Idempotency-Key 必填；actor_kind=agent 幂等台账落 crm_intent_import_requests。
- 锁定拒绝：单条 409 INTENT_RECORD_LOCKED；批量逐行 skipped_locked。
- AI 读接口**不返回备注/跟进细节**，只给 state/owner_id/human_touched/converted 等避让信号。
- 业务域加入 knownBusinessDomains（backend-go/internal/api/agent_credentials/validation.go）。

---

## 7. R2 存储

| 内容 | key | 说明 |
|---|---|---|
| 批次原始文件/JSON | crm-intent/batches/<YYYY-MM-DD>/<batch_id>-<sanitized-filename> | 先写 R2 再入库；DB 存 r2_key + content_sha256 |
| 导出产物 | MVP 同步导出，不落 R2 | 数据量大时再扩展异步导出 |
| 来源截图/附件 | 本期不做 | 预留 crm-intent/sources/<company_id>/… |

- 用 blob.ObjectStore + blob.ObjectKey；DB **只存 key**，不存完整 URL。
- 上传失败清理已写对象（best-effort TryDelete）；R2 未配置时导入 fail-closed（503 INTENT_R2_UNAVAILABLE），避免无审计的批次入库。
- 读侧本期不需要下载原始文件；如需要，用 PresignedGetURL（1h）。

---

## 8. 前端设计（V4 Warm Ledger）

### 8.1 路由与注册（三处缺一不可）

1. frontend/app/dashboard/crm/intent/page.tsx（+ intent-warm.module.css、page.test.tsx）
2. frontend/lib/dashboard-route-meta.ts：{ ...CRM_SECTION, title: '意向客户', warm: true }（并加标题表条目）
3. frontend/lib/sidebar-config.ts：CRM 组新增「意向客户」，紧邻「线索」或「客户公海」
4. 路由矩阵测试：warm-ledger-shell.test.tsx、tests/dashboard/warm-ledger-expansion-desktop.spec.ts、tests/crawl/discovery.spec.ts

> 注：侧栏正在改两级可折叠导航（main 7eafbb38），本设计的三处注册点不变；实施时以最新 sidebar-config 结构为准，并在对应导航测试中补齐。

### 8.2 草稿 → V4 映射（视觉重做，IA 保留）

| 草稿元素 | V4 实现 |
|---|---|
| 深空玻璃/极光/噪点/聚光 | ❌ 不落地；用 Stage/Window/Panel 暖石墨表面、1px hairline、克制阴影 |
| 品牌 logo、主题三态、伪在线人数、单机 badge | ❌ 不落地；壳已有面包屑/标题；保留真实批次/更新时间 |
| Bento 统计 | 5 张 V4 metric panel：在库企业 / A 级 / B 级 / 已联系 / 待筛池；数字 DM Mono + tabular-nums；A 级用 accent |
| 页签（意向客户/待筛池/跟进看板） | WarmSegmentedControl（tab 状态进 URL） |
| 卡片/表格切换 | WarmSegmentedControl（图标 + 文本，aria-pressed） |
| 筛选栏 | 页面本地 search input + WarmSelect×N + 级别 WarmSegmentedControl；高级筛选（仅有号码/重复/待联系/分组）放页面本地 popover，统一 V4 token |
| 卡片 | V4 panel（16px 圆角）；级别 badge + 意向分（mono）+ 元信息 + 产品 chips + 意向依据 2–3 行；hover 仅用于整卡可点击 |
| 级别 A/B/C/D | WarmBadge tone：A=accent；B/C=neutral；D=neutral（文字仍明确「暂不匹配」）；不新增颜色 |
| 8 态 | WarmCrmStatusPill：已成交=positive；已报价/谈判中=accent；未联系/已联系/已加微信/暂搁置=neutral；不匹配=negative；**始终带文字** |
| 表格 | 页面本地 Warm 表格；compact 密度；表头 sticky、可排序（名称/级别/意向分/筛选日期）；数字列 mono 右对齐；行点击开抽屉 |
| 详情抽屉 | WarmCrmRecordDrawer；分区同草稿（关键信息/手机号/意向判断/主营产品/平台适配/来源/疑点/跟进），footer：保存态 + 复制摘要 + 转为客户 + 关闭 |
| 手机号共用面板 | 页面本地 Radix Dialog + V4 token（次级弹层）；列出共用公司与池记录，可跳公司/池 |
| 空/错/加载 | WarmCrmState（empty/error/loading 三态 + zero-data 文案分离） |
| Toast | 现有 useNotifications，不新写 toast |
| Canvas 特效 | ❌ 不做（含状态烟花/鼓掌/哭泣） |
| 移动端 | ❌ 不做；桌面 1440×900 验收 |

### 8.3 页面结构

~~~text
WarmCrmPage
├─ WarmCrmToolbar
│   ├─ start: scope WarmSegmentedControl（我的/全部/待领取）+ 批次/更新时间 + 同步状态
│   └─ end: 刷新、导入批次(admin)、导出 CSV、视图切换
├─ 统计 metric panels（5）
├─ 筛选区（搜索 + 级别 + 类目 + 渠道 + 地区 + 状态 + 排序 + 高级筛选）
├─ Tab 内容
│   ├─ 意向客户：卡片网格 / 表格（分页）
│   ├─ 待筛池：只读表格（60/页，搜索）
│   └─ 跟进看板：8 列横向滚动（count + top8 + 另有 N 家）
├─ WarmCrmRecordDrawer（跟进/资料/电话/转换）
├─ 共用号码 Dialog
└─ 导入批次 Dialog（admin）
~~~

### 8.4 数据层与状态

- frontend/lib/crm/intent/：types.ts、client.ts（接口）、http-client.ts（/api/backend/v1/crm/intent）、dto-mappers.ts、use-intent-polling.ts、use-intent-filters.ts。
- 复用 CRM 布局的 CrmClientProvider？**否**：新模块独立 provider/hook，挂在 crm/layout.tsx 内或页面内，避免把新域塞进现有 CrmClient 的 40+ 方法接口；鉴权/代理仍复用既有基础设施。
- 筛选/tab/scope/page 进 URL（单一真理源，刷新可恢复）；抽屉用 ?record=<id> 便于深链。
- 写路径：乐观更新 + 失败回滚；409 冲突时用服务端返回的 current 覆盖并提示；备注 debounce 900ms + flush。
- 轮询：use-intent-polling（15s，document.hidden 暂停，focus 立即拉一次）；rev 不变不重取；手动刷新强制。

### 8.5 状态与错误

- loading：卡片/表格骨架（V4 skeleton），不整页 spinner。
- empty：区分「无数据」与「筛选无结果」，后者给「清除全部筛选」。
- error：WarmCrmState kind="error" + 重试；轮询失败不遮页面，只在同步状态显示「连接中断，正在重试」。
- 冲突/锁定：人工写冲突 409 → 提示并刷新；AI 写入锁定只在 AI 侧返回，前端只在「导入结果」中显示 skipped 数。
- 所有文案克制、可追溯；不写营销副标题/假数据/装饰 badge。

### 8.6 可访问性与桌面

- 焦点可见（V4 focus ring）、Esc 关抽屉/弹层、焦点恢复到触发元素、表格/看板键盘可达。
- prefers-reduced-motion 生效；不做第二段入场动画。
- 1440×900 验收：无页面级横向溢出；宽表只在容器内滚动；8px 外沿、22px 窗圆角、窗口填满可用视口。

### 8.7 前端测试

- page.test.tsx（provider + mock client）、卡片/表格/抽屉/看板组件测试、client/DTO mapper 测试、轮询 hook fake timers、URL 筛选状态测试。
- 复用 test-utils/stable-mocks.ts，不内联新建 useSession.data/useNotifications.notify（pnpm check:mocks）。
- E2E：路由矩阵 + 桌面 1440×900 + 导入/跟进关键路径（视范围）。

---

## 9. Go 模块与装配

### 9.1 新增文件

| 文件 | 内容 |
|---|---|
| backend-go/internal/api/crm_intent/types.go | DTO、Store 接口、枚举、错误码 |
| backend-go/internal/api/crm_intent/registrar.go | ModuleName=crm_intent；用户路由 + agent 路由注册 |
| backend-go/internal/api/crm_intent/handler_companies.go | 列表/详情/资料/电话/共用组/转换 |
| backend-go/internal/api/crm_intent/handler_followup.go | 跟进读写/版本冲突 |
| backend-go/internal/api/crm_intent/handler_batches.go | 导入（AI+人工共用 ingest）、批次查询、导出 |
| backend-go/internal/api/crm_intent/agent.go | Agent 端点（鉴权由 registrar 挂） |
| backend-go/internal/store/crm_intent.go | pgx SQL/事务/锁检查/rev 递增 |
| backend-go/tests/contract/stageXX_crm_intent_contract_test.go | 契约测试（fake store + 双鉴权） |

### 9.2 装配（backend-go/cmd/gateway/dependencies.go）

- needsDatabase 增加 cfg.OwnedModules["crm_intent"]
- objectStore 创建白名单增加 crm_intent（R2 导入归档）
- R2 创建后 append registrar：crm_intent.NewRegistrar(store.NewCRMIntentStore(primaryDB), objectStore, agentauth.NewPGXCredentialStore(primaryDB), auditSvc)
- 模块名加入 backend-go/internal/config/config.go 常量（可选，但建议 ModuleCRMIntent）
- RegisterRoutes：用户路由 router.With(requireAPIKey)；Agent 路由 router.With(agentauth.RequireAgentCredential(credentials), agentauth.RequireBusinessScope("crm_intent"), rateLimiter)

### 9.3 复用与禁止

- 复用：httpapi.WriteJSON/WriteDetail/ParsePagination、store.FullDB/RunInTx/NewTxDB、audit.Service、blob.ObjectStore、agentauth。
- 不新造：第二套鉴权、第二套审计表、第二套 CSV 基础设施（本模块自建 24 列 CSV builder 属页面专属，不晋升全局）。
- 不把新模块塞进现有 internal/api/crm 大包（独立开关/灰度）。

---

## 10. 部署与配置

| 位置 | 改动 |
|---|---|
| backend-go/internal/api/agent_credentials/validation.go | knownBusinessDomains 增加 crm_intent |
| deploy/go.env.example、deploy/local.env.example | opt-in 列表示例加入 crm_intent |
| docs/deployment/dashboard-vps-compose.md | 样例与说明同步 |

> **生产切流是显式 opt-in**（main 1b1105f2 起 `GO_API_OWNED` 默认空 = 网关全部回退 FastAPI）。两个变量名不要混：
> - 部署编排入口（`deploy/local.env.example` / `~/.config/.../deploy.env`）用的是 <code>GO_API_OWNED_MODULES=crm_intent</code>，脚本会写入容器 `go.env` 的 <code>GO_API_OWNED=crm_intent</code>；
> - 直接改容器 `go.env` 时用 <code>GO_API_OWNED=crm_intent</code>；
> - 同时设置 <code>GO_API_INTERNAL_URL=http://127.0.0.1:8200</code>，否则 Web 仍直连 FastAPI，<code>/api/v1/crm/intent</code> 会 404。
> - 导入依赖 R2：未配置 `R2_ENDPOINT_URL/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY` 时 AI/人工导入均返回 503 <code>INTENT_R2_UNAVAILABLE</code>；只读页面不受影响。
> - 部署冻结（2026-11-10）：`DEPLOYMENTS_ENABLED=true` 前禁止部署；本功能先按 `bash deploy/validate-local-go-api.sh` 做本地 Docker 验证。

- 顺序：迁移（compose migrate）→ Go 镜像（含新模块）→ Web 镜像。旧镜像不认识 crm_intent 也不会报错（OwnedModules 是 map），但页面会 404，所以 Web 必须后上或同批。
- 本地开发：默认 GO_API_OWNED 为空时网关会把该路径反代 FastAPI（404）；本地需在 env 中显式加入 crm_intent 并指向 8200。

---

## 11. 迁移与回滚

- 迁移 285 **只新增表/索引**，不改现有表；向后兼容，无需数据回填。
- 回滚应用镜像时数据库保持新表（AGENTS 规则：migration 不自动回滚）；旧代码不会碰 crm_intent_*，安全。移除 crm_intent 开关会让页面 404，所以回滚要连 Web 一起回。
- 建迁移前必须 git fetch && rebase origin/main → alembic heads 确认单 head；若 main 前进，序号顺延；并行 worktree 冲突用 alembic merge heads。
- 迁移文件命名 YYYYMMDD_285_<中文描述>.py，revision id '285'；跑 backend/scripts/check_alembic.py。

---

## 12. 测试与验收

| 层 | 要求 |
|---|---|
| 后端 | store/handler 单测 + 契约测试（用户/Agent 双鉴权、锁定拒绝、幂等、409）；迁移 285 up/down（本地 BLF_test）；T3 全量 cd backend && pytest + cd backend-go && go test ./... |
| 前端 | 目标组件/页面 vitest + 目录回归 + pnpm lint + pnpm build；T3 全量 pnpm test（含 check:mocks）；E2E 桌面 1440×900 |
| 验收 | 三视图/抽屉/导出/导入/锁定/转客户全链路；loading/empty/error/zero-data 四态；无假数据；键盘/焦点；无横向溢出 |
| Review | 独立 Reviewer（Luna/max，只读）按 AGENTS 规则复核最终 diff |

**完成定义**：本地 AI 能按 agent spec 成功导入一批数据并读到 human_touched 标记；页面能展示该批数据、写跟进后被标记人工锁；AI 再改被 409/跳过且有审计；owner 隔离生效；转客户成功并回链。

### 12.1 实施验证记录（2026-11-10）

| 项 | 结果 |
|---|---|
| backend-go <code>go test ./...</code> | 全 PASS（含 stage10 crm_intent 契约测试 + agentauth 回归测试） |
| backend <code>scripts/check_alembic.py</code> | 单 head 285、命名合规 |
| backend <code>pytest</code> | 4509 passed / 16 skipped / 2 failed（均为 <code>tests/services/test_project_reorder_grouping.py</code> 依赖 BLF_test 中 <code>is_active=false</code> 项目种子；与本次改动无关，属测试库数据基线问题） |
| frontend <code>pnpm exec vitest run</code> | 383 文件 / 2721 例全 PASS（Review 修复后复跑） |
| frontend <code>pnpm lint</code> | 0 error（8 条仓库既有 warning） |
| frontend <code>pnpm build</code> | PASS（<code>/dashboard/crm/intent</code> 已生成；Review 修复后复跑） |
| 独立 Review | 2 P0 + 9 P1 + 20 P2；P0/P1 与安全/正确性 P2 已修（详见下方「Review 修复」），复跑 Go/前端全绿 |
| 接口冒烟（真实 PG：BLF_TEST） | meta/companies/detail/facets/board/pool 200；PATCH followup 200 + version=1 + 自动认领 + human_touched=true；AI PATCH 未锁记录 200、同 Idempotency-Key 重放 200、已锁记录 409 <code>INTENT_RECORD_LOCKED</code>；convert 200 写 crm_customers ∪ crm_contacts；CSV 导出 28 列 + RFC5987 文件名 |
| Playwright 桌面路由矩阵 | 未执行成功：本地 <code>pnpm dev</code> 冷启动超 120s、<code>CI=1 pnpm start</code> 与 <code>output: standalone</code> 不兼容（既有测试基建问题）；路由注册已由 vitest 路由矩阵 + build 产物覆盖 |

实施中发现并修复：① <code>GetFacets</code> 在 scope=all 时把 <code>and ...</code> 直接拼到无 <code>where</code> 的 SQL 上导致 meta/facets 500（改用 <code>andWhere</code>）；② 渠道 facet 查询返回两列但按单列扫描导致 500（改为单列）；③ Go <code>agentauth.TouchLastUsed</code> 缺少 <code>::timestamptz</code> 强制转换，导致 agent 凭据首次使用 401（已加回归测试）。

### 12.2 Review 修复（2026-11-10）

独立 Reviewer（只读）结论「需修复后合并」，2 个 P0 与 9 个 P1 已全部处理：

- **P0-1**：详情支持可选 <code>?scope=mine|all|sea</code>；非 admin 空 scope 使用「我的 ∪ 待领取」可见性，恢复 sea 详情与领取链路（前端同步透传 scope）。
- **P0-2**：<code>dup=true</code> 改为 <code>phone_normalized in (select ... group by having count(distinct company_id) &gt;= 2)</code>，与 <code>stats.dup_groups</code> 同口径，并加真实 PG 集成测试。
- **P1**：convert 时 sea 记录客户 owner 回退为操作人；抽屉新增「编辑资料」（含 channel/channels/channel_source，BE 已支持）；customer_radar 同步 CRM zod/导入映射；公司/池搜索支持手机号；批量导入改为逐行 SAVEPOINT + external_id/phone_raw/资本上限校验；Agent 审计补齐（成功 upsert 的 agent_id、PATCH/screen 锁定 ai_write_blocked）；导出文件名改用批次日期；CSV 公式注入防护；AI 不再改 batch_id；R2 附着失败清理；模型 CHECK 约束改为 SQLite 兼容写法；validPhones 去重；facet 渠道 pool 分支按 scope 收敛。
- 复跑：<code>go test ./...</code> 全 PASS（含真实 PG 门控的 dup/savepoint 测试）；前端 <code>pnpm test</code> 383 文件 / 2721 例 PASS；<code>pnpm lint</code> 0 error；<code>pnpm build</code> PASS；<code>pytest</code> 4509 passed / 16 skipped / 2 failed（仍为 BLF_test 缺 <code>is_active=false</code> 项目种子的既有基线，与本功能无关）。

---

## 13. 分期（设计稿阶段，实施以 plan 为准）

| 阶段 | 内容 |
|---|---|
| P0 | 本 spec + agent spec review；契约冻结 |
| P1 | 迁移 285 + SQLAlchemy 模型 + Go 骨架 + 批次导入/锁定/R2 |
| P2 | 用户读接口（meta/companies/facets/board/pool）+ 统计 + 轮询 rev |
| P3 | 用户写接口（followup/claim/profile/phones/共用组/convert）+ 导出 + 审计 |
| P4 | Agent 接口 + scope 白名单 + 幂等 + 锁定拒绝 + 契约测试 |
| P5 | 前端 V4 页面（三视图/抽屉/筛选/轮询） |
| P6 | 前端写路径 + 导入 UI + 导出 + 冲突 + 转为客户 + 验收 |

---

## 14. 风险

1. **GO_API_OWNED 生产陷阱**：只写 Go 不改部署脚本 → 线上 404；必须同批改三处脚本 + 文档。
2. **迁移双轨**：Go 无 runner；必须同时加 SQLAlchemy 模型；head 285 实施时复核。
3. **人工锁的一致性**：所有人工写必须经过同一 store 方法设置 human_touched_at；AI 写入必须带 WHERE human_touched_at IS NULL，否则有绕过风险（store 封装 + 契约测试覆盖）。
4. **R2 未配置**：导入 fail-closed；本地开发需要 R2 env 或用测试桶。
5. **Next 代理限制**：人工导入 >4.5MB 需分片；AI 直连 Go 不受限。
6. **V4 视觉落地**：草稿字段/交互多，注意不要为了信息量堆次级文案；级别/状态只用 4 个 tone + 文字。
7. **手机号合规**：号码是个人数据；导出/查看按 scope，导出写审计；AI 读接口不暴露备注。

---

## 15. 附录：草稿字段 → DB → API

| 草稿字段 | DB 列 | 导入必填 | 备注 |
|---|---|---|---|
| id（demo-c01） | id（自增）/ external_id | 否 | external_id 保留流水线行 id |
| name | name/name_key | 是 | name 是 upsert 键之一 |
| creditCode | credit_code | 否 | 有则优先作为 upsert 键 |
| legalPerson | legal_person | 否 | |
| phones[] | crm_intent_phones.phone_raw/normalized | 否 | 归一化去重 |
| province/city | province/city | 否 | |
| foundedYear | founded_year | 否 | |
| registeredCapital（"300万人民币"） | registered_capital_wan（数值万元） | 否 | 字符串导入拒绝该行 |
| products | products | 否 | 前端切 chips |
| category | category | 否 | 无白名单 |
| trademarks[]/trademarkCount | trademarks jsonb / trademark_count | 否 | count 可大于数组 |
| intentLevel/intentScore/intentBasis | intent_level/intent_score/intent_basis | 否 | A–D / 0–100 |
| amazonFit/walmartFit | amazon_fit/walmart_fit | 否 | |
| sources[] | sources jsonb | 否 | 仅 http(s) 入库 |
| risks | risks | 否 | |
| screenedAt/batch | screened_at / batch_id | 否 | 批次由导入决定 |
| phoneNote | phone_note | 否 | 草稿死字段，保留 |
| status{}（state/note/phoneOverride/lastContactAt/nextContactAt/validPhones/by/updatedAt） | crm_intent_followups + crm_intent_phones + owner | — | 人工写入，导入不写 |
| stats{} | 服务端实时计算 | — | 不用草稿的 stats 结构 |
| meta.version/updatedAt/batch/source | crm_intent_batches + crm_intent_meta | — | |
