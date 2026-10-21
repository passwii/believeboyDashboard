# CRM 客户方案分段上传实施计划（不动 R2 桶）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CRM 方案支持最大 20MB 的单个 HTML：前端按 3MB 分段传到后端，后端落临时文件、合并后走**现有** `upload_bytes_to_r2` 写入 R2。**不改 R2 桶配置、不加 CORS、不加迁移、不动其他上传模块。**

**Architecture:** 只对 CRM 方案这一条链路做增量。≤4MB 仍走现有一次性 multipart（零改动、零回归）；>4MB 走 `init → 逐段上传 → finalize`。临时分段落在 `settings.upload_root/_crm_proposal_tmp/<upload_id>/`，finalize 合并、校验 HTML、适配主题、调用现有 R2 上传、落库。没有 presigned URL、没有新桶、没有新表。

**Tech Stack:** FastAPI / SQLAlchemy / 现有 `upload_bytes_to_r2` / 本地临时文件 / Next.js App Router / TypeScript / Vitest / pytest。

## Global Constraints

- 后端业务上限保持 `crm_proposal_max_bytes = 20 * 1024 * 1024`。
- 分段大小固定 **3MB**（`3 * 1024 * 1024`）：远低于 Vercel 函数 4.5MB 请求体上限，留足 multipart/头开销余量。
- **不改动**：R2 桶（公开/私有）、CORS、presigned、`r2_service` 的上传/下载语义、其他域上传端点、迁移链。
- 只新增 CRM 方案专属端点与临时目录；路由统一挂 `Depends(protected)`，沿用 `X-API-Key` + 会话头。
- 临时文件 TTL **2 小时**；过期由清理脚本/惰性清理删除，避免磁盘堆积。
- 所有分段写入必须按 `upload_id` 隔离；`upload_id` 为 `uuid4().hex`（32 位小写十六进制），禁止路径穿越。
- 运行时不再使用 Mock CRM 客户端；Mock 仅显式测试配置可用。
- 本改动不触发迁移，但涉及新上传契约，按 T3 跑后端全量 + 前端全量 + lint。
- commit 中文 + Conventional Commits；不得留 `TODO` / `FIXME` / `console.log` / `debugger`。

---

## 方案取舍（为什么分段而不是 presigned）

| 维度 | 分段上传（本计划） | presigned 直传（已废弃方案） |
| --- | --- | --- |
| R2 桶配置 | **完全不动** | 必须配桶 CORS（PUT + Content-Type + ETag） |
| 迁移 | **无** | 新增上传会话表 + 迁移 284 |
| 影响范围 | **仅 CRM 方案一条链路** | 新增 R2 直传基础设施，后续各域都要接 |
| 请求数 | 7 段（20MB / 3MB）+ init + finalize | 1 次 PUT + init + finalize |
| 后端临时存储 | 需要（`upload_root`，已有设施可复用） | 不需要（对象直接进 R2 临时 key） |
| 回滚 | 前端关掉 >4MB 分支即可回到现状 | 需回滚 CORS / 迁移 / 端点 |
| 主要风险 | 分段状态、临时文件清理、请求数多 | 改桶配置影响存量 1.4GB 内容 |

**结论：在你“不想动 R2 桶、担心全局影响”的前提下，分段上传是改动面最小的可行方案。**

---

## File Structure

**Backend**

- Create: `backend/app/services/crm/proposal_chunked_upload.py` — 临时目录、元数据、分段写入、合并、清理。
- Modify: `backend/app/api/v1/endpoints/crm_proposals.py` — 新增 `init` / `chunk` / `finalize` 路由。
- Modify: `backend/app/schemas/crm.py` — 新增 init / finalize 请求与响应 schema。
- Modify: `backend/app/services/crm/proposal_service.py` — 抽出 `create_proposal_from_bytes` / `add_version_from_bytes`，复用现有校验、适配、R2 上传与落库。
- Create: `backend/scripts/cleanup_crm_proposal_upload_temp.py` — 清理过期临时目录。
- Tests: `backend/tests/api/crm/test_proposal_chunked_upload.py`、`backend/tests/services/crm/test_proposal_chunked_upload.py`、`backend/tests/scripts/test_cleanup_crm_proposal_upload_temp.py`。

**Frontend**

- Modify: `frontend/lib/crm/api/http-crm-client.ts` — `createProposal` / `addProposalVersion` 增加 >4MB 分段分支。
- Modify: `frontend/lib/crm/types/proposal.ts` — 新增 init/finalize DTO。
- Modify: `frontend/lib/crm/constants/proposal.ts` — 直传分段阈值、分段大小、20MB 上限。
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.ts` — 分段/收尾路径纳入 60s 档。
- Modify: `frontend/components/crm/proposal/upload-form.tsx` — 文案改为 20MB。
- Modify: `frontend/lib/crm/api/crm-client-provider.tsx` — 默认 `http`，生产禁止 `mock`。
- Tests: `frontend/lib/crm/api/http-crm-client.chunked.test.ts`、`frontend/components/crm/proposal/upload-form.test.tsx`、`frontend/lib/crm/constants/proposal.test.ts`、`frontend/lib/crm/api/crm-client-provider.test.tsx`。

---

## Task 0: 运行时去掉 Mock 默认（独立小改动）

**Files:**
- Modify: `frontend/lib/crm/api/crm-client-provider.tsx`
- Modify: `frontend/lib/crm/constants/proposal.ts`
- Modify: `frontend/playwright.config.ts`
- Test: `frontend/lib/crm/api/crm-client-provider.test.tsx`

**Interfaces:**
- Produces: 未配置 `NEXT_PUBLIC_CRM_API_MODE` 时默认 `http`；生产构建显式 `mock` 直接抛错；自包含 E2E 显式写 `mock`。

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

`constants/proposal.ts` 同步默认：

```ts
export const CRM_API_MODE = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'http'
export const CRM_USES_REAL_BACKEND = CRM_API_MODE === 'http'
```

- [ ] **Step 4: 自包含 E2E 显式 opt-in mock**

在 `playwright.config.ts` 的 `runsSelfContainedSpec` 临时 `.env.local` 内容追加 `NEXT_PUBLIC_CRM_API_MODE=mock\n`；其余 E2E 默认 http。

- [ ] **Step 5: 跑测试 + Commit**

```bash
cd frontend && pnpm vitest run lib/crm/api/crm-client-provider.test.tsx lib/crm/constants/proposal.test.ts
git add frontend/lib/crm/api/crm-client-provider.tsx frontend/lib/crm/constants/proposal.ts frontend/playwright.config.ts frontend/lib/crm/api/crm-client-provider.test.tsx
git commit -m "fix(CRM): 运行时默认走 http 并禁止生产 mock"
```

---

## Task 1: 分段临时存储服务

**Files:**
- Create: `backend/app/services/crm/proposal_chunked_upload.py`
- Test: `backend/tests/services/crm/test_proposal_chunked_upload.py`

**Interfaces:**
- Produces:
  - `CHUNK_SIZE = 3 * 1024 * 1024`
  - `UPLOAD_TTL_SECONDS = 2 * 60 * 60`
  - `init_upload(settings, *, owner_id, filename, size, content_type, title, proposal_type, customer_id, change_note, proposal_id=None) -> dict`
  - `write_chunk(settings, upload_id, index, data, *, owner_id, is_admin=False) -> int`
  - `assemble(settings, upload_id, *, owner_id, is_admin=False) -> tuple[bytes, dict]`
  - `mark_finalized(settings, upload_id, *, proposal_id, version_no) -> None`
  - `cleanup_expired(settings, now=None) -> int`

- [ ] **Step 1: 失败用例**

```python
# backend/tests/services/crm/test_proposal_chunked_upload.py
import pytest
from app.services.crm import proposal_chunked_upload as up


def test_init_and_write_chunks(tmp_path, settings):
    settings.upload_root = tmp_path
    meta = up.init_upload(
        settings, owner_id="u1", filename="plan.html",
        size=7 * up.CHUNK_SIZE, content_type="text/html",
        title=None, proposal_type="other", customer_id=None, change_note=None,
    )
    assert meta["total_chunks"] == 7
    for i in range(7):
        size = up.write_chunk(settings, meta["upload_id"], i, b"x" * up.CHUNK_SIZE, owner_id="u1")
        assert size == up.CHUNK_SIZE
    data, meta2 = up.assemble(settings, meta["upload_id"], owner_id="u1")
    assert len(data) == 7 * up.CHUNK_SIZE
    assert meta2["status"] == "assembling"


def test_write_chunk_rejects_other_owner(tmp_path, settings):
    settings.upload_root = tmp_path
    meta = up.init_upload(...)
    with pytest.raises(PermissionError):
        up.write_chunk(settings, meta["upload_id"], 0, b"x", owner_id="intruder")
```

- [ ] **Step 2: 实现**

```python
# backend/app/services/crm/proposal_chunked_upload.py
from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException, status

CHUNK_SIZE = 3 * 1024 * 1024
UPLOAD_TTL_SECONDS = 2 * 60 * 60
_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_ROOT_NAME = "_crm_proposal_tmp"


def _root(settings) -> Path:
    root = settings.upload_root / _ROOT_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _dir(settings, upload_id: str) -> Path:
    if not _UPLOAD_ID_RE.match(upload_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "非法 upload_id")
    return _root(settings) / upload_id


def _meta_path(settings, upload_id: str) -> Path:
    return _dir(settings, upload_id) / "meta.json"


def _read_meta(settings, upload_id: str) -> dict:
    path = _meta_path(settings, upload_id)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "上传会话不存在或已过期")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_meta(settings, upload_id: str, meta: dict) -> None:
    path = _meta_path(settings, upload_id)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _assert_owner(meta: dict, owner_id: str | None, is_admin: bool) -> None:
    if is_admin:
        return
    if meta.get("owner_id") != (owner_id or "").strip() or not owner_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not the upload owner")


def init_upload(settings, *, owner_id, filename, size, content_type,
                title, proposal_type, customer_id, change_note, proposal_id=None) -> dict:
    if size <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件为空")
    if size > settings.crm_proposal_max_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "文件超过 20MB 上限")
    ext = Path(filename).suffix.lower()
    if ext not in (".html", ".htm"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "仅接受 .html / .htm")

    cleanup_expired(settings)
    upload_id = uuid.uuid4().hex
    upload_dir = _dir(settings, upload_id)
    upload_dir.mkdir(parents=True, exist_ok=False)

    total_chunks = (size + CHUNK_SIZE - 1) // CHUNK_SIZE
    now = datetime.now(timezone.utc)
    meta = {
        "upload_id": upload_id,
        "owner_id": (owner_id or "").strip() or None,
        "filename": filename[:255],
        "size": size,
        "content_type": content_type or "text/html",
        "title": title,
        "proposal_type": proposal_type,
        "customer_id": customer_id,
        "change_note": change_note,
        "proposal_id": proposal_id,
        "chunk_size": CHUNK_SIZE,
        "total_chunks": total_chunks,
        "status": "pending",
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=UPLOAD_TTL_SECONDS)).isoformat(),
        "proposal_id_final": None,
        "version_no": None,
    }
    _write_meta(settings, upload_id, meta)
    return meta


def write_chunk(settings, upload_id, index, data, *, owner_id, is_admin=False) -> int:
    meta = _read_meta(settings, upload_id)
    _assert_owner(meta, owner_id, is_admin)
    if meta["status"] != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "上传会话已结束")
    if index < 0 or index >= meta["total_chunks"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分段序号越界")
    if len(data) > CHUNK_SIZE:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "单个分段超过 3MB")
    expected = min(CHUNK_SIZE, meta["size"] - index * CHUNK_SIZE)
    if len(data) != expected:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分段大小与声明不一致")
    (_dir(settings, upload_id) / f"{index:05d}.part").write_bytes(data)
    return len(data)


def assemble(settings, upload_id, *, owner_id, is_admin=False) -> tuple[bytes, dict]:
    meta = _read_meta(settings, upload_id)
    _assert_owner(meta, owner_id, is_admin)
    if meta["status"] == "finalized":
        raise HTTPException(status.HTTP_409_CONFLICT, "该上传已收尾")
    if meta["status"] != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "上传会话状态异常")
    parts = sorted(_dir(settings, upload_id).glob("*.part"))
    if len(parts) != meta["total_chunks"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分段不完整")
    buf = bytearray()
    for part in parts:
        buf += part.read_bytes()
    if len(buf) != meta["size"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "合并后大小与声明不一致")
    meta["status"] = "assembling"
    _write_meta(settings, upload_id, meta)
    return bytes(buf), meta


def mark_finalized(settings, upload_id, *, proposal_id, version_no) -> None:
    meta = _read_meta(settings, upload_id)
    meta["status"] = "finalized"
    meta["proposal_id_final"] = proposal_id
    meta["version_no"] = version_no
    _write_meta(settings, upload_id, meta)
    for part in _dir(settings, upload_id).glob("*.part"):
        part.unlink(missing_ok=True)


def cleanup_expired(settings, now=None) -> int:
    now = now or datetime.now(timezone.utc)
    removed = 0
    root = _root(settings)
    for d in root.iterdir():
        if not d.is_dir() or not _UPLOAD_ID_RE.match(d.name):
            continue
        meta_file = d / "meta.json"
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
            expires = datetime.fromisoformat(meta["expires_at"]) if meta.get("expires_at") else None
        except Exception:
            expires = None
        if expires is None or expires <= now:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed
```

> `assemble` 在读取后把状态置 `assembling`；finalize 失败时保持该状态，重试由前端重新 init（避免半成品被重复 finalize）。成功由 `mark_finalized` 收尾。

- [ ] **Step 3: 跑测试 + Commit**

```bash
cd backend && pytest tests/services/crm/test_proposal_chunked_upload.py -q
git add backend/app/services/crm/proposal_chunked_upload.py backend/tests/services/crm/test_proposal_chunked_upload.py
git commit -m "feat(CRM): 新增方案分段上传临时存储"
```

---

## Task 2: init / chunk / finalize 端点

**Files:**
- Modify: `backend/app/schemas/crm.py`
- Modify: `backend/app/api/v1/endpoints/crm_proposals.py`
- Modify: `backend/app/services/crm/proposal_service.py`
- Test: `backend/tests/api/crm/test_proposal_chunked_upload.py`

**Interfaces:**
- `POST /api/v1/crm/proposals/uploads/init` → `{upload_id, chunk_size, total_chunks, expires_at}`
- `POST /api/v1/crm/proposals/{proposal_id}/versions/uploads/init` → 同上
- `POST /api/v1/crm/proposals/uploads/{upload_id}/chunks/{index}`（raw body）→ `{received, size}`
- `POST /api/v1/crm/proposals/uploads/{upload_id}/finalize` → `ProposalUploadResponse`

- [ ] **Step 1: 失败用例**

```python
def test_init_rejects_non_html(client, admin_headers):
    r = client.post("/api/v1/crm/proposals/uploads/init", headers=admin_headers, json={
        "filename": "x.pdf", "size": 100, "content_type": "application/pdf",
    })
    assert r.status_code == 400

def test_chunked_create_flow(client, admin_headers, monkeypatch):
    # 1) init
    init = client.post("/api/v1/crm/proposals/uploads/init", headers=admin_headers, json={
        "filename": "plan.html", "size": 5 * 1024 * 1024, "content_type": "text/html",
    }).json()
    # 2) 分两段（3MB + 2MB）
    body = b"<html>" + b"x" * (5 * 1024 * 1024 - 13) + b"</html>"
    for i in range(init["total_chunks"]):
        chunk = body[i * init["chunk_size"]:(i + 1) * init["chunk_size"]]
        r = client.post(
            f"/api/v1/crm/proposals/uploads/{init['upload_id']}/chunks/{i}",
            headers={**admin_headers, "Content-Type": "application/octet-stream"},
            content=chunk,
        )
        assert r.status_code == 200
    # 3) finalize
    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    assert r.status_code == 201
    assert r.json()["version"]["versionNo"] == 1
```

- [ ] **Step 2: 路由**

```python
@router.post("/uploads/init", response_model=ProposalChunkedUploadInitResponse)
def init_chunked_upload(payload: ProposalChunkedUploadInitRequest, ...):
    meta = proposal_chunked_upload.init_upload(...)
    return ProposalChunkedUploadInitResponse(
        upload_id=meta["upload_id"], chunk_size=meta["chunk_size"],
        total_chunks=meta["total_chunks"], expires_at=meta["expires_at"],
    )


@router.post("/uploads/{upload_id}/chunks/{index}")
async def upload_chunk(upload_id: str, index: int, request: Request, ...):
    data = await request.body()
    size = proposal_chunked_upload.write_chunk(
        settings, upload_id, index, data, owner_id=user_id, is_admin=is_admin
    )
    return {"received": index, "size": size}


@router.post("/uploads/{upload_id}/finalize", response_model=ProposalUploadResponse, status_code=201)
def finalize_chunked_upload(upload_id: str, ...):
    raw_bytes, meta = proposal_chunked_upload.assemble(...)
    item, version, warnings = proposal_service.create_proposal_from_bytes(
        db, raw_bytes=raw_bytes, filename=meta["filename"],
        content_type=meta["content_type"], title=meta["title"],
        proposal_type=meta["proposal_type"], customer_id=meta["customer_id"],
        user_id=user_id, is_admin=is_admin, settings=settings, commit=False,
    )
    audit_service.record_log(...)
    db.commit()
    proposal_chunked_upload.mark_finalized(
        settings, upload_id, proposal_id=item.id, version_no=version.version_no
    )
    return ProposalUploadResponse(proposal=item, version=version, warnings=warnings)
```

> 路由顺序：`/uploads/...` 必须放在 `/{proposal_id}` 动态段之前。

- [ ] **Step 3: 复用服务**

在 `proposal_service.py` 抽出：

```python
def create_proposal_from_bytes(db, *, raw_bytes, filename, content_type, title,
                               proposal_type, customer_id, user_id, is_admin,
                               settings, commit=False):
    _require_r2(settings)
    if proposal_type not in (...):
        raise HTTPException(400, "无效的方案类型")
    _assert_customer_visible(db, customer_id, user_id=user_id, is_admin=is_admin)
    ext, _ = render.validate_html_upload_from_bytes(
        raw_bytes, filename=filename, max_bytes=settings.crm_proposal_max_bytes
    )
    raw_text = _decode_html(raw_bytes)
    warnings = [...]
    adapted_bytes = render.adapt_html(raw_text).encode("utf-8")
    # 与现有 create_proposal 相同的 proposal/version 落库 + _upload_version_objects
```

`add_version_from_bytes` 同理，供 `/versions/uploads/init` + finalize 使用。

- [ ] **Step 4: 测试 + Commit**

```bash
cd backend && pytest tests/api/crm/test_proposal_chunked_upload.py -q
git add backend/app/schemas/crm.py backend/app/api/v1/endpoints/crm_proposals.py backend/app/services/crm/proposal_service.py backend/tests/api/crm/test_proposal_chunked_upload.py
git commit -m "feat(CRM): 方案分段上传 init/chunk/finalize 端点"
```

---

## Task 3: 过期临时目录清理

**Files:**
- Create: `backend/scripts/cleanup_crm_proposal_upload_temp.py`
- Test: `backend/tests/scripts/test_cleanup_crm_proposal_upload_temp.py`

- [ ] **Step 1: 实现脚本**

```python
"""清理过期的 CRM 方案分段上传临时目录。"""
import sys
from app.core.config import get_settings
from app.services.crm.proposal_chunked_upload import cleanup_expired

def main() -> int:
    removed = cleanup_expired(get_settings())
    print(f"removed {removed} expired upload dirs")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: 测试**

```python
def test_cleanup_removes_expired(tmp_path, settings):
    settings.upload_root = tmp_path
    meta = init_upload(settings, ..., )
    # 把 expires_at 改到过去
    ...
    assert cleanup_expired(settings) == 1
    assert not (tmp_path / "_crm_proposal_tmp" / meta["upload_id"]).exists()
```

- [ ] **Step 3: 挂清理节奏**

在 `backend/docs/multi-worker-ops.md` 或现有 cleanup cron 文档加一条：每小时跑一次；或由 `init_upload` 的惰性清理兜底（已实现）。

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/cleanup_crm_proposal_upload_temp.py backend/tests/scripts/test_cleanup_crm_proposal_upload_temp.py
git commit -m "chore(CRM): 清理过期的方案分段上传临时目录"
```

---

## Task 4: 前端分段上传（仅 >4MB）

**Files:**
- Modify: `frontend/lib/crm/api/http-crm-client.ts`
- Modify: `frontend/lib/crm/types/proposal.ts`
- Modify: `frontend/lib/crm/constants/proposal.ts`
- Test: `frontend/lib/crm/api/http-crm-client.chunked.test.ts`

**Interfaces:**
- `createProposal(input)` / `addProposalVersion(id, input)` 签名不变。
- ≤4MB：走现有 `requestForm`，行为完全不变。
- >4MB：`init → 逐段 raw POST → finalize`。

- [ ] **Step 1: 失败用例**

```ts
it('>4MB 文件走 init → 分段 → finalize', async () => {
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/proposals/uploads/init')) {
      return new Response(JSON.stringify({
        upload_id: 'a'.repeat(32), chunk_size: 3 * 1024 * 1024,
        total_chunks: 2, expires_at: '2026-10-21T00:00:00Z',
      }), { status: 200 })
    }
    if (url.includes('/chunks/')) return new Response('{}', { status: 200 })
    if (url.endsWith('/finalize')) {
      return new Response(JSON.stringify({ proposal: { id: '1' }, version: { versionNo: 1 }, warnings: [] }), { status: 201 })
    }
    throw new Error(`unexpected ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const file = new File([new Uint8Array(5 * 1024 * 1024)], 'big.html', { type: 'text/html' })
  await new HttpCrmClient().createProposal({ file })

  expect(calls.filter(c => c.includes('/chunks/'))).toHaveLength(2)
  expect(calls.at(-1)).toContain('/finalize')
})
```

- [ ] **Step 2: 实现**

```ts
const CHUNK_THRESHOLD = 4 * 1024 * 1024

async createProposal(input: ProposalCreateInput): Promise<ProposalUploadResult> {
  if (input.file.size <= CHUNK_THRESHOLD) {
    return this.createProposalLegacy(input)
  }
  const init = await request<ChunkInitDto>('/proposals/uploads/init', {
    method: 'POST',
    body: JSON.stringify({
      filename: input.file.name, size: input.file.size,
      content_type: input.file.type || 'text/html',
      title: input.title, proposal_type: input.proposalType,
      customer_id: input.customerId ?? null, change_note: input.changeNote,
    }),
  })
  for (let i = 0; i < init.total_chunks; i++) {
    const chunk = input.file.slice(i * init.chunk_size, (i + 1) * init.chunk_size)
    await uploadChunkWithRetry(init.upload_id, i, chunk)
  }
  return mapProposalUploadResult(
    await request<ProposalUploadResultDto>(
      `/proposals/uploads/${init.upload_id}/finalize`, { method: 'POST' }
    )
  )
}
```

`uploadChunkWithRetry`：

```ts
async function uploadChunkWithRetry(uploadId: string, index: number, chunk: Blob) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/proposals/uploads/${uploadId}/chunks/${index}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      })
      if (res.ok) return
      if (res.status < 500) throw await parseApiError(res, `分段上传失败（${res.status}）`)
      lastError = new ApiError(res.status, `分段上传失败（${res.status}）`)
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
  }
  throw lastError
}
```

- [ ] **Step 3: 上限常量**

```ts
export const PROPOSAL_MAX_UPLOAD_MB = 20
export const PROPOSAL_CHUNK_THRESHOLD_MB = 4
export const PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB = PROPOSAL_MAX_UPLOAD_MB
```

`upload-form.tsx` 文案改为 20MB；≤4MB 走旧路径、>4MB 自动分段，用户无感。

- [ ] **Step 4: 测试 + Commit**

```bash
cd frontend && pnpm vitest run lib/crm/api/http-crm-client.chunked.test.ts lib/crm/constants/proposal.test.ts components/crm/proposal/upload-form.test.tsx
git add frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/types/proposal.ts frontend/lib/crm/constants/proposal.ts frontend/components/crm/proposal/upload-form.tsx frontend/lib/crm/api/http-crm-client.chunked.test.ts
git commit -m "feat(CRM): 方案上传超过 4MB 自动分段"
```

---

## Task 5: 代理超时档 + 全局验证

**Files:**
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.ts`
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.test.ts`
- Create: `docs/superpowers/plans/2026-10-21-crm-proposal-chunked-upload/test-report.md`

- [ ] **Step 1: 扩超时档**

```ts
const CRM_PROPOSAL_UPLOAD_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/crm\/proposals(?:\/[^/]+\/versions)?$/,
  /\/crm\/proposals\/uploads\/init$/,
  /\/crm\/proposals\/uploads\/[0-9a-f]{32}\/chunks\/\d+$/,
  /\/crm\/proposals\/uploads\/[0-9a-f]{32}\/finalize$/,
  /\/crm\/proposals\/[^/]+\/versions\/uploads\/init$/,
]
```

- [ ] **Step 2: 断言**

```ts
expect(getProxyTimeoutMs('api/v1/crm/proposals/uploads/init', null, 'POST')).toBe(60_000)
expect(getProxyTimeoutMs(`api/v1/crm/proposals/uploads/${'a'.repeat(32)}/chunks/3`, null, 'POST')).toBe(60_000)
```

- [ ] **Step 3: 后端目标集**

```bash
cd backend && pytest tests/api/crm tests/services/crm tests/services/crm/test_proposal_chunked_upload.py -q -p no:randomly
```

Expected: 与基线失败集一致（10 个参考数据失败），新增用例全绿。

- [ ] **Step 4: 前端全量**

```bash
cd frontend && pnpm test && pnpm lint
```

Expected: 274 文件 / 2124+ 用例全绿；lint 0 errors。

- [ ] **Step 5: 真机 20MB（R2 不变）**

本地起后端 + Next dev，确认：

| 文件大小 | 路径 | 期望 |
| --- | --- | --- |
| 1MB | 旧的 multipart | 201 |
| 4MB | 旧的 multipart | 201 |
| 4.1MB | 分段（2 段） | 201 |
| 6MB | 分段（2 段） | 201 |
| 20MB | 分段（7 段） | 201 |
| 20MB + 1 字节 | 前端拦截 | 提示 20MB 上限 |
| 非 HTML | init 拦截 | 400 |
| 少传一段 | finalize 拦截 | 400 |
| 过期 >2h | finalize 拦截 | 404/410 |

验证 SQL 与 R2：

```sql
select id, title, current_version_no from crm_proposals order by id desc limit 5;
select proposal_id, version_no, raw_r2_key, adapted_r2_key, file_size from crm_proposal_versions order by id desc limit 5;
```

R2 桶配置、CORS、其他上传端点**均未改动**；只需确认两份对象存在、大小与 `file_size` 一致、预览/下载正常。

- [ ] **Step 6: 回滚演练**

- 前端把 `CHUNK_THRESHOLD` 临时调回 20MB（即始终走旧路径）→ 5MB 上传恢复失败，证明未影响旧链路。
- 删除 `_crm_proposal_tmp` 临时目录 → 旧链路不受影响。

- [ ] **Step 7: 报告**

把命令、真实数字、失败集对账写入 `test-report.md`。

---

## 自检

- [ ] R2 桶 / CORS / 迁移 / 其他上传端点零改动。
- [ ] ≤4MB 走旧路径，行为与现状完全一致；>4MB 自动分段。
- [ ] 单段 3MB < Vercel 4.5MB；20MB 最多 7 段。
- [ ] 临时目录按 upload_id 隔离、owner 校验、TTL 清理；finalize 校验分段完整与总大小。
- [ ] 失败可重试：分段幂等覆盖；finalize 失败不产生半截方案（DB 事务回滚）。
- [ ] 前端全量 274 文件 / 2124+ 用例全绿；后端新增用例全绿，失败集与基线一致。
- [ ] 真机 4.1MB / 6MB / 20MB 全部 201。
