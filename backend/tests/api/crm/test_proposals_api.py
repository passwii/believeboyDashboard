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


# ---------- helpers ----------

_HTML = (
    "<html><head><title>提案</title></head>"
    "<body><h1>方案正文</h1><link href=\"./x.css\"></body></html>"
)


def _upload(content: bytes | str, filename: str = "plan.html", content_type: str = "text/html"):
    if isinstance(content, str):
        content = content.encode("utf-8")
    return {"file": (filename, io.BytesIO(content), content_type)}


def _mk_customer(client, headers, name="客户A"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_proposal(client, headers, *, content=_HTML, title="客户方案A", **form):
    r = client.post(
        "/api/v1/crm/proposals",
        headers=headers,
        files=_upload(content),
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


# ---------- 列表 / scope / 权限 ----------


def test_list_scope_mine_only_own(client, operator_headers, businessdev_headers):
    _mk_proposal(client, operator_headers, title="我的方案")
    _mk_proposal(client, businessdev_headers, title="别人的方案")

    mine = client.get("/api/v1/crm/proposals?scope=mine", headers=operator_headers).json()
    assert [i["title"] for i in mine["items"]] == ["我的方案"]
    assert mine["total"] == 1

    # 非 admin 的 scope=all 降级为 mine
    degraded = client.get("/api/v1/crm/proposals?scope=all", headers=operator_headers).json()
    assert degraded["total"] == 1


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


def test_foreign_proposal_forbidden(client, operator_headers, businessdev_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    for method, url in [
        ("get", f"/api/v1/crm/proposals/{pid}"),
        ("get", f"/api/v1/crm/proposals/{pid}/versions/1/content"),
        ("get", f"/api/v1/crm/proposals/{pid}/versions/1/download"),
    ]:
        assert getattr(client, method)(url, headers=businessdev_headers).status_code == 403
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


def test_admin_can_operate_others(client, operator_headers, admin_headers):
    body = _mk_proposal(client, operator_headers)
    pid = body["proposal"]["id"]
    assert client.get(f"/api/v1/crm/proposals/{pid}", headers=admin_headers).status_code == 200
    r = client.patch(
        f"/api/v1/crm/proposals/{pid}", headers=admin_headers, json={"status": "archived"}
    )
    assert r.status_code == 200
    assert r.json()["status"] == "archived"


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
