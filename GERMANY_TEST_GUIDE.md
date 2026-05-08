# Germany Monthly Report 全流程测试指南

## ✅ 已完成的修复

### 1. 后端修复
- **文件**: `backend/app/services/monthly_report_service.py`
  - Excel 导出表头现在根据 country 动态显示货币：
    - DE → EUR
    - UK → GBP
    - US → USD

- **文件**: `backend/app/services/payment_report_locale.py`
  - 添加了 11 个新的德语描述映射
  - 完善了德国站 Transaction CSV 的解析支持

### 2. 前端修复
- **文件**: `frontend/app/dashboard/data-analysis/financial-data/financial-data-client.tsx`
  - 添加了 `currencyLabel` useMemo 计算
  - 修改了月度明细表格表头：
    - `In金额（USD）` → `In金额（{currencyLabel}）`
    - `Ex金额（USD）` → `Ex金额（{currencyLabel}）`
  - 修改了财务数据表格表头：
    - `净利润USD` → `净利润{currencyLabel}`

---

## 🧪 测试步骤

### 方法一：页面直接测试（推荐）

#### Step 1: 启动前后端服务
```bash
# 后端
cd backend
source .venv/bin/activate  # 或你的虚拟环境
./run_api.sh

# 前端（新终端）
cd frontend
pnpm dev  # 或 npm run dev
```

#### Step 2: 访问 Monthly Report 上传页面
1. 打开浏览器访问：`http://localhost:3000/dashboard/data-reporting/monthly-report`
2. 选择「德国站 (DE)」
3. 上传 German Transaction CSV 文件（可以从亚马逊卖家后台下载）
4. 填写项目名称和月份
5. 点击「生成报表」

#### Step 3: 验证后端处理
- 检查后端日志是否有错误
- 确认数据库中 `monthly_reports` 表有新增记录且 `country='DE'`

#### Step 4: 下载并验证 Excel
1. 在 Monthly Report 列表中找到刚生成的报告
2. 点击「下载 Excel」
3. 打开 Excel，验证：
   - ✅ 表头显示 `In金额（EUR）`（不是 USD）
   - ✅ 表头显示 `Ex金额（EUR）`（不是 USD）
   - ✅ 数据内容正确

#### Step 5: 验证 Financial Data 页面
1. 访问 `http://localhost:3000/dashboard/data-analysis/financial-data`
2. 选择对应的项目和德国站
3. 在「月度明细」部分选择刚才上传的月份
4. 验证：
   - ✅ 表头显示 `In金额（EUR）`
   - ✅ 表头显示 `Ex金额（EUR）`
   - ✅ 表头显示 `净利润EUR`

---

### 方法二：运行后端测试

```bash
cd backend
source .venv/bin/activate

# 运行德国支付报告测试
pytest tests/test_payment_report_locale.py::test_de_payment -v

# 运行德国 CSV 解析测试
pytest tests/test_monthly_reports.py::test_monthly_report_csv_reader_supports_de_locale -v
```

---

### 方法三：使用测试数据验证

如果你暂时没有真实的 German Transaction CSV，可以使用以下测试数据创建：

**创建测试文件 `test_de_transaction.csv`：**
```csv
meta-line-1
meta-line-2
date/time;typ;bestellnummer;beschreibung;menge;umsätze;produktumsatzsteuer;gutschrift fuer versandkosten;steuer auf versandgutschrift;verkaufsgebuehren;gebuehren zu versand durch amazon;andere;gesamt
"Mar 01, 2026 01:23:45 PM UTC";bestellung;123-4567890-1234567;SKU-DE-001;2;1.234,56;0,00;0,00;0,00;-123,45;-45,67;0,00;1.065,44
"Mar 02, 2026 02:34:56 PM UTC";bestellung;123-4567890-1234568;SKU-DE-002;1;567,89;0,00;0,00;0,00;-56,78;-23,45;0,00;487,66
```

**注意：**
- 使用分号 `;` 作为分隔符（德语 CSV 格式）
- 数字格式使用 `1.234,56`（千位用点，小数用逗号）
- 保存时使用 UTF-8 编码

---

## ⚠️ 已知限制

1. **Excel 导出列定义**：`financial-data-client.tsx` 第 644 行的静态列定义 `title: '净利润USD'` 主要用于 Excel 导出功能。如果需要 Excel 中也动态显示货币符号，需要进一步重构。页面上的显示已经正确。

2. **数据字段命名**：后端返回的数据字段名（如 `net_profit_usd`、`income_amount_usd`）仍然包含 `usd` 后缀，这是历史遗留的命名，不影响实际业务逻辑。

---

## 🔍 故障排查

### 问题 1: 上传后没有生成报表
- 检查后端日志是否有解析错误
- 确认 CSV 文件格式正确（德语列名）
- 确认选择了正确的国家（德国站）

### 问题 2: Excel 仍显示 USD
- 确认后端已重新部署（修改了 `monthly_report_service.py`）
- 确认前端已重新构建（修改了 `financial-data-client.tsx`）

### 问题 3: 德语描述解析警告
- 如果看到 `Unknown description for DE locale` 警告，说明遇到了未映射的德语描述
- 将具体的德语描述添加到 `payment_report_locale.py` 的 `PAYMENT_DESCRIPTION_ALIASES` 中

---

## 📞 需要帮助？

如果遇到问题，请提供：
1. 后端错误日志
2. 浏览器控制台错误
3. 上传的 CSV 文件样本（可脱敏）
