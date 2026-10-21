# CRM 方案分段上传 · 测试报告

> 日期：2026-10-21 · 分支：`main`（工作区改动，未提交）· 执行人：Damon
> 关联计划：[`../2026-10-21-crm-proposal-chunked-upload.md`](../2026-10-21-crm-proposal-chunked-upload.md)

## 1. 实现范围

只改 CRM 方案上传链路；R2 桶、CORS、presigned、其他上传模块、迁移链均未改动。

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 后端 | `app/services/crm/proposal_chunked_upload.py` | 3MB 分段、UUID 目录、owner 绑定、2h TTL、合并、惰性清理 |
| 后端 | `app/api/v1/endpoints/crm_proposals.py` | `POST /uploads/init`、`/{id}/versions/uploads/init`、`/uploads/{id}/chunks/{index}`、`/uploads/{id}/finalize` |
| 后端 | `app/services/crm/proposal_service.py` | 抽出 `*_from_bytes` 与公共落库/R2 尾段；原 multipart 路径行为不变 |
| 后端 | `app/services/crm/proposal_render_service.py` | 新增 `validate_html_bytes` |
| 前端 | `lib/crm/api/http-crm-client.ts` | ≤4MB 走原 multipart；>4MB 自动 init → 分段 → finalize |
| 前端 | `lib/crm/constants/proposal.ts` | 20MB 上限、4MB 分段阈值 |
| 前端 | `lib/crm/api/crm-client-provider.tsx` | 默认 `http`；生产显式 `mock` 直接报错 |
| 前端 | `lib/server/backend-proxy-timeout-policy.ts` | 分段/收尾路径纳入 60s 档 |
| 运维 | `scripts/cleanup_crm_proposal_upload_temp.py` | 过期临时目录清理（init 也会惰性清理） |

## 2. 后端测试

### 新增用例

```bash
pytest tests/api/crm/test_proposal_chunked_upload.py \
       tests/services/crm/test_proposal_chunked_upload.py \
       tests/scripts/test_cleanup_crm_proposal_upload_temp.py -q
```

结果：**16 passed**（7 API + 8 service + 1 script）。

覆盖：init 扩展名/大小、分段 owner/越界/单段大小、分段不完整、合并大小、finalize 创建、幂等 finalize、追加版本、过期清理。

### CRM 目标集

```bash
pytest tests/api/crm tests/services/crm tests/scripts/test_cleanup_crm_proposal_upload_temp.py -q -p no:randomly
```

结果：**739 passed / 10 failed**。  
10 个失败与基线完全一致（测试库 `TRUNCATE` 后缺 `crm_categories` 种子、performance 排行数据），与本次改动无关。

### 后端全量（T3）

```bash
pytest -q -p no:randomly
```

结果：**4362 passed / 66 failed / 16 skipped**（335.70s）。

失败集对账（仓库规则）：把 11 个失败文件在 pristine `origin/main`（`f465d71c`）worktree 上重跑：

```text
baseline = 66
current  = 66
仅在 current = 0
仅在 baseline = 0
```

**双向差集为空 → 零回归。**

> 失败均为本地测试库缺参考数据/种子（project workflows、user api keys、crm categories/performance、project reorder 等），非本次代码引入。

## 3. 前端测试

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **276 files / 2129 tests passed**（97.84s；含 check:mocks / check:motion） |
| `pnpm lint` | **0 errors / 27 warnings**（均为既有基线） |
| `pnpm build`（`NEXTAUTH_SECRET` + `NEXT_PUBLIC_CRM_API_MODE=http`） | **成功**（TypeScript 通过） |
| `pnpm gen:api-types:check` | OK |
| `make openapi-check` | OK |
| `python scripts/check_alembic.py` | OK（单 head、无迁移变更） |

新增前端用例：分段 init/逐段/finalize 调用顺序、≤4MB 仍走 multipart、分段 5xx 重试、provider 默认 http 与生产禁 mock、常量/阈值、代理超时档。

## 4. 真机验证（待部署后执行）

本地没有生产 R2 凭据，**未对真实桶执行 20MB 上传**；本次 R2 边界用 mock 覆盖。部署后需验证：

| 文件大小 | 路径 | 期望 |
| --- | --- | --- |
| 1MB | 旧 multipart | 201 |
| 4MB | 旧 multipart | 201 |
| 4.1MB | 分段 2 段 | 201 |
| 6MB | 分段 2 段 | 201 |
| 20MB | 分段 7 段 | 201 |
| 20MB + 1B | 前端拦截 | 20MB 上限提示 |
| 非 HTML | init 拦截 | 400 |
| 少传一段 | finalize 拦截 | 400 |
| 超过 2h | finalize 拦截 | 404/410 |

SQL 核对：

```sql
select id, title, current_version_no from crm_proposals order by id desc limit 5;
select proposal_id, version_no, raw_r2_key, adapted_r2_key, file_size
from crm_proposal_versions order by id desc limit 5;
```

R2 两份对象存在、大小与 `file_size` 一致；预览/下载正常。**桶配置无需任何改动。**

## 5. 回滚

- 前端：把 `PROPOSAL_CHUNK_THRESHOLD_BYTES` 临时改为 `PROPOSAL_MAX_UPLOAD_BYTES`（始终走旧 multipart），>4.5MB 恢复失败但不影响现有 ≤4MB。
- 后端：新端点可保留不用；无迁移、无 R2 变更需要回滚。
- 临时目录：`scripts/cleanup_crm_proposal_upload_temp.py` 或自然 TTL 清理。
