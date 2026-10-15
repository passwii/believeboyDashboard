---
name: believeboy-shipments
description: 调用 BelieveBoy Agent API 查询与维护跨项目货件（shipments 域，business_scope shipments，12 条路由：读 6 + 写 6 全 confirm）。用于货件列表/详情/SKU 汇总/FBA 箱规/审计/FBA 发货模板导出、创建货件、改货件信息、更新商品明细、改状态、重算成本、删除。Use when the user asks for 货件 / shipments / 货件查询 / 创建货件 / 货件状态 / 箱规 / FBA / FBA发货模板, 或任何需要从 dash-api.believeboy.com 读取或维护货件数据的任务。
---

# BelieveBoy Agent API · 货件（shipments）

跨项目货件查询与维护方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

## 0. 凭据来源与鉴权（每次请求缺一不可）

> **workspace env 变量名约定（统一）**：`AGENT_KEY`（明文 Key）/ `AGENT_ID`（X-Agent-Id 业务主键）/ `API_BASE`（Base URL，可省略走默认）。各 agent 的 custom_env 按此三件套配置，skill 内一律引用这三个名字，禁止硬编码/明文 Key。

```bash
KEY="${AGENT_KEY}"                  # 明文 Key，agent custom_env 注入
AGENT_ID="${AGENT_ID}"              # X-Agent-Id 业务主键，如 operator-manager-Damon
BASE="${API_BASE:-https://dash-api.believeboy.com/api/v1/agent}"
AUTH=(-H "Authorization: Bearer $KEY" -H "X-Agent-Id: $AGENT_ID")
```

## 1. 项目名 → ID 解析（派发只给项目名，先查 ID）

```bash
curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}"
# → {"ok":true,"data":[{"project_id":1,"project_name":"<项目名>"}]}
PROJECT_ID=$(curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}" | jq -r '.data[0].project_id')
```

项目名以系统为准（共 13 个），未命中先向派发方确认，不猜。

## 2. 端点目录（12 条：读 6 + 写 6，business_scope "shipments"）

路径前缀：`/api/v1/agent/projects/{project_id}/shipments`

### 读路由（不落审计、绕过读缓存直查 DB）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/shipments` | 货件列表（多条件过滤 + 分页） |
| R2 | GET | `/shipments/{shipment_no}` | 单货件详情 |
| R3 | GET | `/shipments/{shipment_no}/sku-summary` | 货件内 SKU 汇总 |
| R4 | GET | `/shipments/{shipment_no}/fba-box-detail` | FBA 箱规明细 |
| R5 | GET | `/shipments/{shipment_no}/audit?limit=` | 操作审计轨迹（limit 默认 50，≤200） |
| R6 | GET | `/shipments/{shipment_no}/fba-delivery-template` | 导出 FBA 发货模板 xlsx |
| R7 | GET | `/shipments/fba-box-details.xlsx?shipment_no=...` | 导出 Dashboard 同版式 FBA 箱单明细 xlsx（可重复传 shipment_no，最多 100 个） |

**R7 导出 FBA 箱单明细**：

```bash
curl -fLsS --get "$BASE/projects/$PROJECT_ID/shipments/fba-box-details.xlsx" \
  "${AUTH[@]}" \
  --data-urlencode "shipment_no=$SHIPMENT_NO" \
  -o "${SHIPMENT_NO}-fba-box-details.xlsx"
```

- 可重复传入 `shipment_no`，同一项目最多 100 个；每个货件按路径项目校验。
- 成功响应是原始 XLSX 文件流，与 Dashboard「FBA 箱单明细」字段和业务计算一致；无可导出的行或货件不存在时返回 `RESOURCE_NOT_FOUND`。
- 不存在或无法取得的产品图片会跳过，不影响文件生成；导出文件仅驻留内存，不写入持久化存储。

**R6 导出 FBA 发货模板**：

```bash
curl -fLsS "$BASE/projects/$PROJECT_ID/shipments/$SHIPMENT_NO/fba-delivery-template" \
  "${AUTH[@]}" \
  -o "${SHIPMENT_NO}-fba-template.xlsx"
```

- **成功响应**：直接返回 XLSX 二进制流，不包裹 `agent_ok` JSON，不使用 Base64；`Content-Type` 为 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，`Content-Disposition` 提供 UTF-8 文件名。
- **失败响应**：仍使用 Agent 标准 JSON 错误壳（例如鉴权失败、货件不存在）。
- **单位口径**：DE / UK 使用公制 cm/kg；其他站点使用英制 in/lb，尺寸除以 2.54、重量乘以 2.20462，均保留 2 位小数。
- **数据口径**：箱数取货件明细已持久化的 `carton_count`；装箱率、外箱尺寸和外箱重量按项目 + 站点 + SKU 查询。缺失主数据时对应单元格留空，仍返回合法模板。需要先修改箱数时，先调用 W2 保存明细，再调用 R6。

**R1 列表过滤参数**：`country` / `shipment_status` / `shipping_method` / `shipment_no`（子串）/ `created_date_from` / `created_date_to` / `etd_from` / `etd_to` / `eta_from` / `eta_to`（YYYY-MM-DD）+ `page`（默认1）/ `page_size`（默认20，≤100）。

```bash
curl -s "$BASE/projects/$PROJECT_ID/shipments?country=US&shipment_status=SHIPPED&page_size=20" "${AUTH[@]}"
```

### 写路由（**全部走 confirm 两步确认**，审计归因 agent_id + idempotency_key，operator=NULL）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| W1 | POST | `/shipments` | 新建货件（缺省参数自动生成，见 §2.2） |
| W2 | PUT | `/shipments/{shipment_no}/items` | 更新货件商品明细 |
| W3 | PATCH | `/shipments/{shipment_no}` | 改货件信息（如状态字段） |
| W4 | POST | `/shipments/{shipment_no}/status` | 改货件状态 |
| W5 | POST | `/shipments/{shipment_no}/recalculate-costs` | 重算货件成本（影响财务） |
| W6 | DELETE | `/shipments/{shipment_no}` | 删除货件 |

**confirm 流（所有写路由强制）**：

```bash
IDEMPOTENCY_KEY=$(uuidgen)
# 第一步（预览）：返回 confirm_token，不落库
curl -X POST "$BASE/projects/$PROJECT_ID/shipments" "${AUTH[@]}" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "Content-Type: application/json" \
  -d '{"source":"agent_user_supplied", ...}'
# 第二步：向用户确认后，同一 URL + 同一 Idempotency-Key 重放 + X-Confirm-Token
curl -X POST "$BASE/projects/$PROJECT_ID/shipments" "${AUTH[@]}" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "X-Confirm-Token: <confirm_token>" \
  -H "Content-Type: application/json" -d '{"source":"agent_user_supplied", ...}'
```

写请求体必须与第一步完全一致；`source` 溯源枚举（同 sku-info 约定，禁 manual）。

## 2.1 SKU 装箱信息先行（BLF-604 强制约定，与前端口径一致）

建货件/更新明细时，明细中每个 SKU 在 SKU 主数据里**必须已维护 `units_per_carton`（装箱率）> 0**，否则 W1/W2 直接拒绝（400 `SHIPMENT_ITEMS_MISSING_CARTON_INFO`，details 逐行 `{row, sku, reason: "missing_carton_info"}`，提示先维护外箱尺寸/毛重/装箱率）。

- **正确操作顺序**：先确保 SKU 主数据有装箱信息（缺则先用 sku-info W2 PATCH 维护 `carton_length_cm/carton_width_cm/carton_height_cm/carton_weight_kg/units_per_carton`）→ 再建货件。
- **items 明细字段**：`{sku, quantity, carton_count?}` —— 与前端一致，**数量 = 箱数 × 装箱率**（如 1 箱 × 28 件 = quantity 28 + carton_count 1）；carton_count 可省略，重算时后端按 ⌈数量÷装箱率⌉ 自动推导。
- **W5 重算**（`POST /shipments/{shipment_no}/recalculate-costs`，body 需 `logistics_unit_price` 非负数，暂无价格传 0）：按 SKU 主数据外箱尺寸/毛重回写每个明细的 `carton_count / volume_m3 / actual_weight_kg / volumetric_weight_kg / chargeable_weight_kg / estimated_logistics_cost` 及货件汇总——建完货件后建议跑一次。

## 2.2 W1 新建货件缺省参数（BLF-1347，仅新建时生效）

W1 只需给 `items` 即可建货件：**未提供的参数由系统自动生成/填充**，confirm 预览的 `preview` 会返回填充后的有效值并用 `preview.auto_filled` 列出本次被自动填充的字段名（如 `["shipment_no", "created_date"]`），重放落库值与预览完全一致。

| 参数 | 未提供时 | 说明 |
|---|---|---|
| `shipment_no`（FBA 发货编码） | 自动生成 `FBA-<生成日期 YYYYMMDD>-<4 位标识>`，如 `FBA-20261015-K7Q2` | 占位编号，拿到真实 FBA 编码后用 W3 PATCH 覆盖；编号全局唯一，预览期选定后**绑定到本次确认**（重放不换号，被占用则 409 要求重新预览） |
| `created_date`（发货时间） | 当天 | 仅新建时默认；后续 W3 未提供即保持原值 |
| `shipping_method` | `sea`（海运） | 与前端新建表单默认一致；实际不是海运时请显式传入 |
| `shipment_status` | `draft` | 与前端新建表单默认一致 |
| `country` | `US` | 既有默认，不变 |
| `logistics_unit_price` / `include_in_history_shipping_calc` | `0` / `true` | 既有默认，不变 |

- **不会自动生成**（属业务事实，缺省即留空/不填）：`etd_date` / `eta_date` / `actual_inbound_date` / `tracking_no` / `warehouse_code` / `forwarder_name` / `shipment_batch` / `remark`。
- **预览=落库（BLF-1347 review 修正）**：自动填充值在**预览期算定并绑定进确认记录**（token 里存一份），重放时直接复用，不重算日期、不重新挑编号——即使预览与确认跨了零点，落库的仍是预览里展示的发货日期与编号。若预览后该自动编号被并发请求占用，重放会返回 `409 SHIPMENT_DUPLICATE_NO`（提示重新预览），**不会**静默换成预览里没展示过的编号。
- **默认值只在新建生效**：W3 PATCH 是「未提供即保持原值」的合并语义，不会把发货时间改回当天、也不会重生成编号。

## 3. 注意事项

- 读路由不落审计、绕过 Redis 读缓存直查 DB；写路由全 confirm + 写限流（30 次/分）
- 删除/重算成本涉及不可逆/费用变更——确认流是强制安全门，务必给用户看预览再重放
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；所有路由挂 `require_project_scope` + `business_scope("shipments")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.13 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/shipments.py`）
