# CRM P6 数据建模深化 · 设计文档（价值分档 + 产品类目）

> **状态**：设计已确认（2026-07-29 brainstorming），待 writing-plans 拆实现计划。
> **基线**：main = 6e5121b8（P5 尾巴清零后），prod alembic = 222。
> **范围**：P6a 价值分档 + P6b 产品类目。**不含**健康度评分（防流失，后续 phase）。

---

## 1. 业务背景

威森瑞是**跨境代运营服务公司**，客户为**贸易商 / 工厂生产型**客户。业务形态是「一个客户一锤子买卖」（CRM 已据此砍掉商机模块，漏斗简化为 线索 Lead → 客户 Customer + 跟进 Follow）。

CRM **没有订单 / 财务数据**（财务在独立的 PT4 报表系统），因此客户价值无法从交易额自动算出，本质是**销售/老板凭经验做的主观综合判断**。

**数据现状（重要）**：CRM 库内当前是**人造 / 测试数据，非真实业务数据**，真实客户尚未录入。→ 本期迁移**零风险**，无需为历史数据兼容过度设计。

**本期目标**：把客户从「基本资料 + 跟进」升级为「带价值评分 + 产品类目」的可分析、可排序、可分层实体，支撑两个业务诉求：
1. **分优先级**（首要）——哪些客户值得重点跟，销售精力往哪放。
2. **分类整理**——按产品类目分层，判断主攻方向（不同品类跨境体量不同）。

---

## 2. 范围

| 做 | 不做（本期） |
|---|---|
| 价值分档：4 维 ABCD 打分 + 等权汇总接管 rating + hover 解释 + 预留权重 | 健康度评分（防流失/盯跟进，后续 phase）|
| 产品类目：多对多多选 + 管理员维护扁平列表 + 抽屉/表筛选/设置页 | 权重可配置 UI（架构预留，本期等权）|
| | 类目层级树（大类→子类，扁平够用）|
| | 通用自由标签（仅产品类目这一种分类）|

---

## 3. 价值分档设计

### 3.1 四个价值维度

设计原则：**客户价值 ≈ 价值上限 × 成交/留存概率 ÷ 服务成本**。4 个维度各管一面、互不重叠，销售几秒可打完分：

| # | 字段名 | 维度 | hover 解释文案（前端 tooltip）|
|---|---|---|---|
| ① | `score_scale` | 体量与潜力 | 客户自身业务规模、所在产品类目的跨境销售体量、增长空间。盘子越大、品类越适合跨境、增长越快 → 评得越高。|
| ② | `score_pay` | 付费能力与意愿 | 客户有没有预算、愿不愿意为运营服务持续付费。既有支付能力又有长期付费意愿 → 高；只谈价、预算紧、付费犹豫 → 低。|
| ③ | `score_fit` | 跨境匹配度 | 客户对跨境电商的认知、投入决心、产品与团队适配度。懂跨境、舍得投入、产品适合出海 → 高；完全外行、观望试探 → 低。|
| ④ | `score_coop` | 合作性 | 对接是否顺畅、决策链是否清晰、配合度与沟通成本。对接人稳定、决策快、配合好 → 高；需求反复、决策混乱、难沟通 → 低。|

> 维度由来：用户初提 4 维（销售潜力/对接情况/跨境认知/付款意向）经打磨——「对接」与「付款」重叠，且缺「服务成本」面 → 重组为上述 4 维（付款独立成②，对接+成本合成④合作性；用户将「合作性价比」改名为「合作性」）。

### 3.2 刻度与汇总

- **刻度**：每维打 **A / B / C / D**（与现有 `rating` 枚举一致）。
- **汇总**：4 维自动汇总成综合档，**接管现有 `rating` 字段**（rating 变为「计算只读」，不再手动改）。
- **算法**（等权）：
  - 档位映射分值：A=4 / B=3 / C=2 / D=1
  - 综合分 = 4 维加权平均（本期权重各 0.25）
  - 映射回档：**≥3.5 → A**（优质）/ **2.5–3.49 → B**（良好）/ **1.5–2.49 → C**（一般）/ **<1.5 → D**（低优先）
- **完整性规则**：4 维须**全部非空**才重算 rating；任一为空 → rating 保持原值不动（前端提示「评分待完善」）。防止只填高分维度拉高均值。
- **权重预留**：汇总函数把权重做成参数（`weights: dict[str, float] | None`），本期传等权常量 `DEFAULT_WEIGHTS`。未来固定加权或可配置权重时，只改这个向量 / 加配置读取，**不动算法与数据结构**。

### 3.3 既有 rating 兼容

- 4 个 score 列**可空**；老客户 4 维为 NULL，rating 保留原值。
- 销售填满 4 维 → 重算 rating 覆盖原值。
- 不做「从 rating 反推 4 维」回填（综合档反推不出 4 维）。
- 因库内是测试数据，此兼容策略仅为安全默认，无真实数据损失风险。

---

## 4. 产品类目设计

### 4.1 形态

- **多对多**：客户 ↔ 类目，1..N。**常态单品类**（做家居的就做家居），**贸易商可多挂**。
- **词表**：**管理员维护的固定列表**（非自由文本），防「家居/家具/home」碎片化。销售只能从列表多选，不能造新词；缺类目找管理员加。
- **结构**：**扁平一层**（不做大类→子类树）。像「烧烤用品」这种虽属户外但已独立成大品类的，管理员直接加成**独立顶级类目**与「户外用品」并列即可，无需层级。
- **自定义**：列表完全可管理员编辑（增 / 改名 / 删）。

### 4.2 种子类目（亚马逊主流类目）

家居、3C、服装、家纺、科学配件、工业配件、工具配件、电动工具、户外用品（共 9 个，管理员后续可加）。

### 4.3 权限与审计

- 类目增删改：**仅管理员**（CRM 设置页）。
- 给客户挂/卸类目：owner 或 admin。
- 审计（沿用 P5 强一致）：类目 CRUD 记 `entity_type="category"`；客户类目变更记 `entity_type="customer"` action="update"（摘要如「产品类目：+家居 +户外 −服装」）。

---

## 5. 数据模型（后端 schema）

### 5.1 `crm_customers` 加列

```
score_scale   String(1)  nullable   -- ①体量与潜力 A/B/C/D
score_pay     String(1)  nullable   -- ②付费能力与意愿
score_fit     String(1)  nullable   -- ③跨境匹配度
score_coop    String(1)  nullable   -- ④合作性
rating        String(1)  已有        -- 语义升级为「4维汇总计算档」，仍 A/B/C/D
```

### 5.2 新表

```
crm_categories (
  id          Integer PK
  name        String(50) unique not null
  sort_order  Integer default 0
  created_at  DateTime
)

crm_customer_categories (
  customer_id  Integer FK→crm_customers.id   ON DELETE CASCADE
  category_id  Integer FK→crm_categories.id  ON DELETE CASCADE
  PK (customer_id, category_id)               -- 天然去重
)
```

### 5.3 迁移

- **推荐 1 个迁移文件**（编号从当前 head 递增）：加 4 列 + 建 2 表 + 灌 9 个种子类目；若按子 phase 分拆亦可（见 §9）。
- 纯增量、可回滚、无破坏性。

---

## 6. 后端设计

### 6.1 服务模块（各管一摊）

**`app/services/crm/value_score_service.py`**
```python
GRADE_POINTS = {"A": 4, "B": 3, "C": 2, "D": 1}
DEFAULT_WEIGHTS = {"score_scale": .25, "score_pay": .25, "score_fit": .25, "score_coop": .25}

def compute_rating(scores: dict[str, str | None], weights: dict[str, float] | None = None) -> str | None:
    """4 维全非空 → 加权平均映射 A/B/C/D；任一为空 → None（rating 不动）。纯函数，可单测。"""

def update_scores(db, customer_id, scores, *, user_id, commit=True):
    """写 4 维 + 重算 rating + flush/commit（沿用 P5-6a commit= 模式）。

    接受部分维度更新（仅写入提供的字段，exclude_unset）；写入后若 4 维全非空
    → 重算 rating，否则 rating 保持原值不动。每个提供的维度须为 A/B/C/D（否则 400）。
    """
```

**`app/services/crm/category_service.py`**
- `list_categories(db)` — 按 sort_order 排序。
- `create_category(db, name, *, commit=True)` / `update_category(...)` / `delete_category(...)` — admin CRUD；删除级联解除客户挂接。
- `set_customer_categories(db, customer_id, category_ids, *, commit=True)` — 整体替换客户类目集（幂等、去重），返回增删差异（供审计摘要）。

### 6.2 端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `PATCH /crm/customers/{id}/value-scores` | owner/admin | 收 4 维 → 重算 rating → 审计 |
| `PUT /crm/customers/{id}/categories` | owner/admin | 整体替换客户类目集（body `{category_ids:[...]}`）|
| `GET /crm/categories` | 登录即可 | 列出全部类目（供多选下拉）|
| `POST /crm/categories` | admin | 建类目（重名 → 409）|
| `PATCH /crm/categories/{id}` | admin | 改名 |
| `DELETE /crm/categories/{id}` | admin | 删类目（级联解除）|

> 价值评分**单开端点**（不并入 `update_customer`）：rating 是计算只读值，不该被通用更新直接写；评分重算是独立关注点，好测好审计。

### 6.3 列表 / 筛选增强

- `CustomerItem` 扩展：返回 4 个 score 字段 + `categories: [{id, name}]`。
- 客户列表加 `category_id` 查询参（筛「涉及某类目」的客户）。
- 4 维 + rating 进 `filter_engine` 白名单（可排序 / 高级筛选）。

### 6.4 权限与审计配套

- 复用 `require_admin`（类目 CRUD）/ `require_owner_or_admin`（客户评分/类目）/ `resolve_scope` / `filter_owned_ids`。
- 审计 `entity_type` 白名单 + 前端 AUDIT 标签新增 `"category"`。
- 所有写操作走 `audit_service.record_log`（P5 强一致：service flush + 端点统一 commit）。

---

## 7. 前端设计

### 7.1 共享常量（`lib/crm/constants/value-score.ts`）

4 维定义（key / 中文 label / hover 文案）、档位选项 A/B/C/D、档→配色、档位分值、TS 版 `computeRating`（实时预览用，与后端同规则）。hover 文案、打分 UI、汇总展示全复用这一份。

### 7.2 客户抽屉 · 价值画像（详情 tab 顶部卡片）

- 展示：4 维各一个档位 badge + 综合 rating 大字徽章；每维 label 旁 `?` 图标（lucide `HelpCircle` + shadcn `Tooltip`）hover 显示评判文案。
- 编辑：「编辑评分」→ 4 行，每行 = label + `?` + **A/B/C/D 分段选择器**（shadcn ToggleGroup）；未填满显示「评分待完善」、rating 不变；保存调 `PATCH /value-scores`，综合档实时预览。

### 7.3 客户抽屉 · 产品类目（详情 tab 字段行）

- 当前类目 chips；编辑弹 popover 多选（checkbox 列表，数据来自 `GET /crm/categories`）；保存调 `PUT /customers/{id}/categories`。

### 7.4 客户表

- `rating` 列改彩色 badge（计算综合档）；新增「产品类目」列（chips，>2 个折叠 +N）；表头筛选行加「类目」下拉（复用 P5 筛选基建）。
- **4 维明细不进表**（列太多），只在抽屉看。

### 7.5 CRM 设置页 · 类目管理（admin only）

- 列表（name + 排序）+ 新增 + 行内改名 + 删除（二次确认，提示「将解除 N 个客户的挂接」）。

### 7.6 API 层（`crm-client.ts` 接口 + http + mock 三处同步）

- 新增 `listCategories / createCategory / updateCategory / deleteCategory / setCustomerCategories / updateValueScores`。
- `Customer` 映射扩展 4 个 score + `categories`。

---

## 8. 测试策略（TDD，先红后绿）

**后端**（基线 238）：
- `compute_rating`：各档位组合→正确档；缺任一维→None；边界 3.5/2.5/1.5；传非等权 weights→结果变（证明权重预留）。
- `PATCH /value-scores`：写 4 维+重算；非法档位（"E"）→400；越权→403；审计强一致；未填满→rating 不变。
- `category_service`：CRUD；`set_customer_categories` 整体替换/幂等/去重；删除级联解除。
- 类目端点：非 admin→403；重名→409；列表按 sort 排序。
- 客户列表：按 `category_id` 筛；`CustomerItem` 含 scores + categories。

**前端**（基线 232）：
- TS `computeRating` 单测（与后端同规则）。
- 抽屉价值画像卡：4 维+rating 渲染、tooltip 解释、分段选择器编辑、保存调 `updateValueScores`。
- 类目多选：chips、popover 编辑、保存调 `setCustomerCategories`。
- 设置页类目管理：增/改名/删（admin）。
- http-client 新方法请求构造（沿用 http-crm-client.test 模式）。

**门禁**：`cd backend && pytest tests/api/crm tests/services/crm` + `cd frontend && pnpm lint && pnpm build && pnpm test`。

---

## 9. Phase 切分与交付

价值分档与产品类目**相互独立**，拆两个子 phase 串行交付，各自独立上线/部署：

- **P6a · 价值分档**：score 列 + value_score_service + value-scores 端点 + 抽屉价值画像卡 + rating 接管 + TS computeRating。
- **P6b · 产品类目**：2 表 + category_service + 类目端点 + 抽屉类目多选 + 表筛选 + 设置页管理。

迁移可合一个文件（4 列 + 2 表 + 种子），也可随子 phase 分两个。具体 task 拆分由 writing-plans 完成。

**部署**：含 backend 改动 → `git deploy` 触发 VPS；迁移 `alembic upgrade head`。

---

## 10. 未来扩展（本期不做，留接口）

- **权重可配置**：管理员设置页调 4 维权重（架构已预留 weights 参数）。
- **健康度评分**：`f(最近跟进天数, 跟进频次, 公海停留, 价值分档)`，celery 定时刷（后续 phase）。
- **类目层级**：大类→子类树（如确需「户外→烧烤」嵌套而非并列）。
- **类目看板**：按类目统计客户数/价值分布，判断主攻方向（可并入 P8 数据看板强化）。
