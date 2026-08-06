# 库存分类账独立报表类型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Amazon 库存分类账 Summary 与 Detail 实现为两个互斥的独立上传类型，分别识别、展示、验证并写入对应数据表，杜绝 Detail 被识别为业务报告。

**Architecture:** 识别层使用两套完整 Header 签名并输出 `inventory_ledger_summary` / `inventory_ledger_detail`；提交和 RPA 层按独立类型显式路由到对应 parser/table，并在入库前验证类型与表头一致；前端将两个内部类型映射为中文 + 英文视图标签。共享的 batch 元数据、编码读取和 CSV 辅助逻辑可复用，但不再产生通用的第三种库存分类账类型。

**Tech Stack:** Python、FastAPI/Pydantic、SQLAlchemy、pytest、TypeScript、React、Vitest。

## Global Constraints

- Summary 与 Detail 是仅有的两种库存分类账业务报表；不得新增第三种通用 `inventory_ledger` 输出。
- 新识别输出必须是 `inventory_ledger_summary` 或 `inventory_ledger_detail`。
- Summary 只允许写 `inventory_ledger_summary`；Detail 只允许写 `inventory_ledger_detail`。
- 部分签名、双签名冲突和类型/表头不一致必须拒绝，不得降级为 `business_report`。
- 页面主文案使用“库存分类账 · 汇总视图（Summary）”和“库存分类账 · 明细视图（Detail）”；`ingest_ledger_*` 不是用户-facing 报表名称。
- 遵循仓库测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`；后端相关测试使用 `cd backend && pytest`。
- 修改公共函数前使用 CodeGraph 检查 callers/callees/impact；提交前确认 author email 为 `jr.way123@gmail.com`。

---

## 文件地图

- `backend/app/utils/recognition/recognizers/__init__.py`：CSV 识别签名、识别结果生成和 `recognize_file` 排序。
- `backend/app/utils/recognition/models.py` 或仓库实际定义 `RecognitionResult` 的文件：增加独立类型可承载的字段/限制（若类型为开放字符串，则更新共享 Literal/常量）。
- `backend/app/schemas/upload.py`：报告上传类型 Literal。
- `backend/app/utils/constants.py`：支持的报告类型集合。
- `backend/app/services/data/upload/recognition.py`：已保存上传文件的识别/项目匹配适配。
- `backend/app/services/data/upload/persistence.py`：HTTP commit 的独立入库路由。
- `backend/app/services/inventory/ledger.py`：Summary/Detail parser、header 校验和共享 batch 逻辑；补充显式 kind/type 校验入口。
- `autoReportUpload/recognition.py`：RPA 识别结果和类型声明。
- `autoReportUpload/processor.py`：RPA persistence 分支。
- `frontend/components/report-upload/types.ts`：前端 `ReportType` 和日期规则。
- `frontend/app/dashboard/reports/auto-upload/page.tsx`：识别结果标签、状态矩阵和上传队列展示。
- `backend/tests/utils/recognition/test_recognizers.py`：识别回归。
- `backend/tests/services/inventory/test_ingest_ledger_csv.py`：双表入库、冲突和类型校验回归。
- `backend/tests/services/data/upload/`、`autoReportUpload/tests/`：HTTP/RPA 路由回归（按仓库实际测试目录补入现有文件）。
- `frontend/app/dashboard/reports/auto-upload/page.test.tsx` 或 `frontend/components/report-upload/*.test.tsx`：页面 label/状态测试。

---

### Task 1: 识别层输出两个互斥类型

**Files:**
- Modify: `backend/app/utils/recognition/recognizers/__init__.py`
- Modify: `backend/app/schemas/upload.py`
- Modify: `backend/app/utils/constants.py`
- Test: `backend/tests/utils/recognition/test_recognizers.py`

**Interfaces:**
- Produces `RecognitionResult.report_type` values `inventory_ledger_summary` and `inventory_ledger_detail`.
- Keeps `recognize_file(path, country, original_filename) -> RecognitionResult | None` as the main entry point.
- Does not return `inventory_ledger` for newly recognized CSVs.

- [ ] **Step 1: Add failing tests using the two real header shapes**

在 `test_recognizers.py` 增加最小 CSV fixture，表头严格对应用户提供的 22 列 Summary 与 16 列 Detail，断言：

```python
def test_recognize_inventory_ledger_summary_header():
    result = recognize_file(summary_path, original_filename="库存分类账 2026-03一览视图.csv")
    assert result is not None
    assert result.report_type == "inventory_ledger_summary"


def test_recognize_inventory_ledger_detail_header():
    result = recognize_file(detail_path, original_filename="库存分类账-2026-03详细视图.csv")
    assert result is not None
    assert result.report_type == "inventory_ledger_detail"


def test_detail_does_not_fall_back_to_business_report():
    result = recognize_file(detail_path, original_filename="库存分类账-2026-03详细视图.csv")
    assert result is not None
    assert result.report_type != "business_report"
```

再增加缺列和双签名冲突断言，错误信息中包含缺失列或冲突。

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd backend && pytest tests/utils/recognition/test_recognizers.py -q
```

Expected: 新增 Summary/Detail 类型断言失败，当前 Summary 可能识别为旧 `inventory_ledger`，Detail 会识别为 `business_report`。

- [ ] **Step 3: Implement two signatures and strict ordering**

在 recognizer 中定义标准化字段签名：

```python
_INVENTORY_LEDGER_SUMMARY_REQUIRED_COLUMNS = {
    "date", "msku", "disposition", "location",
    "starting_warehouse_balance", "ending_warehouse_balance",
}
_INVENTORY_LEDGER_DETAIL_REQUIRED_COLUMNS = {
    "date", "msku", "event_type", "quantity",
    "fulfillment_center", "disposition",
}
```

将 `recognize_inventory_ledger` 改为返回两个独立 report type 的结果；先计算两套完整匹配，再处理冲突和部分匹配；只有无任何 ledger 强特征时返回 `None`。在 `recognize_file` 中把 ledger 识别放到 business report 前，并让部分/冲突结果以结构化识别失败返回，不能继续进入 ASIN fallback。

同步更新 `ReportUploadType`、支持类型集合和所有共享 report type Literal/映射；如果仓库仍需读取历史 `inventory_ledger`，只在明确的兼容入口处理，不让 recognizer 产生该值。

- [ ] **Step 4: Run focused tests**

```bash
cd backend && pytest tests/utils/recognition/test_recognizers.py -q
```

Expected: 新增识别测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/app/utils/recognition/recognizers/__init__.py backend/app/schemas/upload.py backend/app/utils/constants.py backend/tests/utils/recognition/test_recognizers.py
git commit -m "feat(上传识别): 拆分库存分类账两类报表"
```

---

### Task 2: HTTP 入库按独立类型显式路由并校验

**Files:**
- Modify: `backend/app/services/data/upload/persistence.py`
- Modify: `backend/app/services/data/upload/recognition.py`
- Modify: `backend/app/services/inventory/ledger.py`
- Test: `backend/tests/services/inventory/test_ingest_ledger_csv.py`
- Test: 现有 HTTP upload persistence 测试文件（按仓库实际路径）

**Interfaces:**
- Adds an explicit typed ingestion contract, e.g. `ingest_inventory_ledger_csv(..., expected_kind: Literal["summary", "detail"]) -> int`, or equivalent exact signature chosen to match existing service style.
- `inventory_ledger_summary` and `inventory_ledger_detail` commit branches never call generic `_persist_single_source`.

- [ ] **Step 1: Add failing typed-routing tests**

覆盖：

```python
def test_expected_summary_rejects_detail_csv():
    with pytest.raises(ValueError, match="类型与文件内容不一致"):
        ingest_inventory_ledger_csv(..., expected_kind="summary", csv_content=DETAIL_CSV)


def test_expected_detail_rejects_summary_csv():
    with pytest.raises(ValueError, match="类型与文件内容不一致"):
        ingest_inventory_ledger_csv(..., expected_kind="detail", csv_content=SUMMARY_CSV)
```

并保留现有双表真实入库断言，改为从两个独立入口调用。

- [ ] **Step 2: Run focused tests and verify failure**

```bash
cd backend && pytest tests/services/inventory/test_ingest_ledger_csv.py -q
```

Expected: 新 typed contract 尚不存在或当前入口仍会重新猜测。

- [ ] **Step 3: Implement explicit typed ingestion**

将现有共享 CSV 读取、批次、幂等和 COPY 逻辑保留，但让调用方传入明确 kind；入口先调用共享检测器验证 expected kind，再选择唯一 parser/table。Summary 和 Detail 分支必须分别设置目标表与 batch 统计，冲突/未知/错配抛出可转换为 4xx 的 `ValueError`。

在 HTTP persistence 中增加：

```python
if report_type == "inventory_ledger_summary":
    ingest_inventory_ledger_csv(..., expected_kind="summary")
elif report_type == "inventory_ledger_detail":
    ingest_inventory_ledger_csv(..., expected_kind="detail")
```

更新已保存文件识别适配，确保独立类型不会被项目匹配逻辑当成通用 `inventory_ledger`。

- [ ] **Step 4: Run backend focused tests**

```bash
cd backend && pytest tests/services/inventory/test_ingest_ledger_csv.py tests/utils/recognition/test_recognizers.py -q
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/data/upload/persistence.py backend/app/services/data/upload/recognition.py backend/app/services/inventory/ledger.py backend/tests/services/inventory/test_ingest_ledger_csv.py backend/tests/services/data/upload
git commit -m "feat(库存分类账): 按报表类型独立入库"
```

---

### Task 3: RPA 识别和 persistence 使用独立类型

**Files:**
- Modify: `autoReportUpload/recognition.py`
- Modify: `autoReportUpload/processor.py`
- Test: `autoReportUpload` 现有 recognition/processor 测试文件

**Interfaces:**
- RPA `RecognitionResult.report_type` is one of the two independent types.
- RPA persistence delegates to the typed backend/service path and never `_persist_single_source` for either ledger type.

- [ ] **Step 1: Add failing RPA tests**

使用 Summary/Detail 表头分别断言识别结果类型，并 mock/spy ingestion delegate：

```python
def test_rpa_summary_uses_summary_ledger_path():
    result = recognize_file(summary_path)
    assert result.report_type == "inventory_ledger_summary"


def test_rpa_detail_uses_detail_ledger_path():
    result = recognize_file(detail_path)
    assert result.report_type == "inventory_ledger_detail"
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
pytest autoReportUpload/tests -q
```

Expected: 当前 RPA 识别或 persistence 不支持两个新类型。

- [ ] **Step 3: Implement RPA branches**

在 RPA recognition 中复用或同步共享双签名规则；在 processor 的通用 persistence 前增加两个显式分支，分别调用 typed ledger ingestion。错误要保留原始可操作信息，成功结果包含独立类型和写入行数。

- [ ] **Step 4: Run focused tests**

```bash
pytest autoReportUpload/tests -q
```

Expected: RPA 识别、路由和重复上传测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add autoReportUpload/recognition.py autoReportUpload/processor.py autoReportUpload/tests
git commit -m "feat(RPA上传): 独立处理库存分类账报表"
```

---

### Task 4: 前端中文对照和 Summary/Detail 标识

**Files:**
- Modify: `frontend/components/report-upload/types.ts`
- Modify: `frontend/app/dashboard/reports/auto-upload/page.tsx`
- Modify: 相关上传 queue/result 类型文件（若类型定义分散）
- Test: `frontend/app/dashboard/reports/auto-upload/page.test.tsx` 或现有 report-upload 测试文件

**Interfaces:**
- `getUploadReportTypeLabel("inventory_ledger_summary")` returns `库存分类账 · 汇总视图（Summary）`.
- `getUploadReportTypeLabel("inventory_ledger_detail")` returns `库存分类账 · 明细视图（Detail）`.
- `inventory_ledger` has no new-upload label or selectable status entry.

- [ ] **Step 1: Add failing component/helper tests**

断言上传队列和状态矩阵使用两个独立中文标签，且不显示 `ingest_ledger_*`。

- [ ] **Step 2: Run focused frontend tests and verify failure**

```bash
cd frontend && pnpm vitest run app/dashboard/reports/auto-upload/page.test.tsx
```

Expected: 当前类型映射缺少两个独立类型。

- [ ] **Step 3: Implement labels and status cells**

更新前端 report type union、日期规则和 API response 类型；在页面映射中加入：

```ts
inventory_ledger_summary: '库存分类账 · 汇总视图（Summary）',
inventory_ledger_detail: '库存分类账 · 明细视图（Detail）',
```

状态矩阵按两个 key 展示，上传成功反馈展示类型、月份和行数。对未知旧值显示“历史库存分类账类型（待重新识别）”，不要把它伪装成第三种新类型。

- [ ] **Step 4: Run focused frontend tests**

```bash
cd frontend && pnpm vitest run app/dashboard/reports/auto-upload/page.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/components/report-upload/types.ts frontend/app/dashboard/reports/auto-upload/page.tsx frontend/app/dashboard/reports/auto-upload/page.test.tsx
 git commit -m "feat(上传页面): 标注库存分类账两类视图"
```

---

### Task 5: 全量验证与回归检查

**Files:**
- Modify: 需要修复的测试/类型文件

- [ ] **Step 1: Run backend tests**

```bash
cd backend && pytest
```

Expected: PASS；若失败，先修复与新 report type 相关的调用方，不改变测试绕过行为。

- [ ] **Step 2: Run frontend required checks**

```bash
cd frontend && pnpm lint
cd frontend && pnpm build
cd frontend && pnpm test
```

Expected: 三项 PASS。

- [ ] **Step 3: Run diff and type checks**

```bash
git diff --check
git status --short
```

确认没有意外修改用户已有的 dashboard v2 工作树改动，也没有把真实 CSV 或临时截图加入提交。

- [ ] **Step 4: Verify author and CodeGraph**

```bash
git config --show-origin --get user.email
codegraph status .
codegraph callers recognize_file
codegraph callers ingest_inventory_ledger_csv
```

Expected author email 为 `jr.way123@gmail.com`，CodeGraph 索引健康，调用面与新 typed ingestion 一致。

- [ ] **Step 5: Commit final test fixes**

```bash
git add <only-reviewed-files>
git commit -m "test(库存分类账): 补充两类报表回归验证"
```
