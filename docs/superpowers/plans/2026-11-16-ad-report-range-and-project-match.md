# 广告报表日期范围识别与项目匹配修复

## 背景

用户反馈两个问题（BLF-1557）：

1. 广告报告改版后「日期范围」是合并的日期区间，后端能否精准识别；
2. `dashboard/reports/auto-upload` 上传广告报告时项目匹配不出来（疑似 bug）。

用户提供了 `已推广商品报告 (16).xlsx` 作为样本，表头为 2026 新版：
`日期范围 / 广告组合名称 / 预算货币 / … / 推广的商品 SKU-Advertised product SKU / 推广的商品编号 / …`。

## 根因

### 项目匹配

旧 FastAPI 的 `_build_project_match` 会读取 spec 声明的 `project_match_fields`
（`推广的商品 SKU-Advertised product SKU` / `推广的商品编号` → `product_costs.sku` / `asin`），
按国家过滤后把 SKU/ASIN 映射到项目。Go 迁移后的 `AdUploadStore.Recognize` 只实现了
「操作人可见项目」兜底：可访问项目只有 1 个才 matched，其余一律 `unmatched`，
完全跳过了 SKU/ASIN 匹配——这是 `auto-upload` 页面项目匹配不出来的直接原因。

### 日期范围

样本本身能被现有 `parseAdDateRange` 正确解析为 `2026-11-15 ~ 2026-11-15`。
但存在三个精度缺口：

- 只取 `日期范围` 列第一行，多行/多区间文件会得到部分区间；
- `开始日期`/`结束日期` 同样只看第一行；
- 英文月份（`Nov 10, 2026`）、同月缩写（`2026-11-10-15`）、带时间戳的区间
  无法解析；且解析失败时会退回单日期猜测，可能把错误区间静默当成单日报表。

## 实现

### 项目匹配

- `adReportSpec` 增加 `projectMatchFields`，为「已购买商品」「推广的商品」新旧两版
  spec 声明 `sku` / `asin` 列（与旧 Python spec 一致）。
- `AdUploadStore.Recognize` 先跑 `matchAdProjectIdentifiers`：
  - 只查 `is_active` 的 `product_costs` 与 `is_active` 的 `projects`，按 `country` 过滤；
  - 只在操作人可访问项目集合内匹配（不扩大权限）；
  - 唯一项目 → `matched` + `matched_by=sku|asin` + `matched_values`；
    多项目 → `conflict` + 候选；无命中 → 保留原有「操作人可见项目」兜底。
- 零可访问项目时，`unmatched` 行为不变。

### 日期范围

- `detectAdDateRange` 改为对整列取 min(start)/max(end)：
  - `开始日期`/`结束日期` 逐行解析（半填行只贡献单个端点，避免放大区间）；
  - `日期范围` 逐行解析后取并集；
  - 原来的 `日期` 周期行逻辑不变。
- `parseAdDateRange` 增强：
  - 英文月份区间（`Nov 10, 2026 - Nov 15, 2026`，含 `st/nd/rd/th`）；
  - 同月缩写区间（`2026-11-10-15`、`2026-11-10 ~ 15`）；
  - 去时间戳后再分词；
  - **fail-closed**：只要值里有区间分隔符（` - `、`至`、`~` 等）或英文月份 token
    出现 ≥2 个，却只解析出一个日期，就返回失败，**不再退化成单日期猜测**。
    覆盖 `Nov 10 - Nov 15, 2026`、`Nov 10, 2026 - 15`、
    `2026年11月10日 - 11月15日`、`2026-11-10 - 11-15` 等输入。
  - 真正的单日期（`Nov 15, 2026`、`2026-11-10`、RFC3339 时间戳）仍返回同日区间。
- 识别响应新增警告：非 `日期` 周期报表且起止不同时提示「系统将拒绝入库」，
  与既有单日入库约束一致（commit 侧 422 逻辑不变）。

### 识别签名

- `matchAdReportSpec` 增加第二遍匹配：把要求 `开始日期`+`结束日期` 的 spec
  改写为 `日期范围` 版本，其余必需列仍需全部命中。这样其他广告报表类型若同样改版
  也能识别，同时不改动第一遍的旧格式优先级。

## 非目标

- 不放开 ad-upload 多日区间**真实入库**（下游 `ad_analysis` 按 `report_date` 过滤，
  放开需要单独设计）；dry-run 不受影响。
- 不改前端；项目匹配修复在后端，前端无需改动即可看到 `matched`。
- 不改数据库 schema / 迁移。

## 验证

- 单元测试：SKU 匹配、冲突、兜底、日期范围多行/多格式、旧 spec 的日期范围签名。
- 真库集成测试（`GO_API_TEST_DATABASE_URL` → `BLF_test`）：
  用用户样本文件跑 `Recognize`，断言按 SKU 命中项目、日期 2026-11-15、国家 US；
  再跑一次真实 commit 验证单日入库成功，以及多日区间被 422 拒绝。
- 全量：`cd backend-go && go test ./... -count=1`、`go vet ./...`、
  `go test -race ./internal/store ./internal/autoreport ./internal/api/ad_upload`。

## 风险

- 低：只影响 ad-upload 识别与项目匹配；多项目命中时返回 `conflict` 而非静默选一个，
  行为比旧逻辑更保守。
- 已知残余：英文月份 + 两位年份、非公历格式仍不支持；遇到时返回「识别不到区间」，
  不会错误入库。
