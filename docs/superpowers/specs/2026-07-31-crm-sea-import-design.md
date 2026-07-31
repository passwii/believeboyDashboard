# CRM 公海导入客户 — 设计文档（Spec）

- **日期**：2026-07-31
- **作者**：Damon（与纪亚伟 brainstorming 拍板）
- **状态**：待用户复核 → 转 writing-plans
- **关联**：CRM 客户管理模块（`frontend/components/crm/`、`backend/app/services/crm/`、`backend/app/api/v1/endpoints/crm.py`）

---

## 1. 背景与目标

CRM 公海（`owner_id IS NULL` 的客户池）目前只能靠「单条新建客户时不选负责人」或「把已有客户释放到公海」来 пополнение。销售团队手上往往攒着一批客户（Excel 台账或临时复制的一坨），需要**一次性批量导入到公海**，供全员领取。

**目标**：在公海页提供「导入客户」入口，支持**粘贴**与 **Excel 上传**两种方式，批量把新客户写入公海（`owner_id=NULL`），带去重、校验、错误报告与失败明细下载。

**附带目标**：修复 brainstorming 探索时发现的隐藏 bug——**单条新建客户表单填的联系人/电话/邮箱被静默丢弃**（根因与导入的联系人处理同源，一并修复）。

## 2. 范围

### In scope
1. 公海批量导入功能（前端解析 + 预览 + 后端批量入公海端点）。
2. 导入模板下载（Excel）。
3. 失败明细下载（Excel）。
4. 修复单条新建客户丢联系人的 bug（后端 `create_customer` 建主联系人 + 前端 payload 不再剔除 contact 字段）。

### Out of scope（明确不做，走独立后续 plan）
- CRM table 细节补强：关键词搜索框、每页条数选择器、吸顶表头、跳页、公海表升级（进公海时长列 / 筛选 / 搜索 / 导出）、列显隐、跨页全选等（见评审 P0/P1 清单）。
- 异步/ Celery 大批量导入（本次同步 + 单次上限 1000 行）。
- 覆盖更新已存在客户（本次纯新增、重复跳过）。
- 线索（Lead）导入。

## 3. 关键决策记录（brainstorming 拍板）

| # | 问题 | 决策 |
|---|------|------|
| Q1 | 数据形态 | **C+A**：粘贴（TSV）打底 + Excel 模板上传兜底 |
| Q2 | 重复处理 | **纯新增、跳过现有**；去重键 = 客户名 + 联系电话 |
| Q3 | 格式错误行 | **部分成功**：合法行进、非法行跳过并进错误报告，失败明细可下载；仅「客户名」硬必填 |
| Q4 | 单次规模 | **同步 + 单次 ≤1000 行**，超了提示分批（YAGNI，不上 Celery） |
| 方案 | 实现路径 | **方案 A**：前端 exceljs/TSV 解析 + 预览，后端新增批量入公海端点（JSON），复用现有 JSON 代理 / exceljs / batch 范式 |
| 附加 | 联系人 bug | 与导入同根因，**一并修复**，共享建联系人代码路径 |

## 4. 架构与数据流

```
公海页「导入客户」按钮 → CrmImportSea Sheet（三步）
  Step1 输入：[粘贴 textarea → TSV 解析] | [上传 .xlsx/.xls → exceljs 读首 sheet]
            + 「下载模板」按钮（exceljs 生成）
  → 归一化为 ParsedRow[]（按中文表头映射到字段 + 枚举标签↔值转换）
  Step2 预览：表格逐行前端校验（✓ / ✗ 错因），可删坏行，显示「共 N 行 · X 行有误」
  → 确认 → client.importCustomersToSea(rows)
            → POST /api/backend/v1/crm/customers/import-sea (JSON {rows})
            → 后端 import_customers_to_sea：
                逐行 校验 → 去重跳过 → 插入 CrmCustomer(owner_id=NULL)
                → 有联系人则建主联系人 → 逐条 create 审计 → 单次 db.commit()
            → 返回 {created, skipped_dupes, failed[{row,field,reason}]}
  Step3 结果：「成功 N · 跳过 M（已存在）· 失败 K」+ 「下载失败明细」+ refreshKey++ 刷公海表
```

**为什么前端解析而非服务端 multipart**：Next 代理（`app/api/backend/[...path]/route.ts`）是通用 fetch 转发，JSON POST 路径已被 `createCustomer` 验证；`exceljs` 已是前端依赖且大量用于导出/读取上传文件。前端解析复用现成 JSON 代理（零代理改动）、可做上传前即时预览，体验最好。校验逻辑前后端各一份（前端为体验、后端为安全兜底），是批量导入的合理代价。

## 5. 后端设计

### 5.1 端点

`backend/app/api/v1/endpoints/crm.py`，mirror 现有 `batch_move_to_sea` 范式：

```python
@router.post("/customers/import-sea", response_model=CustomerSeaImportResult)
def import_customers_to_sea(
    payload: CustomerSeaImportRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    result = customer_service.import_customers_to_sea(db, payload.rows, user_id=user_id)
    # 审计在 service 内逐条记录（commit=False），service 末尾单次 commit
    return result
```

> 路由注册顺序注意：`/customers/import-sea` 必须声明在 `/customers/{customer_id}` 之前，否则 `import-sea` 会被当成 `customer_id` 路径参数。（现有 `/customers/batch-move-sea` 已在 `{customer_id}` 之前，照其位置放。）

### 5.2 Schema（`backend/app/schemas/crm.py`）

```python
class CustomerSeaImportRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    short_name: str | None = None
    industry: str | None = None
    customer_type: str | None = None      # 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 代运营/AI运营/运营服务/其他
    rating: str | None = None             # A/B/C/D；None → 默认 C
    status: str | None = None             # active/lost/signed/on_hold；None → 默认 active
    source: str | None = None             # referral/exhibition/online_ad/cold_call/other
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None
    # 联系人（任一非空且 contact_name 非空 → 建主联系人）
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None

class CustomerSeaImportRequest(BaseModel):
    rows: list[CustomerSeaImportRow] = Field(min_length=1, max_length=1000)

class CustomerSeaImportFailItem(BaseModel):
    row: int                 # 1-based，对应前端预览行号
    field: str | None = None
    reason: str

class CustomerSeaImportResult(BaseModel):
    created: int
    skipped_dupes: int
    failed: list[CustomerSeaImportFailItem]
```

> `rows` 超 1000 → Pydantic 422（前端也会先拦，双保险）。

### 5.3 Service（`backend/app/services/crm/customer_service.py`）

新增 `import_customers_to_sea(db, rows, *, user_id, commit=True) -> dict`：

```python
# 枚举允许集（与模型/前端一致）
_RATINGS = {"A", "B", "C", "D"}
_STATUSES = {"active", "lost", "signed", "on_hold"}
_SOURCES = {"referral", "exhibition", "online_ad", "cold_call", "other"}
_CUSTOMER_TYPES = {"工厂", "贸易商", "同行", "其他"}
_INTERESTED_SERVICES = {"代运营", "AI运营", "运营服务", "其他"}

def _norm_name(s: str | None) -> str:
    return (s or "").strip()

def _norm_phone(s: str | None) -> str:
    # 去空格/连字符，用于去重键
    return "".join(ch for ch in (s or "") if ch not in " -")

def import_customers_to_sea(db, rows, *, user_id, commit=True) -> dict:
    cur = _current_user_id(user_id)
    created = 0
    skipped_dupes = 0
    failed: list[dict] = []
    seen_keys: set[tuple[str, str]] = set()   # 批内去重

    for idx, row in enumerate(rows, start=1):
        name = _norm_name(row.name)
        # --- 校验 ---
        if not name:
            failed.append({"row": idx, "field": "name", "reason": "客户名必填"}); continue
        if row.rating and row.rating not in _RATINGS:
            failed.append({"row": idx, "field": "rating", "reason": f"等级无效：{row.rating}"}); continue
        if row.status and row.status not in _STATUSES:
            failed.append({"row": idx, "field": "status", "reason": f"状态无效：{row.status}"}); continue
        if row.source and row.source not in _SOURCES:
            failed.append({"row": idx, "field": "source", "reason": f"来源无效：{row.source}"}); continue
        if row.customer_type and row.customer_type not in _CUSTOMER_TYPES:
            failed.append({"row": idx, "field": "customer_type", "reason": f"对象类型无效：{row.customer_type}"}); continue
        if row.interested_service and row.interested_service not in _INTERESTED_SERVICES:
            failed.append({"row": idx, "field": "interested_service", "reason": f"意向服务无效：{row.interested_service}"}); continue
        if row.contact_email and not _is_email(row.contact_email):
            failed.append({"row": idx, "field": "contact_email", "reason": "邮箱格式不正确"}); continue

        # --- 去重（DB 已有 + 批内）---
        phone_key = _norm_phone(row.contact_phone)
        key = (name, phone_key)
        if key in seen_keys:
            skipped_dupes += 1; continue
        if _is_duplicate(db, name, phone_key):
            skipped_dupes += 1; seen_keys.add(key); continue
        seen_keys.add(key)

        # --- 插入客户（强制 owner_id=None 落公海）---
        cust = CrmCustomer(
            name=name,
            short_name=row.short_name or None,
            industry=row.industry or None,
            customer_type=row.customer_type or None,
            interested_service=row.interested_service or None,
            rating=row.rating or "C",
            status=row.status or "active",
            source=row.source or None,
            owner_id=None,                 # ← 公海
            address=row.address or None,
            website=row.website or None,
            annual_revenue=row.annual_revenue,
            employee_count=row.employee_count,
            remark=row.remark or None,
            created_by=cur,
        )
        db.add(cust)
        db.flush()  # 拿 cust.id

        # --- 建主联系人（contact_name 非空才建）---
        if _norm_name(row.contact_name):
            contact_service.create_contact(
                db, cust.id,
                ContactCreate(
                    name=_norm_name(row.contact_name),
                    phone=row.contact_phone or None,
                    email=row.contact_email or None,
                    is_primary=True,
                ),
                commit=False,
            )

        # --- 审计（commit=False，随末尾单次 commit）---
        audit_service.record_log(
            db, entity_type="customer", entity_id=cust.id,
            action="create", actor_id=cur, summary="公海导入",
        )
        created += 1

    if commit:
        db.commit()
    return {"created": created, "skipped_dupes": skipped_dupes, "failed": failed}
```

**去重语义说明**：
- 键 = (客户名 strip+lower, 电话去空格连字符)。
- `_is_duplicate(db, name, phone_key)`：
  1. 查所有 `is_deleted=False` 且名字 strip+lower 命中 `name` 的客户 id 列表 `match_ids`。
  2. `match_ids` 为空 → 非重复。
  3. `phone_key` 为空 → **重复**（仅按名字，同名即重复）。
  4. `phone_key` 非空 → 查 `CrmContact.customer_id IN match_ids` 的电话，任一 norm 后 == `phone_key` 则**重复**；否则非重复（允许同名不同电话）。
- 批内用 `seen_keys` 去重，同文件重复行第二行起跳过。
- DB 判重只查 `is_deleted=False`。

> `_is_phone/email` 等辅助：`_norm_name`/`_norm_phone` 见上；`_is_email` 用简单正则。辅助函数放本文件内。

**事务性**：坏行/重复行从不 `db.add`，只有好行入事务；末尾单次 `db.commit()` 原子提交所有成功行。若中途 DB 异常，整批回滚（可接受——报告失败让用户重导）。

### 5.4 迁移

**预计零迁移**：客户表 `crm_customers` 不动（无新列）；联系人走现有 `crm_contacts` 表；审计走现有 `crm_audit_logs` 表。`CustomerCreate` 加 contact 字段是 schema 层（非表结构）。**实现时若发现确需改表，按 AGENTS.md 迁移命名规则（纯数字短 rev-id）单独建迁移。**

## 6. 前端设计

### 6.1 列定义与枚举映射（精确表）

模板与解析共用一份列定义 `CRM_IMPORT_COLUMNS`（建议放 `frontend/lib/crm/constants/import-columns.ts`）：

| 中文表头 | 字段 | 必填 | 类型/取值 | 映射 |
|---------|------|:---:|----------|------|
| 客户名 | name | ✓ | 文本 | 直接 |
| 简称 | short_name | | 文本 | 直接 |
| 行业 | industry | | 文本 | 直接 |
| 对象类型 | customer_type | | 工厂/贸易商/同行/其他 | 值=标签（中文） |
| 意向服务 | interested_service | | 代运营/AI运营/运营服务/其他 | 值=标签（中文） |
| 等级 | rating | | A/B/C/D | 标签「A 级（高价值）」→ 值 `A`（取首字母；亦直接接受 A/B/C/D） |
| 状态 | status | | 活跃/已流失/已签约/暂缓 | 标签→值（`CUSTOMER_STATUS_LABELS` 反查） |
| 来源 | source | | 转介绍/展会/线上广告/陌拜/其他 | 标签→值（`CUSTOMER_SOURCE_LABELS` 反查） |
| 联系人 | contact_name | | 文本 | 直接（非空才建联系人） |
| 联系电话 | contact_phone | | 文本 | 直接 |
| 联系邮箱 | contact_email | | 邮箱 | 直接 |
| 地址 | address | | 文本 | 直接 |
| 网站 | website | | 文本 | 直接 |
| 年营收 | annual_revenue | | 数字 | `Number()`，空→undefined |
| 员工数 | employee_count | | 整数 | `Number()`，空→undefined |
| 备注 | remark | | 文本 | 直接 |

**标签↔值反查表**（解析时用，来自现有常量）：
- status：活跃→active、已流失→lost、已签约→signed、暂缓→on_hold
- source：转介绍→referral、展会→exhibition、线上广告→online_ad、陌拜→cold_call、其他→other
- rating：接受 `A/B/C/D`（大小写均可）或从「A 级…」取首字母；空→默认 C
- customer_type / interested_service：中文值直接入站（值==标签）

### 6.2 组件 `components/crm/crm-import-sea/`

```
crm-import-sea/
  index.tsx              # CrmImportSea：Sheet 容器 + 三步状态机
  parse.ts               # parseTsv(text)→ParsedRow[]；mapSheetRows(json)→ParsedRow[]；枚举反查；前端校验 validateRows()
  template.ts            # buildImportTemplate()→ exceljs 生成 xlsx 下载
  types.ts               # ParsedRow / RowStatus / ImportResult
  index.test.ts(x)       # 解析/校验/映射单测
```

**Step 1 输入**：
- Tabs：「粘贴」/「上传 Excel」。
  - 粘贴：`<Textarea>`，`parseTsv` 按 `\n` 分行、`\t` 分列；首行当表头。
  - 上传：`<input type="file" accept=".xlsx,.xls">`，`exceljs` `workbook.xlsx.load(arrayBuffer)` 读首个 worksheet，`sheet.getSheetValues()` 转二维数组，首行表头。
- 「下载模板」：`buildImportTemplate()` 用 exceljs 建 sheet——表头行（16 列中文）+ 枚举提示（第二行灰字写取值，如「等级」列写「A/B/C/D」）+ 2 行示例数据；`writeBuffer()` 触发下载 `客户导入模板.xlsx`。

**表头匹配**：trim 后按中文名匹配到字段；缺列允许（该字段空）；多余列忽略；「客户名」列缺失 → 整体报错提示。

**Step 2 预览**：
- 表格展示 `ParsedRow[]`，每行状态：`✓ 可导入` / `✗ <错因>`。
- 前端校验 `validateRows`：客户名必填；枚举值合法（status/source/rating/customer_type/interested_service）；邮箱格式。**重复与否前端不判（需后端 DB），提交时定。**
- **软提示（⚠ 非 ✗，不阻止导入）**：有联系电话/邮箱但无联系人姓名 → 提示「无联系人姓名，电话/邮箱将不保存」——与本次「不再静默丢数据」主旨一致，让用户知情。
- 每行可「删除」（剔除坏行/多余行）。
- 顶部统计：「共 N 行 · X 行有误」；有 ✗ 行时「确认导入」按钮文案提示「将跳过 X 行错误」。

**Step 3 结果**：
- 调 `client.importCustomersToSea(validRows)` 得 `{created, skipped_dupes, failed}`。
- 展示：「成功 {created} · 跳过 {skipped_dupes}（已存在）· 失败 {failed.length}」。
- `failed.length > 0` → 「下载失败明细」按钮：exceljs 生成 xlsx，列 = 原 16 列 + 「错因」列（按 `failed[].row` 1-based 回填原行 + reason），下载 `客户导入失败明细.xlsx`。
- 成功后 `onImported()` 回调 → 公海表 `refreshKey++`。

### 6.3 入口

`frontend/app/dashboard/crm/sea/page.tsx` header 加「导入客户」按钮（`Upload` 图标），打开 `CrmImportSea` Sheet。

### 6.4 API client

- `frontend/lib/crm/api/crm-client.ts`：接口加
  ```ts
  importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult>
  ```
  + 类型 `CustomerSeaImportRow` / `CustomerSeaImportResult` / `CustomerSeaImportFailItem`（`frontend/lib/crm/types/`）。
- `http-crm-client.ts`：`POST /customers/import-sea`，body `{rows: rows.map(toImportRowPayload)}`（驼峰→下划线）。
- `mock-crm-client.ts`：内存实现（去重/校验/计数），供 mock 模式与测试。

## 7. 单条新建丢联系人 bug 修复

**根因**：`CrmFormCreate` 收集 contactName/contactPhone/contactEmail，但 `toCustomerPayload`（`dto-mappers.ts:330`）剔除这三字段，后端 `CustomerCreate` 与 `CrmCustomer` 模型又无联系人列 → 联系人静默丢失。

**修复（方案 a：后端原子建联系人，与导入共享路径）**：
1. **后端 schema**：仅 `CustomerCreate` 增可选 `contact_name/contact_phone/contact_email`（`CustomerUpdate` 不加——编辑客户的联系人走独立的联系人 Tab，本次不涉及）。
2. **后端 service**：`create_customer` 在 `contact_name` 非空时调 `contact_service.create_contact(commit=False)` 建主联系人（复用 §5.3 同一逻辑）。
3. **前端 payload**：`toCustomerPayload` 增发 `contact_name/contact_phone/contact_email`（不再剔除）。
4. **前端测试**：更新 `dto-mappers.test.ts` 中「toCustomerPayload 剔除 contact 展示字段」断言 → 改为「正确携带 contact 字段」。
5. **后端测试**：新增「create_customer 带 contact 字段 → 建成主联系人」。

> 编辑客户（update）暂不处理联系人增删（联系人有独立的联系人 Tab 管理）；本次仅修「新建时丢失」。

## 8. 测试计划

### 后端（`backend/tests/.../crm/`）
- 导入 happy path：3 行合法 → created=3，DB 中 owner_id 均为 None（在公海），审计 3 条 action=create summary=公海导入。
- 带联系人行 → `crm_contacts` 有对应主联系人（is_primary=True）。
- 重复跳过：与库中已有（名字+电话）重复 → skipped_dupes；批内两行相同 → 第二行跳过。
- 校验失败：缺客户名 / 等级=X / 邮箱格式错 → 进 failed，不插入，field/reason 正确。
- 部分成功混合：好行插入、坏行 failed、重复 skipped，三者计数正确且单次 commit。
- >1000 行 → 422。
- 单条新建带 contact 字段 → 建主联系人（bug 修复回归）。

### 前端（Vitest）
- `parseTsv`：标准 TSV、缺列、多余列、空行、表头 trim。
- 枚举反查：status/source 标签→值、rating「A 级…」→A、中文值直传。
- `validateRows`：缺名/非法枚举/坏邮箱标 ✗；有电话无联系人姓名标 ⚠。
- 删行后计数更新。
- 结果渲染：created/skipped/failed 文案；failed>0 显示下载按钮。
- mock client `importCustomersToSea` 去重/计数。
- `toCustomerPayload` 携带 contact 字段（bug 修复）。
- 模板生成：表头 16 列、含提示行（可对 buffer 反解断言或仅断言调用 exceljs）。

## 9. 交付门禁与部署

按 `AGENTS.md`：
- 后端：`cd backend && pytest`（CRM 相关全绿）。
- 前端：`pnpm lint` → `pnpm build` → `pnpm test` 顺序全绿。
- Commit：中文 Conventional Commits（feat(crm): 公海批量导入客户 / fix(crm): 修复新建客户丢失联系人）。
- 迁移：预计零迁移；若需则纯数字短 rev-id、建前 rebase main 取单链。
- 推送：`git deploy`（命中 `backend/` 自动部署 VPS；前端 Vercel 自动）。
- 业务验收（交用户手动）：粘贴 3 行导入成功并在公海可见可领取；上传 Excel 模板填好导入；重复导入跳过；坏行下载失败明细；单条新建客户后联系人 Tab 有联系人。

## 10. 风险与后续

- **风险**：exceljs 读 `.xls`（旧二进制格式）支持有限——模板与上传均以 `.xlsx` 为主，`.xls` 尽力解析、失败给明确提示。
- **风险**：去重电话匹配需 join `crm_contacts`，大批量时 N 次查询——1000 行内可接受；如成瓶颈后续改批量预取。
- **后续（独立 plan）**：CRM table 细节补强（搜索框 / 每页条数 / 吸顶表头 / 公海表升级：进公海时长列 + 筛选 + 搜索 + 导出）；异步大批量导入；线索导入；覆盖更新模式。
