# CRM 客户方案大文件直传 R2 实施计划

> **状态：已废弃（2026-10-21）。** 因改动面过大（需改 R2 桶 CORS、新增迁移与上传会话表），改用更小改动面的分段上传方案：[`2026-10-21-crm-proposal-chunked-upload.md`](./2026-10-21-crm-proposal-chunked-upload.md)。本文仅保留作方案对比记录。
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 5–20MB 的方案 HTML 绕过 Vercel 函数 4.5MB 请求体限制：浏览器凭后端签发的短时 presigned PUT 直传 Cloudflare R2，后端只做对象校验、HTML 适配、版本落库。

**Architecture:** 三段式上传。① `POST /crm/proposals/uploads/init`（经 Next 代理，JSON 很小）创建上传会话并返回一次性 presigned PUT URL；② 浏览器把文件直接 PUT 到 R2（不经过 Vercel）；③ `POST /crm/proposals/uploads/{id}/finalize`（经 Next 代理，JSON 很小）由后端 HEAD/下载临时对象、校验大小与 HTML、适配主题、写最终 raw/adapted 对象并落库。API Key 始终只在服务端，前端不持有任何 R2 凭据。

**Tech Stack:** FastAPI / SQLAlchemy / Alembic / boto3（Cloudflare R2）/ Next.js App Router / TypeScript / Vitest / pytest / Playwright。

## Global Constraints

- 后端业务上限保持 `crm_proposal_max_bytes = 20 * 1024 * 1024`（20MB），前端直传上限同步为 20MB。
- 浏览器**不得**持有 `X-API-Key`、R2 access key / secret；只允许拿到单个对象的短时 presigned PUT URL。
- presigned URL 只能指向 `crm-proposals/` 下的目标 key，TTL ≤ 15 分钟，禁止任意 key。
- 方案对象属于敏感数据；若 #764（R2 私有桶）已合入，临时与最终对象都必须走私有桶。未合入时按当前公开桶运行，但 key 必须不可枚举（UUID 会话目录）。
- 运行时不再使用 Mock CRM 客户端；Mock 只允许在显式测试配置下使用。
- 迁移按仓库约定：文件名 `YYYYMMDD_NNN_description.py`、revision 纯数字、`NNN` 从最新递增；建迁移前先 `alembic heads` 确认单 head。当前 head 为 `283`，本计划使用 `284`。
- 本改动命中 T3（迁移 + `app/core/config.py` 邻接的存储/上传契约 + 新公共 schema），全量后端 pytest + 前端全量 vitest + lint 不可省。
- commit message 中文 + Conventional Commits；不得使用 `TODO` / `FIXME` / `console.log` / `debugger`。

---

## 全局上传体检结果（2026-10-21 代码核对）

**结论：不只 CRM 方案受影响。凡是“浏览器 → Next 代理 → 后端”且后端上限 > 4.5MB 的上传，都会撞 Vercel 函数请求体硬上限。**

| 上传功能 | 前端路径 | 后端上限 | 是否撞 4.5MB | 说明 |
| --- | --- | --- | --- | --- |
| CRM 客户方案 | `/api/backend/v1/crm/proposals` | 20MB（`crm_proposal_max_bytes`） | **是**（你已实测 5MB 失败） | 本次修复对象 |
| 项目流程附件 | `/api/backend/api/v1/.../workflow-tasks/{id}/attachments` | 50MB（`workflow_attachment_max_bytes`） | **是** | 模板页文案写着“单个文件最大 50MB”，实际会在 4.5MB 被网关拒 |
| 报表识别/提交 | `/api/backend/api/v1/report-upload/{recognize,commit}` | 50MB（`max_upload_bytes`） | **是** | 表体越大越容易中招；目前只配了 60s 超时，没解决体积 |
| 广告报表上传 | `/api/backend/api/v1/ad-upload/*` | 50MB 级 | **是** | 同上 |
| 巡检截图 | `/api/inspections/screenshot-upload`（独立 Route Handler） | 10MB（`_MAX_SCREENSHOT_BYTES`） | **是** | 仍经 Vercel 函数；图片常见 3–8MB，风险高 |
| page-render | `/api/backend/api/v1/page-render/upload` | 2MB（`page_render_max_bytes`） | 否 | 上限低于网关，暂安全 |
| 用户头像 | `/api/user/avatar` | 5MB（`avatar_max_bytes`） | **边缘** | 5MB 略高于 4.5MB，接近上限时可能失败 |
| AI 文件上传 | `/api/file-upload` | 后端 `max_upload_bytes` | **是** | 同代理链路 |

**修复优先级建议：**

1. **P0：CRM 方案**（当前已阻塞业务，按本计划做 presigned 直传）。
2. **P1：项目流程附件 / 报表上传 / 广告上传**（50MB 声明与 4.5MB 现实严重不符，用户会以为功能坏了）。
3. **P2：巡检截图 / 头像**（图片经前端压缩后可先行规避；再按同一 presigned 模式改造）。

> 统一模式：**后端签发 presigned PUT → 浏览器直传 R2 → 后端 finalize**。不建议为每个功能单独发明轮子；先抽公共能力，再逐域接入。

---

## 方案对比（为什么选 presigned R2）

| 方案 | 是否可行 | 结论 |
| --- | --- | --- |
| **浏览器 → 后端签发的 presigned PUT → R2 → 后端 finalize** | 可行；R2 支持 presigned PUT + PutBucketCors | **推荐**。大文件不过 Vercel；API Key 不出服务端；后端只做校验/适配/落库 |
| 浏览器直接 POST 后端域名（绕过 Next 代理） | 技术可行 | **不推荐**。后端所有路由要求 `X-API-Key`，浏览器不能持有；需要新增短期上传 token、CORS、CSRF、限流与流式落盘，安全面明显更大；仓库也没有现成模式 |
| 前端分片 → Next 代理逐片上传 | 可行 | **不推荐**。20MB 要 5–7 次函数调用，需拼装/重试/幂等，反而更慢更复杂，仍受单次 4.5MB 限制 |
| 前端压缩后再走代理 | 不可靠 | **不推荐**。HTML 内联 base64 图片压缩会损失画质/内容，无法覆盖 20MB 场景 |

**现状核实（2026-10-21）：**

- `frontend` 所有后端调用经 `app/api/backend/[...path]/route.ts`；`docs/REFERENCE.md:15` 明确“前端绝不直接连 PostgreSQL / 所有后端调用经 Next 代理”。
- 后端 CORS 只允许 `settings.frontend_url`（`backend/app/main.py:80-100`），且 `protected` 依赖要求 `X-API-Key`。
- `backend/app/services/r2_service.py` 只有 `generate_presigned_url(..., 'get_object')`（巡检截图 GET），没有 PUT；没有任何上传 token 机制。
- R2 官方文档：presigned URL 支持 `PUT`，但只能在 `<account>.r2.cloudflarestorage.com` S3 域使用，不能用于自定义域名；浏览器 PUT 必须在桶上配置 CORS（`AllowedMethods: ["PUT"]`、`AllowedHeaders: ["Content-Type"]`、`ExposeHeaders: ["ETag"]`）。

---

## File Structure

**Backend**

- Modify: `backend/app/models/crm.py` — 新增 `CrmProposalUploadSession`。
- Create: `backend/alembic/versions/20261021_284_crm_proposal_upload_sessions.py`
- Modify: `backend/app/schemas/crm.py` — 新增 init/finalize 请求与响应 schema。
- Modify: `backend/app/api/v1/endpoints/crm_proposals.py` — 新增 init / finalize 路由。
- Modify: `backend/app/services/crm/proposal_service.py` — 新增 `init_upload` / `finalize_upload`，复用现有 `_upload_version_objects` 的适配逻辑。
- Modify: `backend/app/services/r2_service.py` — 新增 `generate_presigned_put_url` 与 `_proposal_upload_bucket`。
- Create: `backend/scripts/configure_r2_cors.py` — 桶 CORS 配置（dry-run + apply）。
- Create: `backend/scripts/cleanup_proposal_upload_sessions.py` — 过期会话与临时对象清理。
- Modify: `backend/app/models/__init__.py`（如 CRM 模型统一导出）。
- Tests: `backend/tests/api/crm/test_proposal_upload_sessions.py`、`backend/tests/services/test_r2_presigned_put.py`、`backend/tests/scripts/test_cleanup_proposal_upload_sessions.py`。

**Frontend**

- Modify: `frontend/lib/crm/api/http-crm-client.ts` — `createProposal` / `addProposalVersion` 改为 init → PUT → finalize。
- Modify: `frontend/lib/crm/types/proposal.ts` — 新增 init/finalize DTO 类型。
- Modify: `frontend/lib/crm/constants/proposal.ts` — 直传上限 20MB，移除 4MB 代理模式分支。
- Modify: `frontend/components/crm/proposal/upload-form.tsx` — 文案/上限。
- Modify: `frontend/lib/crm/api/crm-client-provider.tsx` — 默认 `http`，生产禁止 `mock`。
- Modify: `frontend/playwright.config.ts` — 自包含 E2E 显式写入 `NEXT_PUBLIC_CRM_API_MODE=mock`。
- Tests: `frontend/lib/crm/api/http-crm-client.test.ts`、`frontend/components/crm/proposal/upload-form.test.tsx`、`frontend/lib/crm/constants/proposal.test.ts`、`frontend/lib/crm/api/crm-client-provider.test.tsx`。

---

## Task 0: 运行时去掉 Mock 默认（独立小改动）

**Files:**
- Modify: `frontend/lib/crm/api/crm-client-provider.tsx`
- Modify: `frontend/lib/crm/constants/proposal.ts`
- Modify: `frontend/playwright.config.ts`
- Test: `frontend/lib/crm/api/crm-client-provider.test.tsx`

**Interfaces:**
- Produces: `apiMode` 默认 `http`；生产构建下 `mock` 直接抛错；测试可用显式 `NEXT_PUBLIC_CRM_API_MODE=mock`。

- [ ] **Step 1: 写失败用例**

```tsx
// frontend/lib/crm/api/crm-client-provider.test.tsx
import { describe, expect, it, vi } from 'vitest'

describe('CRM client runtime mode', () => {
  it('未配置 NEXT_PUBLIC_CRM_API_MODE 时默认 http', async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    const mod = await import('./crm-client-provider')
    expect(mod.__crmApiMode).toBe('http')
  })

  it('生产环境显式 mock 时拒绝启动', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_API_MODE', 'mock')
    vi.stubEnv('NODE_ENV', 'production')
    vi.resetModules()
    await expect(import('./crm-client-provider')).rejects.toThrow(/mock/i)
  })
})
```

- [ ] **Step 2: 运行确认失败**

`cd frontend && pnpm vitest run lib/crm/api/crm-client-provider.test.tsx`

Expected: FAIL（默认仍为 mock / 生产不抛错）。

- [ ] **Step 3: 改实现**

```ts
// crm-client-provider.tsx
const apiMode = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'http'
if (apiMode !== 'http' && apiMode !== 'mock') {
  throw new Error(`Unknown NEXT_PUBLIC_CRM_API_MODE: ${apiMode}`)
}
if (process.env.NODE_ENV === 'production' && apiMode === 'mock') {
  throw new Error('CRM mock client is disabled in production')
}
```

`constants/proposal.ts` 同步：

```ts
export const CRM_API_MODE = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'http'
export const CRM_USES_REAL_BACKEND = CRM_API_MODE === 'http'
export const PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB = PROPOSAL_MAX_UPLOAD_MB // 直传后用 20MB
```

- [ ] **Step 4: 自包含 E2E 显式 opt-in mock**

在 `playwright.config.ts` 的 `runsSelfContainedSpec` 临时 `.env.local` 内容追加：

```ts
`NEXT_PUBLIC_CRM_API_MODE=mock\n`
```

其余 E2E 默认 `http`。`tests/dashboard/header-refresh-crm.spec.ts` 仍显式要求 http，不受影响。

- [ ] **Step 5: 跑测试**

`cd frontend && pnpm vitest run lib/crm/api/crm-client-provider.test.tsx lib/crm/constants/proposal.test.ts components/crm/proposal/upload-form.test.tsx`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/crm/api/crm-client-provider.tsx frontend/lib/crm/constants/proposal.ts frontend/playwright.config.ts frontend/lib/crm/api/crm-client-provider.test.tsx
git commit -m "fix(CRM): 运行时默认走 http 并禁止生产 mock"
```

---

## Task 1: R2 presigned PUT 与桶 CORS

**Files:**
- Modify: `backend/app/services/r2_service.py`
- Create: `backend/scripts/configure_r2_cors.py`
- Test: `backend/tests/services/test_r2_presigned_put.py`

**Interfaces:**
- Produces: `generate_presigned_put_url(settings, key, *, content_type: str, content_length: int, expires_in: int = 900) -> str`
- Produces: `proposal_upload_bucket(settings, key) -> str`（当前 main 用公开桶；#764 合入后走私有桶）
- Produces: `configure_r2_cors.py --bucket <name> --origin <origin> [--apply]`

- [ ] **Step 1: 写失败用例**

```python
# backend/tests/services/test_r2_presigned_put.py
from urllib.parse import parse_qs, urlparse

from app.core.config import Settings
from app.services.r2_service import generate_presigned_put_url


def _settings() -> Settings:
    return Settings(
        r2_endpoint_url="https://example.r2.cloudflarestorage.com",
        r2_access_key_id="key",
        r2_secret_access_key="secret",
        r2_bucket_name="believeboy-dash",
        r2_region="auto",
    )


def test_presigned_put_url_targets_single_key():
    url = generate_presigned_put_url(
        _settings(),
        "crm-proposals/_uploads/abc/raw.html",
        content_type="text/html",
        content_length=123,
        expires_in=900,
    )
    parsed = urlparse(url)
    assert parsed.hostname == "example.r2.cloudflarestorage.com"
    assert "crm-proposals/_uploads/abc/raw.html" in parsed.path
    params = parse_qs(parsed.query)
    assert params["X-Amz-Expires"] == ["900"]
    assert "X-Amz-Signature" in params
```

- [ ] **Step 2: 运行确认失败**

`cd backend && pytest tests/services/test_r2_presigned_put.py -q`

Expected: FAIL（函数不存在）。

- [ ] **Step 3: 实现**

```python
# backend/app/services/r2_service.py
def proposal_upload_bucket(settings: Settings, key: str) -> str:
    """方案上传对象的目标桶。

    当前 main 没有 #764 的私有桶字段；用 getattr 保持兼容。
    #764 合入后，crm-proposals/ 下的对象应走私有桶。
    """
    private = getattr(settings, "r2_private_bucket_resolved", "") or ""
    isolated = bool(getattr(settings, "r2_private_bucket_isolated", False))
    if isolated and private and key.startswith("crm-proposals/"):
        return private
    return settings.r2_bucket_name


def generate_presigned_put_url(
    settings: Settings,
    key: str,
    *,
    content_type: str,
    content_length: int,
    expires_in: int = 900,
) -> str:
    """签发单对象 PUT URL；签名包含 Content-Type / Content-Length。"""
    client = get_r2_client(settings)
    return client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": proposal_upload_bucket(settings, key),
            "Key": key,
            "ContentType": content_type,
            "ContentLength": content_length,
        },
        ExpiresIn=expires_in,
    )
```

> 若 R2 对签名中的 `ContentLength` 返回 `SignatureDoesNotMatch`，改为不签 `ContentLength`，并在 finalize 用 `head_object` 校验实际大小 ≤ 20MB。该验证在 Task 7 的真机集成测试中一次定死。

**#764 私有桶兼容（必须在合入顺序上处理）：** `proposal_upload_bucket()` 只负责“签发给哪个桶”；读写路径还依赖 #764 的 `is_private_key` / `bucket_candidates`。临时 key 是 `crm-proposals/_uploads/...`，不会被 #764 的 `crm-proposals/{数字}/v{数字}/...` 正则命中。因此若 #764 先合入，必须在它的 `PRIVATE_KEY_LAYOUTS`（或 `is_private_key`）中显式加入 `crm-proposals/_uploads/`；否则 presigned 写私有桶、finalize 却从公开桶读，表现为“对象找不到”。若 #764 尚未合入，当前 main 全部走公开桶，本计划仍可运行，但 key 必须保持 UUID 不可枚举。

- [ ] **Step 4: CORS 脚本**

```python
# backend/scripts/configure_r2_cors.py
"""给 R2 桶配置浏览器直传所需 CORS。默认 dry-run，--apply 才写。"""
import argparse
from app.core.config import get_settings
from app.services.r2_service import get_r2_client

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--origin", action="append", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    cors = {
        "CORSRules": [{
            "AllowedOrigins": args.origin,
            "AllowedMethods": ["PUT"],
            "AllowedHeaders": ["Content-Type"],
            "ExposeHeaders": ["ETag"],
            "MaxAgeSeconds": 3600,
        }]
    }
    print(cors)
    if not args.apply:
        return 0
    get_r2_client(get_settings()).put_bucket_cors(
        Bucket=args.bucket, CORSConfiguration=cors
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

生产/预览至少要包含：

```text
https://dashboard.believeboy.com
https://*.vercel.app
http://localhost:3200
```

- [ ] **Step 5: 跑测试**

`cd backend && pytest tests/services/test_r2_presigned_put.py -q`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/r2_service.py backend/scripts/configure_r2_cors.py backend/tests/services/test_r2_presigned_put.py
git commit -m "feat(R2): 新增方案直传 presigned PUT 与桶 CORS 配置"
```

---

## Task 2: 上传会话模型与迁移 284

**Files:**
- Modify: `backend/app/models/crm.py`
- Create: `backend/alembic/versions/20261021_284_crm_proposal_upload_sessions.py`
- Modify: `backend/app/models/__init__.py`（如需要）
- Test: `backend/tests/services/test_proposal_upload_session_model.py`

**Interfaces:**
- Produces: `CrmProposalUploadSession`，字段：
  - `id: str`（UUID，PK）
  - `owner_id: str | None`
  - `proposal_id: int | None`（追加版本时用）
  - `version_no: int | None`（追加版本时用）
  - `object_key: str`
  - `original_filename: str`
  - `expected_size: int`
  - `content_type: str`
  - `title: str | None`
  - `proposal_type: str | None`
  - `customer_id: int | None`
  - `change_note: str | None`
  - `status: str`（`pending` / `finalized` / `cancelled`）
  - `finalized_proposal_id: int | None`
  - `finalized_version_no: int | None`
  - `created_at` / `expires_at` / `finalized_at`

- [ ] **Step 1: 建迁移**

`cd backend && alembic heads` 确认只有 `283`，然后：

```bash
alembic revision --rev-id 284 -m "客户方案直传上传会话"
```

- [ ] **Step 2: 写 migration**

```python
# backend/alembic/versions/20261021_284_crm_proposal_upload_sessions.py
revision = "284"
down_revision = "283"

def upgrade() -> None:
    op.create_table(
        "crm_proposal_upload_sessions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column("proposal_id", sa.Integer(), nullable=True),
        sa.Column("version_no", sa.Integer(), nullable=True),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("expected_size", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("proposal_type", sa.String(length=32), nullable=True),
        sa.Column("customer_id", sa.Integer(), nullable=True),
        sa.Column("change_note", sa.String(length=500), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("finalized_proposal_id", sa.Integer(), nullable=True),
        sa.Column("finalized_version_no", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["proposal_id"], ["crm_proposals.id"], name="fk_cpus_proposal", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["customer_id"], ["crm_customers.id"], name="fk_cpus_customer", ondelete="SET NULL"),
    )
    op.create_index("idx_cpus_owner_status", "crm_proposal_upload_sessions", ["owner_id", "status"])
    op.create_index("idx_cpus_expires", "crm_proposal_upload_sessions", ["expires_at"])

def downgrade() -> None:
    op.drop_table("crm_proposal_upload_sessions")
```

- [ ] **Step 3: 模型**

在 `backend/app/models/crm.py` 增加 `CrmProposalUploadSession`，字段与迁移一一对应；`status` 用字符串常量类，取值至少 `pending` / `finalized` / `cancelled` / `expired`（清理脚本会把过期会话置 `expired`）。

- [ ] **Step 4: 跑迁移与检查**

```bash
cd backend && alembic upgrade head && python scripts/check_alembic.py
```

Expected: 单 head、无重复 id、检查通过。

- [ ] **Step 5: 模型测试**

```python
def test_upload_session_defaults(db):
    from app.models.crm import CrmProposalUploadSession
    s = CrmProposalUploadSession(
        id="u1", owner_id="user-1",
        object_key="crm-proposals/_uploads/u1/raw.html",
        original_filename="plan.html", expected_size=100,
        content_type="text/html", expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
    )
    db.add(s); db.commit(); db.refresh(s)
    assert s.status == "pending"
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/models/crm.py backend/app/models/__init__.py backend/alembic/versions/20261021_284_crm_proposal_upload_sessions.py backend/tests/services/test_proposal_upload_session_model.py
git commit -m "feat(CRM): 新增方案直传上传会话表"
```

---

## Task 3: 上传初始化端点

**Files:**
- Modify: `backend/app/schemas/crm.py`
- Modify: `backend/app/api/v1/endpoints/crm_proposals.py`
- Modify: `backend/app/services/crm/proposal_service.py`
- Test: `backend/tests/api/crm/test_proposal_upload_sessions.py`

**Interfaces:**
- Produces: `POST /api/v1/crm/proposals/uploads/init`
  - Request JSON: `{filename, size, content_type, title?, proposal_type?, customer_id?, change_note?}`
  - Response: `{upload_id, upload_url, method: "PUT", headers: {"Content-Type": "text/html"}, expires_in: 900}`
- Produces: `POST /api/v1/crm/proposals/{proposal_id}/versions/uploads/init`
  - 同上，但绑定已有方案与 `version_no = current_version_no + 1`。

- [ ] **Step 1: 失败用例**

```python
def test_init_upload_rejects_non_html(client, auth_headers):
    r = client.post("/api/v1/crm/proposals/uploads/init", headers=auth_headers, json={
        "filename": "plan.pdf", "size": 100, "content_type": "application/pdf",
    })
    assert r.status_code == 400

def test_init_upload_rejects_oversize(client, auth_headers):
    r = client.post("/api/v1/crm/proposals/uploads/init", headers=auth_headers, json={
        "filename": "plan.html", "size": 21 * 1024 * 1024, "content_type": "text/html",
    })
    assert r.status_code == 413

def test_init_upload_returns_scoped_url(client, auth_headers, db):
    r = client.post("/api/v1/crm/proposals/uploads/init", headers=auth_headers, json={
        "filename": "plan.html", "size": 1024, "content_type": "text/html",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["method"] == "PUT"
    assert f"crm-proposals/_uploads/{body['upload_id']}/raw.html" in body["upload_url"]
```

- [ ] **Step 2: 运行确认失败**

`cd backend && pytest tests/api/crm/test_proposal_upload_sessions.py -q`

- [ ] **Step 3: 实现 service**

```python
# proposal_service.init_upload
SESSION_TTL_MINUTES = 15
UPLOAD_PREFIX = "crm-proposals/_uploads"

def init_upload(db, *, file_name, size, content_type, title, proposal_type,
                customer_id, change_note, user_id, is_admin, settings, proposal=None):
    if size <= 0 or size > settings.crm_proposal_max_bytes:
        raise HTTPException(413, f"文件超过 {settings.crm_proposal_max_bytes} 字节上限")
    ext = Path(file_name).suffix.lower()
    if ext not in (".html", ".htm"):
        raise HTTPException(400, "不支持的文件类型：仅接受单个 HTML 文件（.html / .htm）")
    if proposal is not None:
        require_owner_or_admin(proposal.owner_id, user_id, is_admin)
        version_no = proposal.current_version_no + 1
    else:
        _assert_customer_visible(db, customer_id, user_id=user_id, is_admin=is_admin)
        version_no = None
    upload_id = str(uuid.uuid4())
    key = f"{UPLOAD_PREFIX}/{upload_id}/raw.html"
    session = CrmProposalUploadSession(
        id=upload_id, owner_id=(user_id or "").strip() or None,
        proposal_id=proposal.id if proposal else None,
        version_no=version_no, object_key=key,
        original_filename=file_name[:255], expected_size=size,
        content_type=content_type or "text/html",
        title=title, proposal_type=proposal_type, customer_id=customer_id,
        change_note=change_note, expires_at=datetime.now(timezone.utc) + timedelta(minutes=SESSION_TTL_MINUTES),
    )
    db.add(session)
    db.commit()
    url = generate_presigned_put_url(
        settings, key, content_type=session.content_type,
        content_length=size, expires_in=SESSION_TTL_MINUTES * 60,
    )
    return session, url
```

- [ ] **Step 4: 路由 + schema**

在 `crm_proposals.py` 加：

```python
@router.post("/uploads/init", response_model=ProposalUploadInitResponse)
def init_proposal_upload(payload: ProposalUploadInitRequest, db=Depends(get_primary_db_session), ...):
    session, url = proposal_service.init_upload(...)
    return ProposalUploadInitResponse(
        upload_id=session.id, upload_url=url, method="PUT",
        headers={"Content-Type": session.content_type},
        expires_in=proposal_service.SESSION_TTL_MINUTES * 60,
    )
```

注意路由顺序：`/uploads/init` 必须放在 `/{proposal_id}` 之前，避免被动态段吞掉。

- [ ] **Step 5: 测试**

`cd backend && pytest tests/api/crm/test_proposal_upload_sessions.py -q`

Expected: 3 passed。

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/crm.py backend/app/api/v1/endpoints/crm_proposals.py backend/app/services/crm/proposal_service.py backend/tests/api/crm/test_proposal_upload_sessions.py
git commit -m "feat(CRM): 新增方案直传上传初始化端点"
```

---

## Task 4: finalize 端点（校验 + 适配 + 落库）

**Files:**
- Modify: `backend/app/schemas/crm.py`
- Modify: `backend/app/api/v1/endpoints/crm_proposals.py`
- Modify: `backend/app/services/crm/proposal_service.py`
- Test: `backend/tests/api/crm/test_proposal_upload_sessions.py`

**Interfaces:**
- Produces: `POST /api/v1/crm/proposals/uploads/{upload_id}/finalize`
  - 成功：201 + `ProposalUploadResponse`
  - 过期/非本人/已取消：400/403/410
  - 对象缺失/大小不一致/非 HTML：422
  - 已 finalize：幂等返回首次结果

- [ ] **Step 1: 失败用例**

```python
def test_finalize_rejects_missing_object(client, auth_headers, upload_id):
    r = client.post(f"/api/v1/crm/proposals/uploads/{upload_id}/finalize", headers=auth_headers)
    assert r.status_code == 422

def test_finalize_creates_proposal_and_version(client, auth_headers, upload_id, r2_stub):
    r2_stub.put("crm-proposals/_uploads/{upload_id}/raw.html", b"<html>ok</html>")
    r = client.post(f"/api/v1/crm/proposals/uploads/{upload_id}/finalize", headers=auth_headers)
    assert r.status_code == 201
    body = r.json()
    assert body["proposal"]["currentVersionNo"] == 1
    assert body["version"]["versionNo"] == 1

def test_finalize_is_idempotent(client, auth_headers, upload_id, r2_stub):
    first = client.post(...); second = client.post(...)
    assert first.json()["proposal"]["id"] == second.json()["proposal"]["id"]
```

- [ ] **Step 2: 实现 finalize**

```python
def finalize_upload(db, *, upload_id, user_id, is_admin, settings):
    session = db.execute(
        select(CrmProposalUploadSession)
        .where(CrmProposalUploadSession.id == upload_id)
        .with_for_update()
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(404, "上传会话不存在")
    if session.owner_id not in (None, (user_id or "").strip() or None) and not is_admin:
        raise HTTPException(403, "Not the upload owner")
    if session.status == "finalized":
        return _load_finalized_result(db, session)
    if session.status != "pending":
        raise HTTPException(410, "上传会话已失效")
    if session.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(410, "上传会话已过期")

    head = get_r2_client(settings).head_object(
        Bucket=proposal_upload_bucket(settings, session.object_key),
        Key=session.object_key,
    )
    if int(head["ContentLength"]) != session.expected_size:
        raise HTTPException(422, "上传对象大小与声明不一致")
    raw_bytes = b"".join(iter_file_from_r2(settings, session.object_key))
    if len(raw_bytes) == 0 or len(raw_bytes) > settings.crm_proposal_max_bytes:
        raise HTTPException(422, "上传对象为空或超过上限")

    raw_text = _decode_html(raw_bytes)
    adapted_bytes = render.adapt_html(raw_text).encode("utf-8")

    if session.proposal_id is None:
        proposal = CrmProposal(...); db.add(proposal); db.flush()
        version_no = 1
    else:
        proposal = db.get(CrmProposal, session.proposal_id)
        require_owner_or_admin(proposal.owner_id, user_id, is_admin)
        version_no = proposal.current_version_no + 1

    raw_key, adapted_key = _upload_version_objects(
        settings=settings, proposal_id=proposal.id, version_no=version_no,
        raw_bytes=raw_bytes, adapted_bytes=adapted_bytes,
        raw_content_type=session.content_type,
    )
    version = CrmProposalVersion(...); db.add(version)
    proposal.current_version_no = version_no
    session.status = "finalized"
    session.finalized_proposal_id = proposal.id
    session.finalized_version_no = version_no
    session.finalized_at = datetime.now(timezone.utc)
    db.flush()
    try_delete_file_from_r2(settings, session.object_key)
    return proposal, version
```

端点负责 `audit_service.record_log` + `db.commit()`，与现有 `create_proposal` 完全一致。

- [ ] **Step 3: 测试**

`cd backend && pytest tests/api/crm/test_proposal_upload_sessions.py -q`

Expected: 全部 PASS（含权限、过期、大小、幂等）。

- [ ] **Step 4: Commit**

```bash
git add backend/app/schemas/crm.py backend/app/api/v1/endpoints/crm_proposals.py backend/app/services/crm/proposal_service.py backend/tests/api/crm/test_proposal_upload_sessions.py
git commit -m "feat(CRM): 方案直传 finalize 校验适配落库"
```

---

## Task 5: 过期会话清理

**Files:**
- Create: `backend/scripts/cleanup_proposal_upload_sessions.py`
- Test: `backend/tests/scripts/test_cleanup_proposal_upload_sessions.py`

- [ ] **Step 1: 失败用例**

```python
def test_cleanup_marks_expired_and_deletes_temp(db, r2_stub):
    # 造一条 expires_at < now 的 pending 会话 + 一个临时对象
    ...
    assert run(db, settings, r2_stub) == 1
    assert db.get(CrmProposalUploadSession, "u1").status == "expired"
    assert r2_stub.deleted == ["crm-proposals/_uploads/u1/raw.html"]
```

- [ ] **Step 2: 实现脚本**

```python
def run(db, settings, r2_client) -> int:
    now = datetime.now(timezone.utc)
    rows = db.execute(
        select(CrmProposalUploadSession).where(
            CrmProposalUploadSession.status == "pending",
            CrmProposalUploadSession.expires_at < now,
        )
    ).scalars().all()
    for row in rows:
        try_delete_file_from_r2(settings, row.object_key)
        row.status = "expired"
    db.commit()
    return len(rows)
```

- [ ] **Step 3: 挂到现有清理节奏**

在 `backend/scripts/cleanup_r2_orphaned_files.py` 的 cron/文档中加一行，或单独 cron：每 30 分钟跑一次。不要放进每次上传请求。

- [ ] **Step 4: 测试 + Commit**

```bash
cd backend && pytest tests/scripts/test_cleanup_proposal_upload_sessions.py -q
git add backend/scripts/cleanup_proposal_upload_sessions.py backend/tests/scripts/test_cleanup_proposal_upload_sessions.py
git commit -m "chore(CRM): 清理过期的方案直传会话"
```

---

## Task 6: 前端 HttpCrmClient 改三段式

**Files:**
- Modify: `frontend/lib/crm/api/http-crm-client.ts`
- Modify: `frontend/lib/crm/types/proposal.ts`
- Modify: `frontend/lib/crm/constants/proposal.ts`
- Test: `frontend/lib/crm/api/http-crm-client.test.ts`

**Interfaces:**
- `createProposal(input)` 保持签名不变；内部改为 init → R2 PUT → finalize。
- `addProposalVersion(id, input)` 同上。

- [ ] **Step 1: 失败用例**

```ts
it('createProposal 走 init → R2 PUT → finalize', async () => {
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/proposals/uploads/init')) {
      return new Response(JSON.stringify({
        upload_id: 'u1',
        upload_url: 'https://r2.example/crm-proposals/_uploads/u1/raw.html?X-Amz-Signature=x',
        method: 'PUT',
        headers: { 'Content-Type': 'text/html' },
        expires_in: 900,
      }), { status: 200 })
    }
    if (url.startsWith('https://r2.example/')) {
      return new Response(null, { status: 200 })
    }
    if (url.endsWith('/proposals/uploads/u1/finalize')) {
      return new Response(JSON.stringify({ proposal: { id: '1' }, version: { versionNo: 1 }, warnings: [] }), { status: 201 })
    }
    throw new Error(`unexpected ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const client = new HttpCrmClient()
  await client.createProposal({ file: new File(['<html></html>'], 'plan.html', { type: 'text/html' }) })

  expect(calls).toEqual([
    'POST /api/backend/v1/crm/proposals/uploads/init',
    'PUT https://r2.example/crm-proposals/_uploads/u1/raw.html?X-Amz-Signature=x',
    'POST /api/backend/v1/crm/proposals/uploads/u1/finalize',
  ])
})
```

- [ ] **Step 2: 实现**

```ts
async createProposal(input: ProposalCreateInput): Promise<ProposalUploadResult> {
  const init = await request<ProposalUploadInitDto>('/proposals/uploads/init', {
    method: 'POST',
    body: JSON.stringify({
      filename: input.file.name,
      size: input.file.size,
      content_type: input.file.type || 'text/html',
      title: input.title,
      proposal_type: input.proposalType,
      customer_id: input.customerId ?? null,
      change_note: input.changeNote,
    }),
  })
  const put = await fetch(init.upload_url, {
    method: 'PUT',
    headers: init.headers,
    body: input.file,
  })
  if (!put.ok) {
    throw new ApiError(put.status, `上传到 R2 失败（${put.status}）`)
  }
  return mapProposalUploadResult(
    await request<ProposalUploadResultDto>(`/proposals/uploads/${init.upload_id}/finalize`, { method: 'POST' })
  )
}
```

`addProposalVersion` 同理：init 路径 `/proposals/${id}/versions/uploads/init`，finalize 共用。

- [ ] **Step 3: 错误文案**

在 `proposalUploadError.ts` 增加：
- R2 PUT 403/过期 → “上传地址已过期，请重试”
- 网络/CORS → “上传到存储失败，请检查网络后重试”
- finalize 422 → 后端 detail 原文
- 20MB → 后端业务上限

- [ ] **Step 4: 测试 + Commit**

```bash
cd frontend && pnpm vitest run lib/crm/api/http-crm-client.test.ts lib/crm/constants/proposal.test.ts
git add frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/types/proposal.ts frontend/lib/crm/constants/proposal.ts frontend/lib/crm/api/http-crm-client.test.ts
git commit -m "feat(CRM): 方案上传改为 R2 直传三段式"
```

---

## Task 7: 全局验证（本地 + 真机 R2）

**Files:**
- Create: `docs/superpowers/plans/2026-10-21-crm-proposal-r2-direct-upload/test-report.md`（执行后写实测数字）

### 基线（已在本次会话实测，2026-10-21）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 前端 CRM 目标集 | `cd frontend && pnpm vitest run lib/crm app/dashboard/crm components/crm` | **50 files / 416 tests passed** |
| 后端 CRM 目标集 | `cd backend && pytest tests/api/crm tests/services/crm -q -p no:randomly` | **723 passed / 10 failed** |
| 后端失败集 | 同上 | 全部为测试库缺参考数据：`crm_categories` 无种子（9 条）、performance 排行无用户数据。与 PR #767 记录的既有基线同源，非代码回归 |

> 本机环境备注（不计入仓库）：`backend/.venv` 曾缺失、系统 Python 为 fastapi 0.115 / pydantic 2.7，与 `requirements.txt`（fastapi 0.139 / pydantic 2.12）不一致，会直接导致 CRM 测试收集失败（`PydanticUndefinedAnnotation: name 'CustomerCreate' is not defined`）。已用 `uv venv` + 清华镜像按锁定版本重建。**换机器先按 requirements.txt 建环境，否则基线不可信。**

- [ ] **Step 1: 后端目标集**

```bash
cd backend && pytest tests/api/crm tests/services/crm tests/services/test_r2_presigned_put.py tests/scripts/test_cleanup_proposal_upload_sessions.py -q
```

Expected: 0 failed。

- [ ] **Step 2: 后端全量（T3）**

```bash
cd backend && pytest -q
python scripts/check_alembic.py
```

Expected: 失败集与 main 对账一致；`check_alembic.py` 通过。

- [ ] **Step 3: 前端全量**

```bash
cd frontend && pnpm test && pnpm lint
```

Expected: 全绿；`check:mocks` 0 命中。

- [ ] **Step 4: 真机 20MB 链路**

本地起后端 + Next dev，配置真实 R2 测试桶 + CORS，分别上传：

| 文件大小 | 期望 |
| --- | --- |
| 1MB | 201，列表/详情/预览正常 |
| 4.9MB | 201（直传，不再 413） |
| 6MB | 201 |
| 20MB | 201 |
| 20MB + 1 字节 | 413（前端预校验/后端校验） |
| 非 HTML | 400/422 |
| 过期 presigned URL | 403，前端提示重试 |
| 取消/不 finalize | 30 分钟后会话过期，临时对象被清理 |

验证 SQL：

```sql
select id, title, current_version_no from crm_proposals order by id desc limit 5;
select proposal_id, version_no, raw_r2_key, adapted_r2_key from crm_proposal_versions order by id desc limit 5;
```

R2 检查：`head_object` 两份对象存在，大小与 `file_size` 一致；`GET` 预览/下载经后端流式返回。

- [ ] **Step 5: 浏览器 CORS 验证**

DevTools Network 应看到：

```text
POST /api/backend/v1/crm/proposals/uploads/init   200
PUT  https://<account>.r2.cloudflarestorage.com/... 200
POST /api/backend/v1/crm/proposals/uploads/<id>/finalize 201
```

若 PUT 失败：检查桶 CORS 是否包含当前 `Origin`、`Content-Type`、`PUT`。

- [ ] **Step 6: 生产灰度**

1. 先部署后端 + 迁移 284 + CORS 脚本（`--apply`）。
2. 再部署前端直传版本。
3. 生产上传 6MB 文件验证；失败则前端 feature flag 回退旧 multipart（≤4MB），后端保留旧端点。
4. 观察 24h：`crm_proposal_upload_sessions` 过期/失败数量、R2 临时对象残留。

- [ ] **Step 7: 报告**

把命令、真实数字、失败集对账写入 `test-report.md`，并附生产验证截图/日志。

---

## 自检

- [ ] 20MB 文件不再经过 Vercel 请求体；只有 init/finalize 两个小 JSON 经过代理。
- [ ] 浏览器不接触 API Key / R2 密钥；presigned URL 只指向单个 UUID key，TTL 15 分钟。
- [ ] 后端对对象做 HEAD 大小校验 + HTML 校验；客户端声明不可信。
- [ ] 新方案/追加版本都支持；旧 multipart 端点保留，可回退。
- [ ] 过期会话有清理；失败不会留下公开可下载的孤儿。
- [ ] #764 合入后临时/最终对象都走私有桶；未合入时 key 不可枚举。
- [ ] T3 全量、lint、迁移检查、真机 20MB 验证全部有真实输出。
