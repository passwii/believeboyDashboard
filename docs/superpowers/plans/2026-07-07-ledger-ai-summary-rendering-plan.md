# Ledger AI 文案渲染优化 + 口径修正 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 `frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailDialog.tsx` 中 AI 文案的两个用户可见问题 —— ① 折行缺失；② 文案中「昨日」字样与「今日」口径不一致。后端 prompt + fallback 文案统一改成「今日销量 / 较前一日」，并强化 LLM list 折行硬约束。

**架构：** 5 个文件、纯字面量改动 + 1 段 prompt 追加。不动字段名、不动 API、不动数据库、不动邮件、不动前端 Dialog 组件、不动历史 ledger 数据。

**技术栈：** Python 3.11, 后端 `app.services.scheduled_report.*`, pytest

**规格文档：** [`docs/superpowers/specs/2026-07-07-ledger-ai-summary-rendering-design.md`](../specs/2026-07-07-ledger-ai-summary-rendering-design.md)

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `backend/app/services/scheduled_report/ai_enhancer_daily.py` | SYSTEM_PROMPT 主体 7 处文案替换 + 1 处 fallback 替换 + 1 条折行硬约束追加 |
| 修改 | `backend/app/services/scheduled_report/report_builder_daily.py` | 1 处单国家 fallback 文案替换 |
| 修改 | `backend/app/services/scheduled_report/dispatcher.py` | 1 处多国家 fallback 文案替换 |
| 修改 | `backend/tests/services/scheduled_report/test_ai_timeout.py` | 2 处 fixture 字符串同步替换 |
| 修改 | `backend/scripts/preview_report_screenshot.py` | 1 处 preview sample 文案同步替换 |
| 不动 | `frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailDialog.tsx` | 无「昨日」字面量，仅渲染 `ai_summary` 字段 |
| 不动 | `backend/app/services/scheduled_report/email_sender_daily.py:122, 399` | 用户明确邮件不在本次范围 |

---

### 任务 1：改造 `ai_enhancer_daily.py` SYSTEM_PROMPT 主体（7 处替换）

**文件：**
- 修改：`backend/app/services/scheduled_report/ai_enhancer_daily.py:14-67`（SYSTEM_PROMPT 内 7 处「昨日」→「今日」）

- [ ] **步骤 1：替换 line 17「昨日」字样**

在 `ai_enhancer_daily.py:17`：
- 原文：`- 首先描述"昨日"的单量和销售额 → 对比对象**只能是前一日（yesterday vs prev_day）**，绝对不能拿单日数据和近7天累计做对比`
- 改后：`- 首先描述"今日"的单量和销售额 → 对比对象**只能是前一日（yesterday vs prev_day）**，绝对不能拿单日数据和近7天累计做对比`

- [ ] **步骤 2：替换 line 22「昨日销量」**

在 `ai_enhancer_daily.py:22`：
- 原文：`- "昨日销量"的涨跌判断**仅基于 vs 前一日**（change_pct 字段）`
- 改后：`- "今日销量"的涨跌判断**仅基于 vs 前一日**（change_pct 字段）`

- [ ] **步骤 3：替换 line 24 错误示例**

在 `ai_enhancer_daily.py:24`：
- 原文：`- 错误示例："昨日6单，较前一日大幅下降（近7天累计39单）" → 这是拿单日 vs 7天累计得出"大幅下降"，逻辑错误`
- 改后：`- 错误示例："今日6单，较前一日大幅下降（近7天累计39单）" → 这是拿单日 vs 7天累计得出"大幅下降"，逻辑错误`

- [ ] **步骤 4：替换 line 25 正确示例**

在 `ai_enhancer_daily.py:25`：
- 原文：`- 正确示例："昨日6单/141.94欧元，较前一日增长12.5%（近7天累计39单/981.04欧元）"`
- 改后：`- 正确示例："今日6单/141.94欧元，较前一日增长12.5%（近7天累计39单/981.04欧元）"`

- [ ] **步骤 5：替换 line 37 德国站示例**

在 `ai_enhancer_daily.py:37`：
- 原文：`   示例（德国站）：`昨日6单/€141.94，较前一日增长12.5%（近7天累计39单/€981.04）``
- 改后：`   示例（德国站）：`今日6单/€141.94，较前一日增长12.5%（近7天累计39单/€981.04）``

- [ ] **步骤 6：替换 line 38 美国站示例**

在 `ai_enhancer_daily.py:38`：
- 原文：`   示例（美国站）：`昨日6单/$1,234.56，较前一日增长12.5%（近7天累计39单/$9,810.40）``
- 改后：`   示例（美国站）：`今日6单/$1,234.56，较前一日增长12.5%（近7天累计39单/$9,810.40）``

- [ ] **步骤 7：替换 line 46 多国家范本**

在 `ai_enhancer_daily.py:46`：
- 原文：`2. 多国家时每条以"XX站"开头，如"◉ 德国站昨日6单/141.94欧元..."`
- 改后：`2. 多国家时每条以"XX站"开头，如"◉ 德国站今日6单/141.94欧元..."`

- [ ] **步骤 8：替换 line 215 fallback 文案**

在 `ai_enhancer_daily.py:215`：
- 原文：`        f"- 昨日销量{today_qty}单{amt_str}，较前一日"`
- 改后：        `f"- 今日销量{today_qty}单{amt_str}，较前一日"`

- [ ] **步骤 9：验证 grep 无残留**

```bash
grep -n "昨日" backend/app/services/scheduled_report/ai_enhancer_daily.py
```

预期输出：无任何匹配行（line 215 已改、prompt 主体 7 处已改）。

---

### 任务 2：在 `ai_enhancer_daily.py` 追加 list 折行硬约束

**文件：**
- 修改：`backend/app/services/scheduled_report/ai_enhancer_daily.py:34-47`（在「强制格式规则」块第 2 条之后追加第 3 条）

- [ ] **步骤 1：定位追加点**

打开 `ai_enhancer_daily.py`，找到 `强制格式规则：` 块（line 34-47），第 2 条以 `2. **库存状况**必须包含可用库存和在途数量：` 开头、以 line 42 `   如果有缺货/告急SKU则另外标注，如：`库存285件在途665件，2个SKU缺货`` 结尾。

- [ ] **步骤 2：插入新第 3 条**

在 line 42 `   如果有缺货/告急SKU则另外标注，如：`库存285件在途665件，2个SKU缺货`` 之后、line 43 空行之前，插入以下内容（保留前导 3 空格缩进以与原条目对齐）：

```
3. **强制折行（bullet 隔离）**:
   - 每条 bullet 必须独占一行，绝对不允许把多条 bullet 合并成同一段落。
   - bullet 之间用一个空行隔开，确保 ReactMarkdown 渲染时每个 bullet 形成独立 <li>。
   - bullet 内部只写一个完整事实，不允许用中文逗号（，）或顿号（、）把多个并列事实串接到同一行。
   - 错误示例（折叠）："◉ 德国站今日6单/€141.94，较前一日增长12.5%，库存285件在途665件"
   - 正确示例（分行）：
     ◉ 德国站今日6单/€141.94，较前一日增长12.5%（近7天累计39单/€981.04）

     ◉ 德国站库存285件在途665件
```

- [ ] **步骤 3：验证 prompt 文本结构**

```bash
python -c "
import sys
sys.path.insert(0, 'backend')
from app.services.scheduled_report.ai_enhancer_daily import SYSTEM_PROMPT
assert '昨日' not in SYSTEM_PROMPT, 'SYSTEM_PROMPT still contains 昨日'
assert '强制折行' in SYSTEM_PROMPT, 'missing 强制折行 rule'
assert 'bullet 之间用一个空行隔开' in SYSTEM_PROMPT, 'missing bullet isolation rule'
print('SYSTEM_PROMPT OK')
"
```

预期输出：`SYSTEM_PROMPT OK`。

- [ ] **步骤 4：Commit 任务 1 + 任务 2**

```bash
git add backend/app/services/scheduled_report/ai_enhancer_daily.py
git commit -m "fix(scheduled-report): AI 文案「昨日 → 今日」并强化 bullet 折行硬约束"
```

---

### 任务 3：替换 2 处 fallback 文案（单国家 + 多国家）

**文件：**
- 修改：`backend/app/services/scheduled_report/report_builder_daily.py:769`
- 修改：`backend/app/services/scheduled_report/dispatcher.py:577`

- [ ] **步骤 1：替换单国家 fallback**

在 `backend/app/services/scheduled_report/report_builder_daily.py:769`：
- 原文：`    parts = [f"昨日销量{today_qty}单{amt_str}，较前一日{dir_label}{abs(vs_prev):.1f}%（近7天累计{p7d_qty}单{p7d_amt_str}）"]`
- 改后：`    parts = [f"今日销量{today_qty}单{amt_str}，较前一日{dir_label}{abs(vs_prev):.1f}%（近7天累计{p7d_qty}单{p7d_amt_str}）"]`

- [ ] **步骤 2：替换多国家 fallback**

在 `backend/app/services/scheduled_report/dispatcher.py:577`：
- 原文：`        line = f"◉ {label}昨日销量{qty}单{amt_str}，较前一日{dir_label}{abs(change_pct):.1f}%（近7天累计{p7d_qty}单{p7d_amt_str}）"`
- 改后：`        line = f"◉ {label}今日销量{qty}单{amt_str}，较前一日{dir_label}{abs(change_pct):.1f}%（近7天累计{p7d_qty}单{p7d_amt_str}）"`

- [ ] **步骤 3：全仓 grep 验证无「昨日」字样残留**

```bash
grep -rn "昨日" backend/app/services/scheduled_report/ backend/scripts/preview_report_screenshot.py backend/tests/services/scheduled_report/test_ai_timeout.py
```

预期输出：仅剩 `test_ai_timeout.py` 与 `preview_report_screenshot.py` 的 fixture/sample 匹配（任务 4 处理）。

- [ ] **步骤 4：Commit**

```bash
git add backend/app/services/scheduled_report/report_builder_daily.py \
        backend/app/services/scheduled_report/dispatcher.py
git commit -m "fix(scheduled-report): 单/多国家 fallback 文案「昨日 → 今日」"
```

---

### 任务 4：同步 fixture 与 preview sample 文案

**文件：**
- 修改：`backend/tests/services/scheduled_report/test_ai_timeout.py:202, 210`
- 修改：`backend/scripts/preview_report_screenshot.py:22`

- [ ] **步骤 1：读 test_ai_timeout.py 确认「昨日」位置**

```bash
grep -n "昨日" backend/tests/services/scheduled_report/test_ai_timeout.py
```

预期输出：line 202 与 line 210 各 1 处。

- [ ] **步骤 2：替换 fixture 中的「昨日」为「今日」**

按 `grep` 输出结果，逐一打开 fixture 所在行，把字符串字面量中的「昨日销量」改为「今日销量」（保持其它字符与缩进不变）。
注意：只替换 fixture 字符串本身；不要改动断言表达式、不要改动被测函数调用。

- [ ] **步骤 3：替换 preview sample**

在 `backend/scripts/preview_report_screenshot.py:22`：
- 找到该行 sample 文案中的「昨日」字样，改为「今日」。
- 不改动其它 token、不改动文件其它部分。

- [ ] **步骤 4：全仓 grep 验证「昨日」全部清空**

```bash
grep -rn "昨日" backend/app/services/scheduled_report/ \
              backend/scripts/preview_report_screenshot.py \
              backend/tests/services/scheduled_report/test_ai_timeout.py
```

预期输出：无任何匹配。

- [ ] **步骤 5：跑单测验证 fixture 未破坏断言**

```bash
cd backend && pytest tests/services/scheduled_report/test_ai_timeout.py -v
```

预期：全部测试通过。如有失败，优先检查 fixture 字符串是否改错（如改漏、多改），不要修改断言。

- [ ] **步骤 6：Commit**

```bash
git add backend/tests/services/scheduled_report/test_ai_timeout.py \
        backend/scripts/preview_report_screenshot.py
git commit -m "test(scheduled-report): 同步 fixture / preview sample 文案到「今日」口径"
```

---

### 任务 5：LLM 抽样测试（人工执行）

**目的：** 在合并前抽样跑一次日报生成，目视确认文案符合规格。

- [ ] **步骤 1：启动后端**

```bash
cd backend && uvicorn app.main:app --reload --port 8200
```

- [ ] **步骤 2：触发一次日报生成**

通过 `POST /api/v1/scheduled-reports/ledger/{ledger_key}/ai-summary/regenerate` 触发任意一条 ledger 条目的 AI 摘要重生成（参考现有"重生成"按钮逻辑）。
选择一个有 US + DE 双国家的订阅（覆盖多国家 bullet 场景）。

- [ ] **步骤 3：人工目视确认 ledger Dialog**

打开 `http://localhost:3200/dashboard/data-analysis/scheduled-reports/ledger`，点开刚生成的 ledger 条目，确认：

1. 文案中**不出现**「昨日」字样
2. 文案中**出现**「今日销量 X 单 / 较前一日 X%」组合
3. 多条 bullet 之间有空行，ReactMarkdown 渲染为独立 `<li>`，Dialog 内可见清晰折行
4. 多国家场景下每个国家是独立 bullet（`◉ 美国站...` / `◉ 德国站...`）

- [ ] **步骤 4：如发现问题，回到对应任务修复**

LLM 输出偶发格式异常属正常现象（spec §风险已说明）。如果「昨日」字样残留，回到任务 1/3 检查 grep 结果；如果折行问题持续，回到任务 2 检查 prompt 追加是否完整。

---

## 验收清单

- [ ] 5 个文件全部按规格改动（任务 1-4）
- [ ] 全仓 `backend/` grep `昨日` 无业务代码匹配（仅 spec 文档可保留历史字样作记录）
- [ ] `pytest tests/services/scheduled_report/test_ai_timeout.py` 全部通过
- [ ] LLM 抽样测试（任务 5）通过
- [ ] 单次需求对应 3-4 个 commit（任务 2 / 3 / 4 各一），可独立 revert

## 回滚方案

```bash
git revert <commit-1> <commit-2> <commit-3>
```

数据库不动、历史 ledger 数据不动，回滚后旧 prompt 立即生效，新生成报告恢复「昨日」字样。

## 不在范围内（明确排除）

- 邮件 KPI 卡片「vs 昨日」标签（`email_sender_daily.py:122, 399`）—— 用户已确认不动
- 前端 `LedgerDetailDialog.tsx` 渲染层 —— 无字面量
- 字段名 `yesterday_qty` / `yesterday_amount` —— 与查询紧耦合
- 存量 ledger `ai_summary` 历史数据 —— 不迁移、不回填
- 周报 / 月报 prompt —— 不含「昨日/今日」字样，本就不在范围