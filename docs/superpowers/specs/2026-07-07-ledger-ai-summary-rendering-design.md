# Ledger AI 文案渲染优化 + 口径修正规格

## 背景

`frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailDialog.tsx`
是「调度记录」页面的详情 Dialog，运营人员点开任意一条 ledger 条目即可看到后端生成的 AI 文案摘要。
当前实现有两个用户可见问题：

1. **折行缺失** —— AI 文案走 `ReactMarkdown` 渲染（见 `LedgerDetailDialog.tsx:418-425`），折行依赖 LLM 返回 markdown list。
   当 LLM 返回整段 paragraph（实测会偶尔发生）时，整段文字会塌缩为一段长 paragraph，无法逐条阅读。
2. **口径不一致** —— AI 文案里频繁出现「昨日销量」字样，但同一份数据在邮件 KPI 卡片（`email_sender_daily.py:120`）中叫「今日销量」。
   该项目的口径反转规则：`yesterday_qty` 字段实际对应数据锚定日（即"日历上的昨天"），但运营口径统一称为"今日"。
   此前 prompt 文案未跟随此口径，导致 AI 文案读起来与邮件 KPI 冲突。

修复这两个问题，以提升 ledger Dialog 的可读性与口径一致性。

## 范围

**仅后端修改 + 1 个前端 fixture 文件 + 1 个 preview 脚本**，不动数据库、不动历史数据、不动邮件、不动前端 Dialog 组件。

**修改文件清单**：

| # | 文件 | 性质 |
|---|---|---|
| 1 | `backend/app/services/scheduled_report/ai_enhancer_daily.py` | SYSTEM_PROMPT 主体 7 处文案 + 1 处 fallback + 追加 1 条折行硬约束 |
| 2 | `backend/app/services/scheduled_report/report_builder_daily.py` | 1 处单国家 fallback |
| 3 | `backend/app/services/scheduled_report/dispatcher.py` | 1 处多国家 fallback |
| 4 | `backend/tests/services/scheduled_report/test_ai_timeout.py` | 2 处 fixture 字符串（同步替换以保证断言通过） |
| 5 | `backend/scripts/preview_report_screenshot.py` | 1 处 preview sample 文案 |

**不修改**：

- 前端 `LedgerDetailDialog.tsx` / `ledger/page.tsx` / `LedgerDayGroup.tsx` / `ledger-constants.ts`：
  完全没有「昨日」字面量，仅渲染后端 `ai_summary` 字段。
- 邮件 KPI 卡片（`email_sender_daily.py:122, 399`）：用户明确不改此范围。
- 数据库字段名 / schema：`yesterday_qty` / `yesterday_amount` / `today_order_qty` / `today_sales_amount`
  与查询逻辑紧耦合，重命名得不偿失。
- 存量 ledger 数据：历史 `ai_summary` 字段保留「昨日」字样，不做迁移、不做批量回填。
- 周报 / 月报 prompt：`ai_enhancer_weekly.py` / `ai_enhancer_monthly.py` 不含「昨日/今日」字样，本就不在范围。

## 改动详表

### 1. 「昨日 → 今日」字样替换（精确改写表）

**只替换「昨日」字样，不替换「前一日」「近7天」「库存」「在途」「ROAS」「ACOS」等其它词。**

| # | 文件:行 | 原文（节选） | 改后 |
|---|---|---|---|
| 1 | `ai_enhancer_daily.py:17` | `首先描述"昨日"的单量和销售额` | `首先描述"今日"的单量和销售额` |
| 2 | `ai_enhancer_daily.py:22` | `"昨日销量"的涨跌判断**仅基于 vs 前一日**` | `"今日销量"的涨跌判断**仅基于 vs 前一日**` |
| 3 | `ai_enhancer_daily.py:24` | `错误示例："昨日6单，较前一日大幅下降...` | `错误示例："今日6单，较前一日大幅下降...` |
| 4 | `ai_enhancer_daily.py:25` | `正确示例："昨日6单/141.94欧元，较前一日增长12.5%...` | `正确示例："今日6单/141.94欧元，较前一日增长12.5%...` |
| 5 | `ai_enhancer_daily.py:37` | `示例（德国站）：`昨日6单/€141.94...`` | `示例（德国站）：`今日6单/€141.94...`` |
| 6 | `ai_enhancer_daily.py:38` | `示例（美国站）：`昨日6单/$1,234.56...`` | `示例（美国站）：`今日6单/$1,234.56...`` |
| 7 | `ai_enhancer_daily.py:46` | `多国家时每条以"XX站"开头，如"◉ 德国站昨日6单...` | `多国家时每条以"XX站"开头，如"◉ 德国站今日6单...` |
| 8 | `ai_enhancer_daily.py:215` | `f"- 昨日销量{today_qty}单{amt_str}...` | `f"- 今日销量{today_qty}单{amt_str}...` |
| 9 | `report_builder_daily.py:769` | `parts = [f"昨日销量{today_qty}单{amt_str}...` | `parts = [f"今日销量{today_qty}单{amt_str}...` |
| 10 | `dispatcher.py:577` | `line = f"◉ {label}昨日销量{qty}单{amt_str}...` | `line = f"◉ {label}今日销量{qty}单{amt_str}...` |
| 11 | `test_ai_timeout.py:202, 210` | fixture 中的「昨日」字样 | 同步替换为「今日」 |
| 12 | `scripts/preview_report_screenshot.py:22` | preview sample 中的「昨日」字样 | 同步替换为「今日」 |

### 2. Prompt 折行硬约束（追加在 `ai_enhancer_daily.py:34-47` 末尾）

**追加位置**：`强制格式规则`块的第 2 条（line 47 `2. **库存状况**`）之后，新增第 3 条，原第 3 条起编号顺延为 4：

```text
3. **强制折行（bullet 隔离）**:
   - 每条 bullet 必须独占一行，绝对不允许把多条 bullet 合并成同一段落。
   - bullet 之间用一个空行隔开，确保 ReactMarkdown 渲染时每个 bullet 形成独立 <li>。
   - bullet 内部只写一个完整事实，不允许用中文逗号（，）或顿号（、）把多个并列事实串接到同一行。
   - 错误示例（折叠）："◉ 德国站今日6单/€141.94，较前一日增长12.5%，库存285件在途665件"
   - 正确示例（分行）：
     ◉ 德国站今日6单/€141.94，较前一日增长12.5%（近7天累计39单/€981.04）

     ◉ 德国站库存285件在途665件
```

**为什么这样写**：

- LLM 在收到更明确的"独占一行 / 空行隔开"指令后，会在生成时插入正确的 `\n\n`，ReactMarkdown 才能渲染为独立 `<li>`。
- 与现有"以 ◉ 开头"约束一致，不引入新符号，前端 `replace(/^[•·●]\s*/gm, '- ')` 无需改动。
- 不动 bullet 前缀符号体系（原来 ◉、fallback 用 `-`，都已经在 Dialog 里兼容）。

## 数据流与边界

### 数据流（不变）

```
scheduled_report_dispatcher
  ↓
report_builder_daily._generate_fallback_summary  ← 改 line 769
  ↓
ai_enhancer_daily._generate_summary (LLM)        ← 改 SYSTEM_PROMPT + _generate_fallback_summary (line 215)
  ↓
ScheduledReportDeliveryLog.ai_summary (TEXT)     ← 不动 schema
  ↓
ledger API
  ↓
LedgerDetailDialog (ReactMarkdown)               ← 不动
```

本次只改 `report_builder_daily._generate_fallback_summary` / `ai_enhancer_daily` / `dispatcher._fallback_multi_country_summary` 三条文案路径的字符串字面量，
**不影响**字段名、API 形状、Dialog 组件、邮件渲染。

### 口径边界

- **「今日」= 数据锚定日** = `_get_report_anchor_date(country)` = `min(目标国家当天, 服务器昨天)`。
  绝大多数情况下 = 服务器日历日 - 1 天（口径反转，详见 `report_builder_daily.py:26-36`）。
- **「前一日」= 数据锚定日 - 1 天**（保留原对比逻辑语义，不改为「昨日」）。
- **与邮件 KPI 卡片的关系**：邮件仍写「今日销量 vs 昨日」（未改），AI 文案写「今日销量，较前一日」（本次改）。
  二者在"对比对象"用词上不一致（邮件用"昨日"，AI 用"前一日"），这是用户已确认接受的取舍。

## 测试策略

### 单元测试

- 同步修改 `backend/tests/services/scheduled_report/test_ai_timeout.py:202, 210` 的 fixture（把"昨日" → "今日"），
  保证现有断言通过；不改断言本身、不改被测逻辑。
- 不新增专项单测（现有测试已覆盖 prompt fallback 路径与 LLM 输出清洁逻辑，本次仅 fixture 字符串变更）。

### LLM 抽样测试（人工执行）

跑一次日报生成（任选 US + DE 两国，各 1 天），人工确认：

1. 文案里**不再出现**「昨日」字样；
2. 文案里**只出现**「今日销量 / 较前一日」组合；
3. 多条 bullet 之间有空行，ReactMarkdown 渲染为独立 `<li>`，Dialog 内可见清晰折行；
4. 多国家场景下每个国家是独立 bullet（◉ 美国站... / ◉ 德国站...）。

### 兼容性回归

- LLM 输出格式微调风险：1-2 周内偶发「今日 0 单」等边缘场景，但 fallback 路径已同步改，行为一致。
- 前端 Dialog 渲染：实测 `LedgerDetailDialog.tsx:418-425` 已有 `replace(/^[•·●]\s*/gm, '- ')`，bullet 前缀体系（◉ / -）都已兼容，无须改动。

## 回滚方案

单次 commit，所有改动集中在 4 个后端文件 + 1 个测试 fixture + 1 个 preview 脚本。

出问题：`git revert <commit>` 即可。数据库不动、历史 ledger 数据不动，回滚后旧 prompt 立即生效，新生成报告恢复「昨日」字样。

## 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| LLM 输出格式微调 | 低 | fallback 路径已同步改；单元测试覆盖清洁逻辑 |
| 与邮件 KPI「vs 昨日」用词不一致 | 中 | 用户已确认接受；规格文档明示 |
| 字段名 `yesterday_qty` 仍保留 | 低 | 内部约定，文档已说明口径反转 |
| 历史 ledger「昨日」字样未回填 | 低 | 用户明确不接受历史回填成本 |