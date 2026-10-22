"""客户方案端点集成测试：上传 / 适配 / 版本 / 权限 / 下载 / 审计。

R2 I/O 全部 mock（不上真桶）：上传写进进程内 dict，下载/预览从 dict 读回，
保证断言与「冻结产物」一致。
"""

from __future__ import annotations

import io
from unittest.mock import PropertyMock, patch
from urllib.parse import unquote

import pytest
from sqlalchemy import text

from app.core.config import Settings, get_settings

# ---------- R2 假实现 ----------

_FAKE_BUCKET: dict[str, bytes] = {}


def _fake_upload(settings, data, filename, project_slug, file_type, content_type="application/octet-stream"):
    key = f"{project_slug}/{file_type}/{filename}"
    _FAKE_BUCKET[key] = bytes(data)
    return {"key": key, "url": f"https://fake.r2/{key}", "bucket": "fake", "size": len(data)}


def _fake_iter(settings, key, chunk_size=1024 * 1024):
    data = _FAKE_BUCKET.get(key, b"")
    for i in range(0, len(data), chunk_size):
        yield data[i : i + chunk_size]


def _fake_delete(settings, key, log_failure=True):
    from app.services.r2_service import R2DeleteResult

    _FAKE_BUCKET.pop(key, None)
    return R2DeleteResult(success=True, key=key or "")


@pytest.fixture(autouse=True)
def mock_r2():
    _FAKE_BUCKET.clear()
    with patch(
        "app.services.crm.proposal_service.upload_bytes_to_r2",
        side_effect=_fake_upload,
    ), patch(
        "app.services.crm.proposal_service.iter_file_from_r2",
        side_effect=_fake_iter,
    ), patch(
        "app.services.crm.proposal_service.try_delete_file_from_r2",
        side_effect=_fake_delete,
    ), patch.object(
        type(get_settings()),
        "r2_enabled",
        new_callable=PropertyMock,
        return_value=True,
    ):
        yield


@pytest.fixture(autouse=True)
def mock_r2_private_bucket():
    """隔离私有桶（BLF-1418 / PR #764 的 fail-closed 前置）。

    #764 落地后，方案写入要求**隔离的私有桶**（未配置 → ``create_proposal`` /
    ``add_version`` 直接 503）→ 本文件的用例全部依赖上传夹具，若不带这层
    隔离配置，#764 合入后**本文件整体会红**。

    这里刻意写成**独立 fixture**（而不是塞进上面的 ``mock_r2``）：

    - 合并顺序无关：无论 #764 先合还是本 PR 先合，测试都绿；
    - 冲突面为 0：#764 改的是 ``mock_r2`` 的 ``with`` 块内部，本 fixture 是
      **追加**在其后的一段，两边不碰同一行 → rebase 无冲突、不断言。

    ``create=True`` 是关键：#764 合入前 ``Settings`` 上还没有这两个属性，
    不加 ``create=True`` 会在本 PR 单独跑时直接抛 ``AttributeError``；
    #764 合入后它们变成真属性，patch 语义不变。
    """
    with patch.object(
        type(get_settings()),
        "r2_private_bucket_isolated",
        new_callable=PropertyMock,
        return_value=True,
        create=True,
    ), patch.object(
        type(get_settings()),
        "r2_private_bucket_resolved",
        new_callable=PropertyMock,
        return_value="fake-private",
        create=True,
    ):
        yield


# ---------- helpers ----------

_HTML = (
    "<html><head><title>提案</title></head>"
    "<body><h1>方案正文</h1><link href=\"./x.css\"></body></html>"
)

# 最小 PDF 头尾（后端不解析 PDF，只做扩展名 / 大小 / 非空校验）
_PDF = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n"


def _upload(content: bytes | str, filename: str = "plan.html", content_type: str = "text/html"):
    if isinstance(content, str):
        content = content.encode("utf-8")
    return {"file": (filename, io.BytesIO(content), content_type)}


def _mk_customer(client, headers, name="客户A"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_proposal(
    client,
    headers,
    *,
    content=_HTML,
    title="客户方案A",
    filename="plan.html",
    content_type="text/html",
    **form,
):
    r = client.post(
        "/api/v1/crm/proposals",
        headers=headers,
        files=_upload(content, filename, content_type),
        data={"title": title, **form},
    )
    assert r.status_code == 201, r.text
    return r.json()


# ---------- 鉴权 ----------


def test_requires_auth(client):
    assert client.get("/api/v1/crm/proposals").status_code in (401, 403)
    assert client.post("/api/v1/crm/proposals").status_code in (401, 403)


# ---------- 新建（首版） ----------


def test_create_defaults_owner_and_version(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    assert body["proposal"]["title"] == "客户方案A"
    assert body["proposal"]["owner_id"] == operator_headers["X-User-Id"]
    assert body["proposal"]["status"] == "draft"
    assert body["proposal"]["proposal_type"] == "other"
    assert body["proposal"]["current_version_no"] == 1
    assert body["proposal"]["version_count"] == 1
    assert body["version"]["version_no"] == 1
    assert body["version"]["original_filename"] == "plan.html"
    assert body["version"]["change_note"] == "初始版本"


def test_create_with_customer_binds_and_returns_name(client, operator_headers):
    cust = _mk_customer(client, operator_headers)
    body = _mk_proposal(client, operator_headers, customer_id=cust["id"])
    assert body["proposal"]["customer_id"] == cust["id"]
    assert body["proposal"]["customer_name"] == "客户A"


def test_create_rejects_non_html(client, operator_headers):
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(b"# hi", "a.md", "text/markdown"),
    )
    assert r.status_code == 400
    assert "HTML" in r.json()["detail"]


def test_create_rejects_empty(client, operator_headers):
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(b"", "a.html"),
    )
    assert r.status_code == 400


def test_create_rejects_oversize(client, operator_headers, monkeypatch):
    monkeypatch.setattr(get_settings(), "crm_proposal_max_bytes", 1024, raising=False)
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(b"x" * 4096, "a.html"),
    )
    assert r.status_code == 413


# ---------- 上传体积上限（BLF-1405：5MB → 20MB 放宽的验收证据） ----------

# 旧的 5MB 上限（#753 之前）。放宽到 20MB 后，这个尺寸必须能建方案成功。
_FORMER_LIMIT_BYTES = 5 * 1024 * 1024
# 新的 20MB 上限（#753 之后）。见 app/core/config.py 的 crm_proposal_max_bytes。
_CURRENT_LIMIT_BYTES = 20 * 1024 * 1024
# 取一个 > 旧上限、< 新上限的尺寸：6MB。
_OVER_FORMER_LIMIT_BYTES = 6 * 1024 * 1024


def _big_html(size: int) -> bytes:
    """构造指定字节数的单个 .html（内存态，不落盘）。

    体积用重复字节填充，但开头补一段真实 HTML 骨架 —— 后端会把它当 HTML
    解析（找相对引用 / 注入主题样式），纯字节流虽不报错但语义不真实。
    """
    head = (
        '<html><head><meta charset="utf-8"><title>大方案</title></head>'
        "<body><h1>大方案正文</h1>"
    ).encode("utf-8")
    tail = "</body></html>".encode("utf-8")
    filler = b"x" * (size - len(head) - len(tail))
    return head + filler + tail


def test_create_accepts_payload_over_former_5mb_limit(
    client, operator_headers, monkeypatch
):
    """6MB 的 HTML 现在必须能建方案成功（201，而不是 413）。

    这是 #753（5MB → 20MB）在测试层面的**端到端证据**：没有这条用例，
    上限是否真的放宽无法从测试结果判定。
    """
    # 把上限显式钉在 20MB：本用例要验的是「业务代码按 20MB 放行 6MB」，
    # 不能被 .env / 进程环境里的合法部署覆盖（CRM_PROPOSAL_MAX_BYTES）改写，
    # 否则「部署配置变了」和「上传链路坏了」会共用同一个红信号。
    monkeypatch.setattr(
        get_settings(), "crm_proposal_max_bytes", _CURRENT_LIMIT_BYTES, raising=False
    )
    payload = _big_html(_OVER_FORMER_LIMIT_BYTES)
    assert len(payload) > _FORMER_LIMIT_BYTES
    assert len(payload) < _CURRENT_LIMIT_BYTES

    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(payload, "big.html"),
        data={"title": "6MB 方案"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # 版本上记录的体积 = 原始上传字节数（不含 multipart 包装）。
    assert body["version"]["file_size"] == len(payload)
    assert body["version"]["original_filename"] == "big.html"


def test_create_accepts_payload_near_current_20mb_limit(
    client, operator_headers, monkeypatch
):
    """贴着新上限（20MB - 余量）的 HTML 也要能建方案成功。"""
    # 同上：钉住 20MB，避免部署覆盖把这条用例变成「配置值断言」。
    monkeypatch.setattr(
        get_settings(), "crm_proposal_max_bytes", _CURRENT_LIMIT_BYTES, raising=False
    )
    payload = _big_html(_CURRENT_LIMIT_BYTES - 1024)
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(payload, "huge.html"),
        data={"title": "20MB 方案"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["version"]["file_size"] == len(payload)


def test_create_rejects_payload_over_current_limit(
    client, operator_headers, monkeypatch
):
    """超过新上限 → 413（用 monkeypatch 缩小上限，不真传 20MB+）。"""
    monkeypatch.setattr(get_settings(), "crm_proposal_max_bytes", 1024, raising=False)
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(_big_html(4096), "a.html"),
    )
    assert r.status_code == 413
    assert "上限" in r.json()["detail"]


def test_create_limit_is_20mb_by_default(client, operator_headers):
    """**声明式默认**上限就是 20MB（防止有人把配置改回 5MB 而测试无感）。

    读 ``Settings.model_fields`` 的声明式默认值，而不是运行时 ``get_settings()``：
    后者会吃 ``backend/.env`` 与进程环境（``CRM_PROPOSAL_MAX_BYTES``），
    任何一次合法的部署覆盖都会让本用例误报。
    """
    assert (
        Settings.model_fields["crm_proposal_max_bytes"].default == _CURRENT_LIMIT_BYTES
    )


def test_add_version_accepts_payload_over_former_5mb_limit(
    client, operator_headers, monkeypatch
):
    """追加版本走同一个开关：6MB 的新版本也要能成功。"""
    # 同上：钉住 20MB，让本用例只守「追加版本路径按上限放行」这一件事。
    monkeypatch.setattr(
        get_settings(), "crm_proposal_max_bytes", _CURRENT_LIMIT_BYTES, raising=False
    )
    created = _mk_proposal(client, operator_headers)
    pid = created["proposal"]["id"]
    payload = _big_html(_OVER_FORMER_LIMIT_BYTES)

    r = client.post(
        f"/api/v1/crm/proposals/{pid}/versions",
        headers=operator_headers,
        files=_upload(payload, "big-v2.html"),
        data={"change_note": "大版本"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["version"]["version_no"] == 2
    assert body["version"]["file_size"] == len(payload)


def test_create_warns_on_relative_refs(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    assert any("./x.css" in w for w in body["warnings"])


def test_create_unknown_customer_404(client, operator_headers):
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(_HTML),
        data={"title": "x", "customer_id": "999999"},
    )
    assert r.status_code == 404


def test_create_foreign_customer_forbidden_for_non_admin(
    client, operator_headers, admin_headers
):
    cust = _mk_customer(client, admin_headers, name="管理员客户")
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(_HTML),
        data={"title": "x", "customer_id": str(cust["id"])},
    )
    assert r.status_code == 403


def test_create_invalid_type_400(client, operator_headers):
    r = client.post(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        files=_upload(_HTML),
        data={"title": "x", "proposal_type": "bogus"},
    )
    assert r.status_code == 400


# ---------- 方案类型枚举（BLF-1406：新增 research / 调研方案） ----------


def test_create_research_type_201(client, operator_headers):
    """新建「调研方案」→ 201，且回显 proposal_type == "research"。"""
    body = _mk_proposal(
        client, operator_headers, title="调研方案A", proposal_type="research"
    )
    assert body["proposal"]["proposal_type"] == "research"


@pytest.mark.parametrize(
    "proposal_type",
    ["onboarding", "operation", "quotation", "research", "other"],
)
def test_create_all_valid_types_201(client, operator_headers, proposal_type):
    """5 个合法类型（含新增 research）都放行。"""
    body = _mk_proposal(
        client,
        operator_headers,
        title=f"方案-{proposal_type}",
        proposal_type=proposal_type,
    )
    assert body["proposal"]["proposal_type"] == proposal_type


def test_update_to_research_type_200(client, operator_headers):
    """PATCH 改成 research → 200（ProposalUpdate.proposal_type 的 Literal 放行）。"""
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    r = client.patch(
        f"/api/v1/crm/proposals/{pid}",
        headers=operator_headers,
        json={"proposal_type": "research"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["proposal_type"] == "research"


def test_update_to_invalid_type_422(client, operator_headers):
    """PATCH 成非法类型 → 422（schema Literal 拦截，不是 500）。"""
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    r = client.patch(
        f"/api/v1/crm/proposals/{pid}",
        headers=operator_headers,
        json={"proposal_type": "bogus"},
    )
    assert r.status_code == 422, r.text


# ---------- 版本 ----------


def test_add_version_appends_and_moves_pointer(client, operator_headers):
    created = _mk_proposal(client, operator_headers)
    pid = created["proposal"]["id"]

    r = client.post(
        f"/api/v1/crm/proposals/{pid}/versions",
        headers=operator_headers,
        files=_upload("<html><body>v2</body></html>"),
        data={"change_note": "补充报价"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["version"]["version_no"] == 2
    assert body["version"]["change_note"] == "补充报价"
    assert body["proposal"]["current_version_no"] == 2
    assert body["proposal"]["version_count"] == 2

    detail = client.get(f"/api/v1/crm/proposals/{pid}", headers=operator_headers).json()
    assert [v["version_no"] for v in detail["versions"]] == [2, 1]


def test_version_numbers_are_per_proposal(client, operator_headers):
    a = _mk_proposal(client, operator_headers, title="A")
    b = _mk_proposal(client, operator_headers, title="B")
    client.post(
        f"/api/v1/crm/proposals/{a['proposal']['id']}/versions",
        headers=operator_headers,
        files=_upload("<html></html>"),
    )
    # B 仍是 v1，不受 A 的 v2 影响
    detail_b = client.get(
        f"/api/v1/crm/proposals/{b['proposal']['id']}", headers=operator_headers
    ).json()
    assert detail_b["current_version_no"] == 1
    assert [v["version_no"] for v in detail_b["versions"]] == [1]


def test_add_version_missing_proposal_404(client, operator_headers):
    r = client.post(
        "/api/v1/crm/proposals/999999/versions",
        headers=operator_headers,
        files=_upload("<html></html>"),
    )
    assert r.status_code == 404


# ---------- 预览 / 下载 ----------


def test_content_is_adapted(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/content", headers=operator_headers
    )
    assert res.status_code == 200, res.text
    payload = res.json()
    assert "bb-proposal-theme" in payload["content"]
    assert payload["version_no"] == 1
    assert payload["title"] == "客户方案A"


def test_content_raw_keeps_original(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/content?raw=true",
        headers=operator_headers,
    )
    assert res.status_code == 200
    assert "bb-proposal-theme" not in res.json()["content"]
    assert "方案正文" in res.json()["content"]


def test_content_missing_version_404(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/9/content", headers=operator_headers
    )
    assert res.status_code == 404


def test_download_adapted_single_html(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download", headers=operator_headers
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    disp = res.headers["content-disposition"]
    assert "attachment" in disp
    assert unquote(disp.split("filename*=UTF-8''")[1]) == "客户方案A-v1.html"
    assert "bb-proposal-theme" in res.text


def test_download_raw(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download?raw=true",
        headers=operator_headers,
    )
    assert res.status_code == 200
    assert unquote(res.headers["content-disposition"].split("filename*=UTF-8''")[1]) == (
        "客户方案A-v1-原始.html"
    )
    assert "bb-proposal-theme" not in res.text


# ---------- PDF 载荷（直存 / 预览 / 下载） ----------


def test_create_pdf_skips_adaptation_and_stores_one_object(client, operator_headers):
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/pdf",
        title="PDF 方案",
    )
    version = body["version"]
    assert version["original_filename"] == "quote.pdf"
    assert version["content_type"] == "application/pdf"
    assert version["file_size"] == len(_PDF)
    # PDF 不做相对引用提示（HTML 才解析）
    assert body["warnings"] == []

    keys = [k for k in _FAKE_BUCKET if k.startswith("crm-proposals/")]
    assert len(keys) == 1
    assert keys[0].endswith("/raw.pdf")


def test_create_pdf_normalizes_octet_stream_mime(client, operator_headers):
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/octet-stream",
    )
    assert body["version"]["content_type"] == "application/pdf"


def test_pdf_detail_exposes_mime_for_frontend_detection(client, operator_headers):
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/pdf",
    )
    pid = body["proposal"]["id"]
    detail = client.get(f"/api/v1/crm/proposals/{pid}", headers=operator_headers)
    assert detail.status_code == 200
    row = detail.json()["versions"][0]
    assert row["original_filename"] == "quote.pdf"
    assert row["content_type"] == "application/pdf"


def test_download_pdf_returns_pdf_media_type_and_suffix(client, operator_headers):
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/pdf",
        title="PDF 方案",
    )
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download", headers=operator_headers
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    disp = res.headers["content-disposition"]
    assert unquote(disp.split("filename*=UTF-8''")[1]) == "PDF 方案-v1.pdf"
    assert res.content == _PDF


def test_download_pdf_ignores_raw_flag(client, operator_headers):
    """PDF 没有适配产物：前端预览复用此端点，raw 不应改变字节 / 文件名。"""
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/pdf",
        title="PDF 方案",
    )
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download?raw=true",
        headers=operator_headers,
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert unquote(res.headers["content-disposition"].split("filename*=UTF-8''")[1]) == (
        "PDF 方案-v1.pdf"
    )
    assert res.content == _PDF


def test_content_rejects_pdf_with_415(client, operator_headers):
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/pdf",
    )
    pid = body["proposal"]["id"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/content", headers=operator_headers
    )
    assert res.status_code == 415
    assert "PDF" in res.json()["detail"]


def test_add_pdf_version_mixes_formats_per_version(client, operator_headers):
    body = _mk_proposal(client, operator_headers)  # v1 = HTML
    pid = body["proposal"]["id"]

    r = client.post(
        f"/api/v1/crm/proposals/{pid}/versions",
        headers=operator_headers,
        files=_upload(_PDF, "v2.pdf", "application/pdf"),
        data={"change_note": "改 PDF"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["version"]["version_no"] == 2
    assert r.json()["version"]["content_type"] == "application/pdf"

    v1 = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download", headers=operator_headers
    )
    assert v1.headers["content-type"].startswith("text/html")
    v2 = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/2/download", headers=operator_headers
    )
    assert v2.headers["content-type"] == "application/pdf"
    assert unquote(v2.headers["content-disposition"].split("filename*=UTF-8''")[1]) == (
        "客户方案A-v2.pdf"
    )
    assert v2.content == _PDF


def test_delete_pdf_removes_single_object(client, operator_headers):
    body = _mk_proposal(
        client,
        operator_headers,
        content=_PDF,
        filename="quote.pdf",
        content_type="application/pdf",
    )
    pid = body["proposal"]["id"]
    assert len(_FAKE_BUCKET) == 1

    res = client.delete(f"/api/v1/crm/proposals/{pid}", headers=operator_headers)
    assert res.status_code == 204
    assert _FAKE_BUCKET == {}


# ---------- 列表 / scope / 权限 ----------


def test_list_scope_mine_only_own(client, operator_headers, businessdev_headers):
    _mk_proposal(client, operator_headers, title="我的方案")
    _mk_proposal(client, businessdev_headers, title="别人的方案")

    mine = client.get("/api/v1/crm/proposals?scope=mine", headers=operator_headers).json()
    assert [i["title"] for i in mine["items"]] == ["我的方案"]
    assert mine["total"] == 1


def test_list_scope_all_not_downgraded_for_nonadmin(client, operator_headers, businessdev_headers):
    """方案域全员可见（BLF-1403 / BLF-1410）：非 admin 的 scope=all **不降级**。"""
    _mk_proposal(client, operator_headers, title="我的方案")
    _mk_proposal(client, businessdev_headers, title="别人的方案")

    all_items = client.get("/api/v1/crm/proposals?scope=all", headers=operator_headers).json()
    assert all_items["total"] == 2
    assert {i["title"] for i in all_items["items"]} == {"我的方案", "别人的方案"}


def test_list_default_scope_is_all(client, operator_headers, businessdev_headers):
    """列表端点 scope 默认值 = all（与其它 CRM 列表端点对齐）。"""
    _mk_proposal(client, operator_headers, title="我的方案")
    _mk_proposal(client, businessdev_headers, title="别人的方案")

    default_items = client.get("/api/v1/crm/proposals", headers=operator_headers).json()
    assert default_items["total"] == 2
    assert {i["title"] for i in default_items["items"]} == {"我的方案", "别人的方案"}


@pytest.mark.parametrize("scope", ["sea", "x", "All", "ALL", "public", " "])
def test_list_rejects_unknown_scope(client, operator_headers, scope):
    """方案域 scope **值域收口**：白名单 ``{mine, all}`` 外一律 400。

    收口前是个既有绕过口子：服务层只判 ``scope == "mine"``，**任何**其它字符串
    都等于「不加 owner 过滤 = 看全部」→ 非 admin 传 ``scope=sea`` 就能看到
    全部方案（``resolve_scope`` 对方案域只挡字面量 ``"all"``）。
    """
    res = client.get(f"/api/v1/crm/proposals?scope={scope}", headers=operator_headers)
    assert res.status_code == 400, res.text
    assert "不支持的 scope" in res.json()["detail"]


def test_list_admin_sees_all(client, operator_headers, admin_headers):
    _mk_proposal(client, operator_headers, title="销售的方案")
    _mk_proposal(client, admin_headers, title="管理员的方案")
    all_items = client.get("/api/v1/crm/proposals?scope=all", headers=admin_headers).json()
    assert all_items["total"] == 2


def test_list_keyword_and_status_filter(client, operator_headers):
    _mk_proposal(client, operator_headers, title="入驻方案")
    second = _mk_proposal(client, operator_headers, title="报价方案")
    client.patch(
        f"/api/v1/crm/proposals/{second['proposal']['id']}",
        headers=operator_headers,
        json={"status": "published"},
    )

    kw = client.get("/api/v1/crm/proposals?keyword=报价", headers=operator_headers).json()
    assert kw["total"] == 1 and kw["items"][0]["title"] == "报价方案"

    published = client.get(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        params={"filters": '[{"field":"status","op":"eq","value":"published"}]'},
    ).json()
    assert published["total"] == 1


def test_list_rejects_unknown_sort_field(client, operator_headers):
    r = client.get("/api/v1/crm/proposals?sort_by=owner_id", headers=operator_headers)
    assert r.status_code == 400


def test_list_rejects_non_eq_filter(client, operator_headers):
    r = client.get(
        "/api/v1/crm/proposals",
        headers=operator_headers,
        params={"filters": '[{"field":"title","op":"contains","value":"x"}]'},
    )
    assert r.status_code == 400


def test_foreign_proposal_readable_but_not_writable(client, operator_headers, businessdev_headers):
    """方案域全员可读（BLF-1403 / BLF-1410），但**写**仍限 owner/admin。

    - 只读（详情 / 预览 / 下载）→ 200
    - 写（编辑 / 删除 / 追加版本）→ 403
    """
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]

    # 只读：全员可读（含跨私海）
    assert client.get(f"/api/v1/crm/proposals/{pid}", headers=businessdev_headers).status_code == 200
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/content", headers=businessdev_headers
    )
    assert res.status_code == 200, res.text
    assert "bb-proposal-theme" in res.json()["content"]
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download", headers=businessdev_headers
    )
    assert res.status_code == 200, res.text
    assert "bb-proposal-theme" in res.text

    # 写：非 owner 仍 403
    assert (
        client.patch(
            f"/api/v1/crm/proposals/{pid}", headers=businessdev_headers, json={"title": "x"}
        ).status_code
        == 403
    )
    assert (
        client.delete(f"/api/v1/crm/proposals/{pid}", headers=businessdev_headers).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/crm/proposals/{pid}/versions",
            headers=businessdev_headers,
            files=_upload("<html></html>"),
        ).status_code
        == 403
    )


def test_admin_can_operate_others(client, operator_headers, admin_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    assert client.get(f"/api/v1/crm/proposals/{pid}", headers=admin_headers).status_code == 200
    r = client.patch(
        f"/api/v1/crm/proposals/{pid}", headers=admin_headers, json={"status": "archived"}
    )
    assert r.status_code == 200
    assert r.json()["status"] == "archived"


def test_ownerless_proposal_readable_but_not_writable(
    client, operator_headers, businessdev_headers
):
    """**无主方案**（owner_id IS NULL）：读侧 200，写侧 403。

    线上确实存在无主方案：``create_proposal`` 的 owner 取自请求头
    ``X-User-Id``（``proposal_service.py``：
    ``owner_id = (user_id or "").strip() or None``）——请求不带该头时
    就是无主（``owner_id`` 落库为 NULL）。

    口径 A（全员可见）下它必须**可读**（否则又会出现「列表看得到、
    点进去 403」的静默回归）；但**写**仍 403（``require_owner_or_admin``
    对无主记录已正确 403）。
    """
    # 不带 X-User-Id → owner_id 落库为 NULL（无主方案）
    ownerless_headers = {
        k: v for k, v in operator_headers.items() if k != "X-User-Id"
    }
    body = _mk_proposal(client, ownerless_headers, title="无主方案")
    pid = body["proposal"]["id"]
    assert body["proposal"]["owner_id"] is None

    # 只读：全员可读（含无主方案）
    res = client.get(f"/api/v1/crm/proposals/{pid}", headers=businessdev_headers)
    assert res.status_code == 200, res.text
    assert res.json()["owner_id"] is None
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/content", headers=businessdev_headers
    )
    assert res.status_code == 200, res.text
    res = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download", headers=businessdev_headers
    )
    assert res.status_code == 200, res.text

    # 列表：scope=all 能看到无主方案；scope=mine 不含（owner_id IS NULL ≠ 当前用户）
    all_items = client.get("/api/v1/crm/proposals?scope=all", headers=businessdev_headers).json()
    assert "无主方案" in {i["title"] for i in all_items["items"]}
    mine_items = client.get("/api/v1/crm/proposals?scope=mine", headers=businessdev_headers).json()
    assert "无主方案" not in {i["title"] for i in mine_items["items"]}

    # 写：无主方案对非 admin 仍 403（含 admin 以外的所有人）
    assert (
        client.patch(
            f"/api/v1/crm/proposals/{pid}", headers=businessdev_headers, json={"title": "x"}
        ).status_code
        == 403
    )
    assert (
        client.delete(f"/api/v1/crm/proposals/{pid}", headers=businessdev_headers).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/crm/proposals/{pid}/versions",
            headers=businessdev_headers,
            files=_upload("<html></html>"),
        ).status_code
        == 403
    )


# ---------- 更新 / 删除 ----------


def test_update_title_and_status(client, operator_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    r = client.patch(
        f"/api/v1/crm/proposals/{pid}",
        headers=operator_headers,
        json={"title": "新标题", "status": "published", "proposal_type": "quotation"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "新标题"
    assert r.json()["status"] == "published"
    assert r.json()["proposal_type"] == "quotation"


def test_delete_removes_versions_and_r2(client, operator_headers, db_session):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    keys_before = set(_FAKE_BUCKET)
    assert len(keys_before) == 2  # raw + adapted

    res = client.delete(f"/api/v1/crm/proposals/{pid}", headers=operator_headers)
    assert res.status_code == 204
    assert _FAKE_BUCKET == {}
    remaining = db_session.execute(
        text("select count(*) from crm_proposal_versions where proposal_id = :pid"),
        {"pid": pid},
    ).scalar_one()
    assert remaining == 0


def test_delete_missing_404(client, operator_headers):
    assert (
        client.delete("/api/v1/crm/proposals/999999", headers=operator_headers).status_code
        == 404
    )


# ---------- 审计 ----------


def test_audit_logs_written(client, operator_headers, db_session):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    client.post(
        f"/api/v1/crm/proposals/{pid}/versions",
        headers=operator_headers,
        files=_upload("<html></html>"),
    )
    client.patch(
        f"/api/v1/crm/proposals/{pid}", headers=operator_headers, json={"status": "published"}
    )

    rows = db_session.execute(
        text(
            "select action from crm_audit_logs where entity_type = 'proposal' "
            "and entity_id = :pid order by id"
        ),
        {"pid": pid},
    ).scalars().all()
    assert list(rows) == ["create", "update", "status"]


# ---------- R2 未配置 ----------


def test_r2_disabled_returns_503(client, operator_headers):
    with patch.object(
        type(get_settings()),
        "r2_enabled",
        new_callable=PropertyMock,
        return_value=False,
    ):
        r = client.post(
            "/api/v1/crm/proposals",
            headers=operator_headers,
            files=_upload(_HTML),
            data={"title": "x"},
        )
    assert r.status_code == 503
