# BLF-1250 阶段一实施计划

> **面向 AI 代理的工作者：** 使用 executing-plans 逐任务实施；测试先于实现，验证先于交付。

**目标：** 原始 CSV＋可选 PDF 上传、异步计算预览、确认后一次性正式入库，禁止 Agent 自动覆盖已有成功月报。

**架构：** 独立预览服务直接调用现有 CSV→PT3/PT4/XLSX 内核，不经过 Job 的 prepare/persist 分支。会话与 build 在数据库保存归属、24 小时期限与不可变输入/结果摘要；confirm 在事务内重检权限、同月成功报告及持久化幂等记录。附件晋升失败需补偿，事务已提交后不得删除正式文件。

**技术栈：** FastAPI、SQLAlchemy/PostgreSQL、Celery、Redis confirmation、现有 payment parser / monthly_report.run。

## 已批准规则与边界

用户评论 `01a110ef-a1ee-779d-b599-9dff498d8e9a`：CSV/PDF 各 50 MiB；临时输入与结果 24 小时；正式文件暂不自动删除；同项目＋国家＋月份已有成功月报时 Agent 确认返回冲突。PDF 可选、不参与计算。阶段二、三仍不启动。

父总方案原始 commit 不在本地或已 fetch 的 origin 中；已从父 issue 权威描述与评论对齐，不再把缺失文档当作产品决策阻塞。

## 技术单元 A：仅计算、可校验的草稿产物（独立增量）

**新增文件：**
- `backend/app/services/monthly_report_preview_service.py`：直接调用计算内核；保存可跨进程读取的 JSON＋XLSX；使用 Decimal 的十进制字符串而非浮点转换；检查输入与结果摘要；失败撤销本次输出。
- `backend/tests/services/test_monthly_report_preview_service.py`：真实 CSV 与 XLSX 核验，不 mock 财务公式；禁止建立数据库会话；输入变更、结果损坏、产物不存在及清理测试。

**不修改：** Job/Celery 自动入库流程、公共 schema/model、权限、已部署迁移、前端。

- [x] 已有基础测试与服务实现保存在恢复工作树的 `1a60ea75`；本轮核验并补充 US/DE/UK 同内核对账、大精度 Decimal、worker 软超时清理、越界输出及输入摘要绑定测试。
- [x] 缺失服务的初始红灯阶段无法从现有记录证明，不补写虚假 TDD 历史。本轮新增清理异常回归测试，先确认 1 failed：清理 OSError 覆盖原始计算异常；再实现保留原异常并记录清理失败，后续由生命周期 janitor 重试。工作树缺少 `.env.test`，已核验本机配置指向本地 Unix socket `BLF_test` 并复制至 ignored 文件后复跑。
- [x] 实现：内核调用 → 类型安全 JSON → SHA-256 → 可校验读取；每次独占新的输出目录，失败只清理本次目录。
- [x] T2 目标回归：`python -m pytest tests/services/test_monthly_report_preview_service.py tests/services/test_payment_classifier_de.py tests/services/test_payment_other_transaction_fees.py tests/services/test_payment_vat.py tests/services/test_monthly_report_runtime_service.py tests/tasks/test_run_job_celery.py tests/services/test_rebuild_pt3_pt4_uses_country.py -q`：**63 passed / 0 failed / 0 errors / 27 warnings**，1.30 秒。其中预览测试 30 例；warnings 全部来自既有内核 `datetime.utcnow()` 弃用提示。未动公共符号/schema/model/权限/迁移，不跑 T3 全量，前端未改。
- [x] 独立增量整理提交 PR，明确“不包含可调用端点，不关闭 BLF-1250”；交 Tia review。移除恢复任务误提交的三份根目录测试日志，不将环境错误/日志作为源码交付。BLF-1250 保持 in_progress，A review 后 Damon 继续 B/C。

CodeGraph：新工作树索引已初始化；`callers/impact` 显示预览服务只由自身及新增测试调用。`build_preview` 与 confirm 的同名 callback 存在索引名字匹配误报，实际 confirm 未导入本服务；原 Job/Celery 自动入库路径未修改。A 的路径/hash 仅接受可信服务端元数据，权限、24 小时期限与确认不由 A 实现，必须在 B/C 完成后才能开放。

## 技术单元 B：上传、持久化状态与异步预览

**文件职责：** `backend/app/models/agent_monthly_report.py` 保存 upload/build owner_key_id、project_id、country、month、expires_at、status、输入摘要、A 的结果摘要及 report_id；对应短数字 revision 迁移先 rebase main 再创建。`backend/app/api/agent/routers/monthly_reports.py` 提供契约里的 uploads/files/builds/status/preview/result；`backend/app/celery_tasks/monthly_report_preview.py` 在 reports queue 调用 A。注册 business_scope monthly_reports，复用身份、项目 scope 与 audit，不接内部 protected。

- [ ] 建迁移前同步 main、确认单 head；先写合法二进制上传与非法/空/超限 CSV/PDF 测试；按 1 MiB 分块累计，不信 Content-Length。每会话一个 CSV＋可选 PDF，服务端随机路径，禁止 URL/base64/path 参数。
- [ ] 写每步身份、business_scope、project_scope 与 key 归属测试；撤销 scope 后拒绝查询/下载；跨 Agent ID 返回 404，响应不带本地路径。
- [ ] 写 build 只改变临时表、正式表行数不变及 CSV-only 流程测试；Celery 用数据库领取 queued 状态，重复投递不重复执行；Broker 派发失败返回可重试错误并恢复状态。
- [ ] 写 24 小时过期及超时恢复测试；数据库状态＋文件清理互斥，清理不删正在计算目录。期限不能在重试中无限延长。

## 技术单元 C：确认入库、并发和补偿

**文件职责：** `backend/app/services/agent_monthly_report_confirm_service.py` 执行 scope/摘要/期限检查、token 与数据库幂等、附件晋升及正式 persist；既有 `backend/app/services/report/monthly.py` 的 prepare/persist 与 Agent 共用数据库目标键锁，覆盖 dashboard 竞争。

- [ ] 写首次确认 requires_confirmation、相同 body/key/token 重放成功、响应丢失后重试返回同 report_id、异体 key 冲突测试。
- [ ] 写同 build/不同 build 同月竞争与 dashboard 竞争测试；锁内检查所有 success 报告（包含非 current）。Agent 不把已成功报告置为非 current。
- [ ] 写晋升失败、DB 回滚、DB 成功但清理/响应失败测试；DB 回滚删除本次正式目录，已提交后绝不补偿删除。
- [ ] 写失败审计与敏感数据不泄漏断言；对齐 confirmed 状态、report_id 与幂等唯一约束。
- [ ] T3 一次全量 `cd backend && python -m pytest`；失败文件在 main 对账；跑 `python scripts/check_alembic.py`；完整功能 PR [risk:high] 交 Tia，由用户验收，作者不合并。

## 验收与推进

A 只是基础设施，不等于阶段一完整交付；B/C 必须补齐契约测试矩阵。阶段一完整 PR 与业务验收完成前保持 in_progress，不开启 BLF-1251/1252。代码增量 review 完成后继续下一单元，不能让 run-owned 后台进程承接交付。
