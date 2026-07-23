# CRM P1b · 线索 + 跟进 + 转化 实现计划（精简版）

> **面向 AI 代理的工作者：** 必需子技能：superpowers:subagent-driven-development（推荐）或 superpowers:test-driven-development 逐任务实现。步骤用复选框跟踪。

**目标：** 在 P1a（客户/联系人/用户已上线 prod）基础上，把**线索 Lead + 跟进 Follow + 转化 convert_lead** 落真实后端并接通前端，完成销售核心闭环：**线索挑选 → 电话/微信推进（记跟进）→ 转化为客户（跟进记录一起搬）→ 客户维护**。同时**移除商机 Opportunity** 前端界面（后端空表保留不 drop）。

**业务背景（用户拍板 2026-07-23）：** B2B 服务业——卖亚马逊代运营 / AI 运营 / 运营服务，对象=工厂 / 贸易商 / 同行。一个客户基本一锤子买卖，**丢弃商机层**。

---

## 0. 已确认的产品决策（设计输入）

| 决策 | 内容 |
|---|---|
| 漏斗 | 线索 Lead → 转化 → 客户 Customer(+联系人 Contact) + 跟进 Follow。**无商机**。 |
| 转化搬数据 | `convert_lead` 事务内把该线索的 `crm_follows`（entity_type=lead）改挂到新客户（entity_type=customer），**历史不丢**。 |
| 公海/线索池 | 保留。`owner_id=null` 即公海（客户）/线索池（线索）。**绝不删历史**——二次跟进有价值，跟进/联系人/细节全留。线索支持 transfer / move-to-pool / claim（镜像客户）。 |
| 跟进粒度 | 分类型（电话/微信/拜访/备注）+ `next_follow_at` 下次跟进提醒。 |
| 新字段 | `customer_type`（工厂/贸易商/同行/其他）+ `interested_service`（代运营/AI运营/运营服务/其他），加在 `crm_leads` + `crm_customers`。 |
| 联系人微信 | `crm_contacts` 加 `wechat`（B2B 核心），转化时 `lead.wechat → contact.wechat`。 |
| 线索删除 | 不做物理/软删端点；弃置用 `status=discarded`（对齐前端 `CrmClient` 无 `deleteLead`）。 |

## 0.1 前置约定（沿用 P1a，开工前必读）

- 路由前缀 `/api/v1/crm/...`（`router = APIRouter(prefix="/crm", dependencies=[Depends(protected)])`，挂 `/api/v1`）。
- 身份：`user_id: str | None = Depends(get_request_user_id)`（UUID 字符串）；`owner_id`/`created_by` 存 `str`（user_accounts.id UUID）。
- 测试基建：根 `conftest.py` 提供 `db_session`/`settings`/种子账号/`admin_headers`/`operator_headers`/`businessdev_headers`；`backend/.env.test` 已配 `TEST_DATABASE_URL`。
- **集成测试隔离**：端点调用走独立 session 并 commit，`db_session` 回滚清不掉 → 用 `tests/api/crm/conftest.py` 的 autouse `TRUNCATE ... RESTART IDENTITY CASCADE` 夹具（P1a 已建好）。
- 模型/迁移/Schema 风格照抄 P1a（`Mapped`/`mapped_column`、`op.add_column` 幂等守卫、Pydantic v2 `from_attributes`、列表响应 `{items,total,page,page_size}`）。
- 前端经 Next 代理 `/api/backend/v1/crm/...`，`http-crm-client.ts` 只设 `Content-Type`，鉴权头由代理注入。int↔string、snake↔camel 逐字段映射。
- Commit：中文 Conventional Commits，`feat(crm)`/`test(crm)`/`chore(crm)`，subject ≤50 字无句号，每任务末尾一次 commit。

---

## 1. 文件结构

### 后端（创建）
| 文件 | 职责 |
|---|---|
| `backend/alembic/versions/20260723_218_crm_lead_fields.py` | leads/customers 加 customer_type+interested_service；contacts 加 wechat |
| `backend/app/services/crm/lead_service.py` | lead CRUD + scope(mine/all/pool) + keyword + 分页 + 池操作(transfer/move-pool/claim) |
| `backend/app/services/crm/follow_service.py` | follow 列表/创建 + 回写客户 last_follow_at |
| `backend/app/services/crm/permissions.py` | 操作级权限：scope 收紧 / 指派仅管理员 / 非自己名下写操作 403 |
| `backend/tests/services/crm/test_lead_service.py` | lead service 单测 |
| `backend/tests/services/crm/test_follow_service.py` | follow service 单测 |
| `backend/tests/services/crm/test_convert_lead.py` | convert_lead 事务单测（重点） |
| `backend/tests/api/crm/test_leads_api.py` | lead 端点集成测试 |
| `backend/tests/api/crm/test_follows_api.py` | follow 端点集成测试 |
| `backend/tests/api/crm/test_convert_api.py` | convert 端点集成测试 |

### 后端（修改）
| 文件 | 改动 |
|---|---|
| `backend/app/models/crm.py` | CrmLead/CrmCustomer 加 `customer_type`/`interested_service`；CrmContact 加 `wechat` |
| `backend/app/schemas/crm.py` | Lead*/Customer*/Contact* schema 补新字段；确认 Follow* 已具备 type/content/next_follow_at |
| `backend/app/api/v1/endpoints/crm.py` | 加 lead CRUD + convert + 池操作 + follow list/create 路由 |

### 前端（修改）
| 文件 | 改动 |
|---|---|
| `frontend/lib/crm/types/lead.ts` | Lead/LeadInput 加 `customerType`/`interestedService` |
| `frontend/lib/crm/types/customer.ts` | Customer/CustomerInput 加 `customerType`/`interestedService`；Contact 加 `wechat` |
| `frontend/lib/crm/api/dto-mappers.ts` | lead/follow 映射 + 新字段 + contact.wechat |
| `frontend/lib/crm/api/http-crm-client.ts` | 实现 lead/follow/convert/池方法（替换 notImplemented 桩） |
| `frontend/lib/crm/api/mock-crm-client.ts` | 同步 lead/follow 行为（保接口一致 + 单测） |
| `frontend/app/dashboard/crm/leads/page.tsx` + 详情 Drawer | 接真实 client：列表/详情/跟进时间线/转化按钮 |

### 前端（删除/移除商机）
| 文件 | 处理 |
|---|---|
| `frontend/app/dashboard/crm/opportunities/page.tsx` | 删页面 |
| `frontend/components/crm/opportunity-table.tsx`、`crm-opportunity-form/` | 删组件 |
| `frontend/lib/crm/types/opportunity.ts`、`field-defs/opportunity.ts`、`enums/opportunity.enum.ts`、`mock-data/opportunities.fixture.ts` | 删 |
| `crm-client.ts`/`http-crm-client.ts`/`mock-crm-client.ts` 的 opportunity 方法 | 删 |
| sidebar/nav 的商机入口 | 删 |
| `frontend/lib/crm/types/follow.ts` 的 `Opportunity` 引用 | 清理（FollowEntityType 去掉 opportunity 或保留无害） |

---

## P1b 后端任务

### 任务 1：迁移 218 + 模型字段

- [ ] 步骤 1：`cd backend && alembic heads` 确认当前 head（应为 217）；新迁移 `down_revision` 指向它。
- [ ] 步骤 2：写迁移 `20260723_218_crm_lead_fields.py`（revision id `20260723_218`）：
  - `crm_leads` 加 `customer_type String(20) nullable`、`interested_service String(30) nullable`
  - `crm_customers` 加 `customer_type String(20) nullable`、`interested_service String(30) nullable`
  - `crm_contacts` 加 `wechat String(100) nullable`
  - `upgrade` 用 `inspector.has_column` 幂等守卫；`downgrade` 删列。
- [ ] 步骤 3：`app/models/crm.py` 三个模型加对应 `Mapped[str | None]` 字段。
- [ ] 步骤 4：测试库 `alembic upgrade head` 验证；`python -c "import app.models.crm"` 无报错。
- [ ] 步骤 5：Commit `feat(crm): 线索/客户加对象类型+意向服务, 联系人加微信`

### 任务 2：Schema 补字段

- [ ] LeadCreate/LeadUpdate/LeadItem 加 `customer_type`/`interested_service`（LeadItem 已有 owner_name）。
- [ ] CustomerCreate/CustomerUpdate/CustomerItem 加 `customer_type`/`interested_service`。
- [ ] ContactCreate/ContactUpdate/ContactItem 加 `wechat`。
- [ ] 确认 FollowCreate（entity_type/entity_id/type/content/next_follow_at）、FollowItem 已就绪。
- [ ] 验证导入；Commit `feat(crm): schema 补对象类型/意向服务/微信字段`

### 任务 3：lead_service（TDD）

- [ ] 先写 `test_lead_service.py`（红）：list scope mine/all/pool、keyword、create 默认归创建人、update、discard(status)、transfer/move-pool/claim。
- [ ] 实现 `lead_service.py`（绿）：镜像 customer_service 结构；`scope=sea`→`owner_id IS NULL`（线索池）；`_to_item` 带 owner_name。
- [ ] Commit `feat(crm): 线索 service(CRUD/scope/线索池)`

### 任务 4：follow_service（TDD）

- [ ] 先写 `test_follow_service.py`（红）：list 按 created_at desc、create 带 type/content/next_follow_at、create 对 customer 回写 last_follow_at。
- [ ] 实现 `follow_service.py`（绿）。
- [ ] Commit `feat(crm): 跟进 service(列表/创建/回写最后跟进)`

### 任务 5：convert_lead 事务（TDD，重点）

- [ ] 先写 `test_convert_lead.py`（红），覆盖：
  - 建客户：name 取 override.name 或 lead.company 或 lead.name；customer_type/interested_service/source 带过去；owner_id=lead.owner_id；rating 默认 C。
  - 建主联系人：name=lead.name、phone/email/wechat 带过去、is_primary=True。
  - **re-parent follows**：该线索的 follows 全部 entity_type 变 customer、entity_id 变新客户 id。
  - 标记线索 converted：status=converted、converted_to_customer_id、converted_at。
  - 已转化线索再转化 → 报错；不存在线索 → None。
  - 事务原子性：任一步失败整体回滚。
- [ ] 实现 `convert_lead`（绿，单事务 commit）。
- [ ] Commit `feat(crm): 线索转客户事务(带跟进搬迁)`

### 任务 6：路由接通

- [ ] `crm.py` 加：`GET/POST /leads`、`GET/PATCH /leads/{id}`、`POST /leads/{id}/convert`、`POST /leads/batch-transfer`、`POST /leads/batch-move-pool`、`POST /leads/{id}/claim`、`GET /follows?entity_type=&entity_id=`、`POST /follows`。
- [ ] Commit `feat(crm): 线索/跟进/转化 API 路由`

### 任务 6b：权限层（TDD）

> **决策（2026-07-23）**：MVP 用 `is_admin` 二分（`deps.get_request_is_admin`）。全部(all)⊇我的(mine)。

- [ ] 先写 `test_permissions.py`（红）：
  - 普通销售 `scope=all` → 降级为 mine（只看到自己名下），或按实现返回 403（二选一，计划采“降级为 mine”）。
  - 普通销售 `batch-transfer`（指派）→ 403；管理员可。
  - 普通销售编辑/释放/转化 **非自己名下** 记录 → 403；自己的可。
  - 管理员 scope=all 看到含别人私海的全部；可转移/释放任意记录。
- [ ] 实现 `permissions.py`（绿）：
  - `resolve_scope(scope, is_admin)`：非管理员请求 all → 返回 mine。
  - `require_admin(is_admin)`：False → raise HTTPException 403。
  - `require_owner_or_admin(record_owner_id, user_id, is_admin)`：非管理员且 record_owner_id != user_id → 403。
- [ ] 在 customer/lead 路由接入：list 用 resolve_scope；batch-transfer 用 require_admin；update/move-sea/convert 用 require_owner_or_admin。
- [ ] Commit `feat(crm): 权限层(销售只见自己+公海, 指派仅管理员)`

### 任务 7：API 集成测试

- [ ] `test_leads_api.py`/`test_follows_api.py`/`test_convert_api.py`（用 `tests/api/crm/conftest.py` 的 client + TRUNCATE 夹具）。
- [ ] 全量 `pytest tests/services/crm tests/api/crm` 绿。
- [ ] Commit `test(crm): 线索/跟进/转化集成测试`

## P1b 前端任务

### 任务 8：类型 + 映射

- [ ] types 加字段（lead/customer/contact.wechat）；dto-mappers 补 lead/follow + 新字段映射；`dto-mappers.test.ts` 补用例。
- [ ] Commit `feat(crm): 前端线索/跟进类型与映射`

### 任务 9：http-crm-client 实现

- [ ] 实现 listLeads/getLead/createLead/updateLead/convertLead/池操作/listFollows/createFollow（替换 notImplemented）。
- [ ] mock-crm-client 同步行为；`mock-crm-client.test.ts` 绿。
- [ ] Commit `feat(crm): http-client 接通线索/跟进/转化`

### 任务 10：移除商机界面

- [ ] 删 opportunities 页面/组件/types/field-defs/enums/mock fixture/client 方法/sidebar 入口；清理 follow.ts 的 Opportunity 引用。
- [ ] `pnpm lint && pnpm build` 绿（确认无残留引用）。
- [ ] Commit `chore(crm): 移除商机模块前端界面`

### 任务 11：线索页 + 详情接通

- [ ] leads 列表页接真实 client（scope/keyword/分页）；详情 Drawer 接跟进时间线（crm-follow-timeline）+ 转化按钮（convertLead）。
- [ ] 前端测试绿；Commit `feat(crm): 线索列表/详情/跟进/转化接通真实后端`

---

## 退出标准

- `NEXT_PUBLIC_CRM_API_MODE=http` 下：线索列表/详情/新建/编辑/弃置 + 跟进增查（分类型+下次提醒）+ 线索池转移/领取 + **转化为客户（跟进记录搬到新客户、联系人含微信）** 全流程操作真实 Postgres。
- 商机入口在前端消失，`pnpm build` 无残留引用。
- 后端 `pytest tests/services/crm tests/api/crm` 全绿；前端 `pnpm lint && pnpm build && pnpm test` 全绿。
- 迁移 218 在测试库 + prod 路径验证可升级（幂等）。
- **权限**：普通销售只见自己+公海、指派仅管理员、非自己名下写操作 403（集成测试覆盖）。

## 实施顺序与验证

后端任务 1→7 串行（每任务 TDD + commit），合 main 保持迁移链干净；前端任务 8→11 在后端就绪后做。每批合 main 触发部署（含 backend/ 改动走 `git deploy`）。
