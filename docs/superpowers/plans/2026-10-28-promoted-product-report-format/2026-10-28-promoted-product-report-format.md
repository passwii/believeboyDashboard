# 已推广商品报表新版兼容实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让自动上传同时识别和入库新版、旧版 Amazon 已推广商品报告。

**Architecture:** 在广告上传专用识别层增加新版报表签名；在共享日期解析函数理解“日期范围”；在推广商品入库映射层读取新旧字段别名，并维持现有数据库模型。识别响应从新国家列取值，原始列结构保留。

**Tech Stack:** Python、pandas、pytest、现有 FastAPI 广告上传服务。

## Global Constraints

- 不改数据库 schema 或其他报表类型。
- 旧格式行为保持兼容。
- 新版百分比列除以 100 存储为比例。
- 多日范围继续由当前 commit 流程拒绝实际入库。

---

### Task 1: 新版签名与日期解析

**Files:**
- Modify: backend/app/services/ad/upload/specs.py
- Modify: backend/app/services/ad/upload/utils.py
- Modify: backend/app/services/ad/upload/recognition.py
- Modify: backend/app/services/data/upload/validate.py
- Test: backend/tests/services/ad/upload/test_recognition.py
- Test: backend/tests/services/ad/upload/test_utils.py
- Test: backend/tests/services/data/upload/test_validate_ad_report_date_range.py

- [x] 测试新版列签名、日期范围（中文年月日与 ISO）和识别返回国家/起止日期；已观察到目标场景失败。
- [x] 接入新报表签名、合并日期解析和新国家列兼容。
- [x] 接入通用广告校验的日期范围解析；已观察到目标旁路失败并验证修复。
- [x] 重跑相关测试确认新版场景通过，旧识别回归正常。

### Task 2: 新旧指标入库映射

**Files:**
- Modify: backend/app/services/ad/upload/utils.py
- Modify: backend/app/services/ad/upload/persistence.py
- Test: backend/tests/services/ad/upload/test_utils.py
- Test: backend/tests/services/ad/upload/test_persistence.py (create if no focused persistence test exists)

- [x] 为新旧同义列编写入库映射用例，覆盖 SKU/ASIN、成本、点击率、订单、销量、销售额、ROAS、转化率、国家和货币；已观察到新版场景失败。
- [x] 增加字段别名读取和新版百分比/ACOS 处理。
- [x] 重跑目标识别、日期与映射用例确认新版和旧版路径通过。

### Task 3: 最终复核

- [x] 运行广告上传识别与工具目标测试：101 passed；相关数据上传既有测试 5 passed / 5 skipped；全量收集被缺少环境依赖阻断。
- [x] 检查工作区 diff，并确认功能代码仅涉及广告上传识别、详情映射和通用校验入口。
- [x] 根据复审补充本地化国家码规范化，并以用户提供的新工作簿核实新版 CTR 的百分数点编码。
- [x] 确认 CRM 的既有工作区改动仍未被修改。
