# BLF-1250：月报 Agent 写入契约草案

关联：父 issue BLF-1249，阶段一 BLF-1250。产品规则已确认；阶段一实现已提交并部署，端到端验收待授权凭据。

## 已确认产品规则

Yawei 于 2026-10-06 确认：每个 CSV/PDF 最大 50 MiB；未确认输入和 build 结果保留 24 小时；正式附件暂不自动删除；同项目＋国家＋月份已有成功月报则拒绝 Agent 再次入库、不自动替换当前版本；PDF 尽量上传但非必传，缺失不影响计算，也不参与计算。

父 issue 评论引用的初始总方案 commit `9aea3812` 在本工作树/本地对象库中不可见；本契约记录阶段一经用户确认的规则及实施接口设计，不冒充读取过不可见历史文件。

## 当前代码与复用限制

| 位置 | 现有行为 | 阶段一处理 |
| --- | --- | --- |
| `backend/app/api/v1/endpoints/monthly_reports.py:51` | 内部接口校验文件后直接创建计算任务 | 不直接暴露给 Agent，不继承 dashboard 的 `protected` |
| `backend/app/services/monthly_report_runtime_service.py:42` | 经 Job/Celery 发起月报任务 | 可复用任务基础设施，但须新增预览模式 |
| `backend/app/celery_tasks/_common.py:144` | 执行前准备并 commit 正式 MonthlyReport 行 | Agent build 必须绕开，不能先创建正式月报 |
| `backend/app/celery_tasks/run_job.py` | 任务成功后自动持久化月报计算结果 | Agent build 必须仅保存临时结果；confirm 后才调用持久化 |
| `backend/app/tasks/scripts/monthly_report.py:158` | CSV 计算与 XLSX 生成；返回 transactions、PT3、PT4 等结果 | 复用计算内核，不复制财务公式，不在 confirm 重新计算 |
| `backend/app/services/report/monthly.py:139` | 新建递增版本 | 版本规则须经产品确认；不是无条件安全的 Agent 写入入口 |
| `backend/app/services/report/monthly.py:303` | 入库结果后自动将其他版本置为非 current，新版本成为 current | 即使保留历史，也会替换页面当前财务结果，不能默认授权 |
| `backend/app/api/agent/confirm.py` | Redis 单次 token，默认逻辑有效期 300 秒；绑定身份、幂等键、请求体 hash | 复用确认机制，额外绑定不可变 build 结果/输入摘要 |
| `backend/app/api/agent/scope.py` | business_scope 与 project_scope 门禁 | 新增独立 `monthly_reports` 域，每一步重新检查权限 |
| `backend/app/api/v1/endpoints/agent/upload.py` | 通用 validate/commit 上传，不等同月报 build/confirm | 不把通用 commit 当成月报确认流程 |
| `backend/app/core/config.py:129` | 通用上传限制 `max_upload_bytes = 50 * 1024 * 1024` | 月报上传仍单独按流累计执行已确认的 50 MiB 上限 |

## 已确认规则的落地说明

1. 上传端按请求体与 multipart 文件分块累计两次字节数，均不依赖 Content-Length；每个 CSV/PDF 限制 50 MiB。
2. 临时上传与结果 24 小时后不可用；janitor 只清理 Agent 私有根目录，不删除正式文件。
3. 正式文件暂无自动删除规则。
4. confirm 前以目标项目＋国家＋月份检测成功或在途记录，冲突返回 409；不会自动创建覆盖版本。Dashboard 原流程保持不变。
5. Agent key 必须显式授予 `business_scope=monthly_reports`；所有项目读写步骤重查 `project_scope`。

阶段二 CSV 导出列契约仍未确认，因此不纳入 Stage 2。

## 阶段一 API 形状

以下为已落地的阶段一写入接口；阶段二读接口记录在实现计划与 BLF-1251 验收中。

统一前缀：`/api/v1/agent/monthly-reports`，business_scope：`monthly_reports`。

| 操作 | 方法与相对路径 | 输入/输出 |
| --- | --- | --- |
| 创建临时上传会话 | `POST /uploads` | JSON：project_id、country、report_month；返回 upload_id、expires_at |
| 上传 CSV/PDF | `POST /uploads/{upload_id}/files` | multipart/form-data：file 为原始二进制，kind 为 transaction_csv 或 summary_pdf；返回不透明 file_id、sha256、bytes、校验摘要 |
| 发起 build | `POST /builds` | JSON：upload_id、transaction_file_id、可选 summary_pdf_file_id；返回 202、build_id、状态端点 |
| 查询 build | `GET /builds/{build_id}` | queued/running/success/failed/expired；不返回服务器绝对路径/原始异常堆栈 |
| 预览结果 | `GET /builds/{build_id}/preview` | 只返回授权范围内指标/行数/输入摘要/版本预条件/到期时间，不返回全部交易明细 |
| 下载草稿 | `GET /builds/{build_id}/result` | XLSX 二进制响应，私有、不可通过公开 URL 绕过权限 |
| 请求确认/确认入库 | `POST /builds/{build_id}/confirm` | 首次返回既有 requires_confirmation 壳与 token；携带 X-Confirm-Token 重放相同请求体、相同 Idempotency-Key，正式入库并返回 report_id |

文件内容不得使用 JSON base64、任意远端 URL 或服务器路径输入。临时上传会话、任务元数据的存储不等于正式财务入库；confirm 前不写 MonthlyReport、交易、PT3、PT4 正式表。

## 状态、权限与一致性

- 会话绑定 Agent/key、project_id、规范化 country、report_month，项目名称从服务端项目记录解析；上传后输入对象不可变，更换文件必须创建新的 build。
- 每个上传、build、查询、预览、下载、confirm 重新验证身份、business_scope、project_scope，并检查资源归属；其他 Agent 的不透明 ID 不能用于读取、计算或确认。
- CSV 校验复用支付报表 parser 与项目/国家匹配校验，要求计算必需列、受支持编码与可计算行；PDF 验证扩展名/MIME/文件签名，不参与计算；拒绝空文件、路径穿越、畸形文件、超限文件。客户端文件名只用于展示，不作为存储路径。
- 任务与临时结果需可跨 API/Celery 进程访问，不能使用仅在一个进程中的内存 dict 作为正式状态源。计算结果保存为服务端可验证的结构化临时文件/对象，保存输入、结果 hash 与 calculation_version。
- build 仅调用计算内核，显式禁止 prepare/persist 正式月报分支；dashboard 旧流程保持兼容，不能把所有月报任务统一改成不入库。
- confirm 不重新计算：绑定 build_id、输入/结果摘要、目标年月/国家/项目、预期当前版本和幂等键；确认时检查结果成功、文件未过期/未变化、权限仍有效。
- 同一 build 的确认需要数据库事务与持久化去重，不能只依赖单次 Redis token。事务提交 report_id 与 confirmed 状态；请求响应丢失后同幂等键重试返回相同 report_id，不新增版本。相同幂等键不同请求应冲突。
- 同项目/国家/月份不同 build 并发确认，需数据库级串行化（包括 dashboard 写入的竞争）；版本预条件过时应冲突。具体锁与唯一约束方案在产品规则确定后选定，不能仅做应用层“先查再写”。
- 正式附件复制/对象存储晋升与数据库事务之间需要补偿：DB 失败撤销本次晋升，结果尚可用时允许重新请求 token 重试；DB 已提交则不得因后续响应/清理失败删除正式文件。
- token 到期只作确认失败，不自动删除仍在临时期限内的 build；允许重新获取确认预览。
- 审计记录 Agent/key、目标项目/月份、build_id、输入/结果 hash、report_id、结果与拒绝原因；不记录 token、凭据或原始财务二进制。

## 实施与验收顺序

1. 用户已确认大小/保留/同月策略；实现按照上述规则落地。
2. 阶段一已在 PR #669/#671 实现并合并部署，迁移至 277；review 记录包含目标与全量测试、迁移门禁和部署结果。
3. 端到端人工验收需使用显式授予 `monthly_reports` 的 Agent 凭据：CSV（以及可选 PDF）上传 → build → preview → confirm → Dashboard 核验。
4. 阶段二实现 Agent 读取与 XLSX 结果/核算导出，复用内部 report services，继续覆盖 scope、版本/空数据、错误壳与二进制 OpenAPI。

验收用例至少覆盖：

- CSV + PDF 完整流程；CSV 单独完整流程，证明 PDF 缺失不影响计算。
- confirm 前正式表均无新记录，build 指标与现有月报内核一致；confirm 后正式指标与预览一致。
- business_scope/project_scope 越权、资源归属越权、确认前权限撤回、伪造管理头。
- 请求体/file_id/build_id/摘要篡改、过期/重复 token、同幂等键重试与异体冲突。
- 同 build 并发确认、不同 build 同月并发确认、与 dashboard 写入竞争；已有月报不得未经授权成为非 current。
- 超限/空/畸形 CSV/PDF、路径穿越、输入文件过期/缺失、运行任务超时、计算失败、临时结果损坏。
- 晋升失败、数据库失败、DB 已提交但响应丢失；临时清理失败不损坏正式附件，重试不重复入库。

## 交付状态

阶段一写入流程已实现并部署（PR #669/#671，Alembic 277）；真实线上 Agent 完整链路曾因缺少可用且已授权的测试凭据未执行。Yawei 于 2026-10-07 明确同意继续后续 issue。阶段二读取与文件导出由 BLF-1251 实现，本契约保留写流程边界与产品规则作为参考。
