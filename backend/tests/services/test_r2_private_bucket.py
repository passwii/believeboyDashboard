"""BLF-1418：R2 公开读 → 私有（分桶）路由与 fail-closed 行为。

背景
----
``settings.r2_bucket_name`` 挂在 Cloudflare R2 自定义域名 ``bucket.believeboy.com``
上，**整个桶公开可读**（无鉴权即可 GET 任意 key，key 可枚举）。仅靠应用层
「不签发公开 URL」挡不住直连桶的请求 —— 客户方案（含报价 / 客户信息）因此
可被任何人下载。

解法（方案 A · 分桶）
--------------------
新增 ``R2_PRIVATE_BUCKET_NAME``：一个**不挂自定义域名**的私有桶，匿名不可读。
敏感前缀（当前 = ``crm-proposals/``）的对象写入私有桶，且**不生成公开 URL**，
只能经后端鉴权转发访问。

本测试覆盖
----------
1. 桶路由：敏感前缀 → 私有桶；其余前缀 → 公开桶。
2. 私有桶未配置时**不静默降级**：敏感对象**拒绝写入**（fail-closed），
   且是在**写入之前**判定（不能「先写进公开桶再报错」）。
3. 敏感对象不生成公开 URL；公开对象照旧生成公开 URL。
4. 敏感对象的读 / 删 / 存在性检查 / 预签名 URL 都走私有桶。
5. 孤立文件清理脚本**不删**敏感前缀对象（否则是不可恢复的数据丢失）。
"""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from app.core.config import Settings
from app.services.r2_service import (
    PRIVATE_KEY_PREFIXES,
    check_file_exists,
    delete_file_from_r2,
    generate_presigned_url,
    get_file_url,
    is_private_key,
    iter_file_from_r2,
    resolve_bucket,
    try_delete_file_from_r2,
    upload_bytes_to_r2,
)

# 客户方案 key（现状：唯一敏感前缀）
CRM_KEY = "crm-proposals/1/v1/raw.html"
# 公开内容 key（店铺前缀 / 特殊功能页）
PUBLIC_KEY = "华洋泛航/inspection-screenshots/abc.jpg"
SPECIAL_PAGE_KEY = "special-pages/user_0/abc.md"


def _settings(private_bucket: str | None = "believeboy-private") -> Settings:
    """构造一份 R2 配置；``private_bucket=None`` 表示未配置私有桶。"""
    return Settings(
        r2_endpoint_url="https://example.r2.cloudflarestorage.com",
        r2_access_key_id="ak",
        r2_secret_access_key="sk",
        r2_bucket_name="believeboy-dash",
        r2_public_url="https://bucket.believeboy.com",
        r2_private_bucket_name=private_bucket or "",
    )


@pytest.fixture
def fake_client() -> Iterator[MagicMock]:
    """Provide a mocked boto3 S3 client and force ``_r2_client`` to point at it."""
    client = MagicMock()
    with patch("app.services.r2_service._r2_client", client):
        yield client


# ---------------------------------------------------------------------------
# (1) 桶路由
# ---------------------------------------------------------------------------


def test_private_prefixes_contains_crm_proposals():
    assert "crm-proposals" in PRIVATE_KEY_PREFIXES


def test_is_private_key():
    assert is_private_key(CRM_KEY) is True
    assert is_private_key(PUBLIC_KEY) is False
    assert is_private_key(SPECIAL_PAGE_KEY) is False
    assert is_private_key("") is False


def test_is_private_key_tolerates_leading_slash():
    """前导斜杠也必须判为敏感 —— 否则多写一个 ``/`` 就能绕开私有桶路由。"""
    assert is_private_key("/crm-proposals/1/v1/raw.html") is True
    assert is_private_key("//crm-proposals/1/v1/raw.html") is True
    assert is_private_key("/db-backups/pgbackrest/x.tar.gz") is True
    assert is_private_key("/华洋泛航/a.jpg") is False


def test_resolve_bucket_with_leading_slash_routes_to_private():
    s = _settings()
    assert resolve_bucket(s, "/crm-proposals/1/v1/raw.html") == "believeboy-private"


def test_private_prefixes_include_backups_defense_in_depth():
    """``backups`` 前缀是纵深防御：pgBackRest 不经应用层路由，但列入敏感前缀
    可确保将来任何把备份写进应用层 key 空间的代码仍被判为敏感。"""
    assert "backups" in PRIVATE_KEY_PREFIXES
    assert is_private_key("backups/blf/repo/backup/x") is True


def test_resolve_bucket_routes_private_prefix_to_private_bucket():
    s = _settings()
    assert s.r2_private_bucket_isolated is True
    assert resolve_bucket(s, CRM_KEY) == "believeboy-private"


def test_resolve_bucket_keeps_public_prefix_in_public_bucket():
    s = _settings()
    assert resolve_bucket(s, PUBLIC_KEY) == "believeboy-dash"
    assert resolve_bucket(s, SPECIAL_PAGE_KEY) == "believeboy-dash"


def test_resolve_bucket_falls_back_when_private_bucket_not_configured():
    """未配置私有桶时回落到公开桶（行为同 BLF-1418 之前）。

    路由本身不拒绝 —— 拒绝发生在**写入路径**（见下方 fail-closed 用例），
    这样读取历史数据（迁移前已在公开桶的对象）不会被打断。
    """
    s = _settings(private_bucket=None)
    assert s.r2_private_bucket_isolated is False
    assert s.r2_private_bucket_resolved == "believeboy-dash"
    assert resolve_bucket(s, CRM_KEY) == "believeboy-dash"


def test_private_bucket_same_name_as_public_is_not_isolated():
    """私有桶名 == 公开桶名 ⇒ 视为未隔离（不能假装隔离了）。"""
    s = _settings(private_bucket="believeboy-dash")
    assert s.r2_private_bucket_isolated is False


# ---------------------------------------------------------------------------
# (2) fail-closed：私有桶未配置时拒绝写入敏感对象
# ---------------------------------------------------------------------------


def test_upload_private_key_rejected_when_private_bucket_missing(fake_client):
    """私有桶未配置 → 敏感对象**不写入**（503 级失败，而非静默公开）。"""
    s = _settings(private_bucket=None)
    with pytest.raises(RuntimeError, match="BLF-1418"):
        upload_bytes_to_r2(
            s, b"<html>secret</html>", "raw.html",
            project_slug="crm-proposals", file_type="1/v1",
        )
    fake_client.upload_fileobj.assert_not_called()


def test_upload_private_key_rejected_before_any_write(fake_client):
    """关键：判定发生在**写入之前** —— 不能「先写进公开桶再报错」。"""
    s = _settings(private_bucket=None)
    with pytest.raises(RuntimeError):
        upload_bytes_to_r2(
            s, b"secret", "raw.html",
            project_slug="crm-proposals", file_type="1/v1",
        )
    fake_client.upload_fileobj.assert_not_called()
    fake_client.put_object.assert_not_called()


def test_upload_public_key_still_works_without_private_bucket(fake_client):
    """未配置私有桶时，公开内容照常上传（不破坏既有部署）。"""
    s = _settings(private_bucket=None)
    res = upload_bytes_to_r2(
        s, b"img", "abc.jpg",
        project_slug="华洋泛航", file_type="inspection-screenshots",
    )
    fake_client.upload_fileobj.assert_called_once()
    assert res["bucket"] == "believeboy-dash"
    assert res["url"].startswith("https://bucket.believeboy.com/")


# ---------------------------------------------------------------------------
# (3) 上传：桶选择 + 公开 URL 生成
# ---------------------------------------------------------------------------


def test_upload_private_key_goes_to_private_bucket(fake_client):
    s = _settings()
    res = upload_bytes_to_r2(
        s, b"<html>secret</html>", "raw.html",
        project_slug="crm-proposals", file_type="1/v1",
    )
    args, _ = fake_client.upload_fileobj.call_args
    assert args[1] == "believeboy-private"  # Bucket
    assert res["bucket"] == "believeboy-private"


def test_upload_private_key_returns_no_public_url(fake_client):
    """敏感对象**不返回公开 URL**（该 URL 指向公开读的自定义域名）。"""
    s = _settings()
    res = upload_bytes_to_r2(
        s, b"<html>secret</html>", "raw.html",
        project_slug="crm-proposals", file_type="1/v1",
    )
    assert res["url"] == ""
    assert "bucket.believeboy.com" not in res["url"]


def test_upload_public_key_returns_public_url(fake_client):
    s = _settings()
    res = upload_bytes_to_r2(
        s, b"img", "abc.jpg",
        project_slug="华洋泛航", file_type="inspection-screenshots",
    )
    # 中文 key 按既有约定 percent-encode（quote(key, safe='/')）
    assert res["url"] == (
        "https://bucket.believeboy.com/"
        "%E5%8D%8E%E6%B4%8B%E6%B3%9B%E8%88%AA/inspection-screenshots/abc.jpg"
    )
    assert res["url"].startswith("https://bucket.believeboy.com/")


def test_upload_file_to_r2_private_key_uses_private_bucket(fake_client):
    """upload_file_to_r2（字节流版）同样按前缀路由。"""
    s = _settings()
    res = upload_bytes_to_r2(
        s, b"x", "raw.html", project_slug="crm-proposals", file_type="9/v9",
    )
    assert res["bucket"] == "believeboy-private"


# ---------------------------------------------------------------------------
# (4) 读 / 删 / 存在性 / 预签名：都按桶路由
# ---------------------------------------------------------------------------


def test_get_file_url_empty_for_private_key():
    s = _settings()
    assert get_file_url(s, CRM_KEY) == ""


def test_get_file_url_public_for_public_key():
    s = _settings()
    assert get_file_url(s, PUBLIC_KEY) == (
        "https://bucket.believeboy.com/"
        "%E5%8D%8E%E6%B4%8B%E6%B3%9B%E8%88%AA/inspection-screenshots/abc.jpg"
    )


def test_delete_uses_private_bucket(fake_client):
    """敏感 key 的删除：私有桶 + 公开桶**两个都删**（BLF-1418 review 修 #1）。

    只删私有桶会漏掉迁移窗口期内的公开副本 —— 方案删了但公开桶里的旧对象
    永远残留，变成公开可下载的孤儿。
    """
    s = _settings()
    delete_file_from_r2(s, CRM_KEY)
    called = {c.kwargs["Bucket"] for c in fake_client.delete_object.call_args_list}
    assert called == {"believeboy-private", "believeboy-dash"}
    for c in fake_client.delete_object.call_args_list:
        assert c.kwargs["Key"] == CRM_KEY


def test_try_delete_uses_private_bucket(fake_client):
    s = _settings()
    result = try_delete_file_from_r2(s, CRM_KEY)
    assert result.success is True
    called = {c.kwargs["Bucket"] for c in fake_client.delete_object.call_args_list}
    assert called == {"believeboy-private", "believeboy-dash"}


def test_delete_sensitive_key_removes_public_copy(fake_client):
    """回归锁定：敏感 key 的公开副本必须一并删除（review 修 #1 的核心）。"""
    s = _settings()
    delete_file_from_r2(s, CRM_KEY)
    buckets = [c.kwargs["Bucket"] for c in fake_client.delete_object.call_args_list]
    assert "believeboy-dash" in buckets, "公开桶副本未被删除 → 会变成永久公开的孤儿"


def test_delete_public_key_uses_public_bucket(fake_client):
    s = _settings()
    delete_file_from_r2(s, PUBLIC_KEY)
    fake_client.delete_object.assert_called_once_with(
        Bucket="believeboy-dash", Key=PUBLIC_KEY
    )


def test_delete_not_isolated_single_bucket(fake_client):
    """未隔离时只删一个桶（没有第二个桶可删）。"""
    s = _settings(private_bucket=None)
    delete_file_from_r2(s, CRM_KEY)
    fake_client.delete_object.assert_called_once_with(
        Bucket="believeboy-dash", Key=CRM_KEY
    )


def test_delete_reports_failure_when_all_buckets_fail(fake_client):
    """两个桶都失败 → success=False（让上层登记死信）。"""
    from botocore.exceptions import ClientError

    s = _settings()
    fake_client.delete_object.side_effect = ClientError(
        {"Error": {"Code": "500"}}, "DeleteObject"
    )
    result = try_delete_file_from_r2(s, CRM_KEY)
    assert result.success is False
    assert result.error_class == "ClientError"


def test_check_file_exists_uses_private_bucket(fake_client):
    s = _settings()
    assert check_file_exists(s, CRM_KEY) is True
    fake_client.head_object.assert_called_once_with(
        Bucket="believeboy-private", Key=CRM_KEY
    )


def test_presigned_url_points_at_private_bucket(fake_client):
    """预签名 URL 的 Bucket 必须是私有桶（否则签名 URL 指向公开桶毫无意义）。"""
    s = _settings()
    fake_client.generate_presigned_url.return_value = "https://signed.example/x"
    url = generate_presigned_url(s, CRM_KEY)
    assert url == "https://signed.example/x"
    params = fake_client.generate_presigned_url.call_args.kwargs["Params"]
    assert params["Bucket"] == "believeboy-private"
    assert params["Key"] == CRM_KEY


def test_presigned_url_for_public_key_uses_public_bucket(fake_client):
    s = _settings()
    fake_client.generate_presigned_url.return_value = "https://signed.example/x"
    generate_presigned_url(s, PUBLIC_KEY)
    params = fake_client.generate_presigned_url.call_args.kwargs["Params"]
    assert params["Bucket"] == "believeboy-dash"


def test_iter_file_from_r2_uses_private_bucket(fake_client):
    """流式读取（客户方案预览 / 下载走这条路）也必须读私有桶。"""
    from app.services.r2_service import iter_file_from_r2

    s = _settings()
    body = MagicMock()
    body.read.side_effect = [b"chunk", b""]
    fake_client.get_object.return_value = {"Body": body}

    data = b"".join(iter_file_from_r2(s, CRM_KEY))
    assert data == b"chunk"
    fake_client.get_object.assert_called_once_with(
        Bucket="believeboy-private", Key=CRM_KEY
    )


def test_download_file_to_path_uses_private_bucket(fake_client, tmp_path):
    from app.services.r2_service import download_file_to_path

    s = _settings()
    dest = tmp_path / "out.html"
    assert download_file_to_path(s, CRM_KEY, dest) is True
    args = fake_client.download_file.call_args.args
    assert args[0] == "believeboy-private"
    assert args[1] == CRM_KEY


# ---------------------------------------------------------------------------
# (5) 读取兜底：私有桶优先、公开桶兜底（迁移窗口期安全）
# ---------------------------------------------------------------------------


def test_bucket_candidates_private_first():
    s = _settings()
    from app.services.r2_service import bucket_candidates

    assert bucket_candidates(s, CRM_KEY) == ["believeboy-private", "believeboy-dash"]


def test_bucket_candidates_single_when_not_isolated():
    s = _settings(private_bucket=None)
    from app.services.r2_service import bucket_candidates

    assert bucket_candidates(s, CRM_KEY) == ["believeboy-dash"]


def test_check_file_exists_falls_back_to_public_bucket(fake_client):
    """私有桶没有、公开桶有（迁移窗口期）→ 仍应判定为存在。"""
    from botocore.exceptions import ClientError

    s = _settings()
    fake_client.head_object.side_effect = [
        ClientError({"Error": {"Code": "404"}}, "HeadObject"),
        {"ContentLength": 10},
    ]
    assert check_file_exists(s, CRM_KEY) is True
    assert fake_client.head_object.call_count == 2


def test_check_file_exists_false_when_absent_everywhere(fake_client):
    from botocore.exceptions import ClientError

    s = _settings()
    fake_client.head_object.side_effect = ClientError(
        {"Error": {"Code": "404"}}, "HeadObject"
    )
    assert check_file_exists(s, CRM_KEY) is False


def test_iter_falls_back_to_public_bucket(fake_client):
    """流式读取同样兜底 —— 客户方案是交付物，读不到等于丢单。"""
    from botocore.exceptions import ClientError

    s = _settings()
    body = MagicMock()
    body.read.side_effect = [b"chunk", b""]
    fake_client.get_object.side_effect = [
        ClientError({"Error": {"Code": "404"}}, "GetObject"),
        {"Body": body},
    ]
    data = b"".join(iter_file_from_r2(s, CRM_KEY))
    assert data == b"chunk"


def test_iter_raises_when_missing_everywhere(fake_client):
    from botocore.exceptions import ClientError

    s = _settings()
    fake_client.get_object.side_effect = ClientError(
        {"Error": {"Code": "404"}}, "GetObject"
    )
    with pytest.raises(ClientError):
        b"".join(iter_file_from_r2(s, CRM_KEY))


# ---------------------------------------------------------------------------
# (6) 孤立文件清理脚本不得删除敏感对象
# ---------------------------------------------------------------------------


def test_cleanup_script_skips_private_prefix_keys():
    """清理脚本只扫公开桶，无法反查私有桶引用 → 敏感前缀一律跳过。

    否则客户方案对象会被判成「孤儿」并删除 —— 不可恢复的数据丢失。
    """
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts.cleanup_r2_orphaned_files import find_orphaned_files

    src = inspect.getsource(find_orphaned_files)
    assert "is_private_key" in src, (
        "清理脚本必须跳过敏感前缀（私有桶对象不可按孤儿删除）"
    )


def test_cleanup_script_skip_is_before_orphan_classification():
    """跳过判定必须在「是否孤儿」的分支**之前**（否则仍会被删）。"""
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts.cleanup_r2_orphaned_files import find_orphaned_files

    src = inspect.getsource(find_orphaned_files)
    skip_at = src.index("is_private_key(key)")
    orphan_at = src.index("if not is_referenced:")
    assert skip_at < orphan_at, "敏感前缀的跳过判定必须早于孤儿判定"


# ---------------------------------------------------------------------------
# (7) 端点层：私有桶未配置时客户方案上传返回 503（fail-closed）
# ---------------------------------------------------------------------------


def test_proposal_upload_503_when_private_bucket_not_configured():
    """客户方案写入口必须 fail-closed：私有桶未配置 → 503，不落库不写桶。"""
    from fastapi import HTTPException

    from app.services.crm.proposal_service import _require_private_bucket

    s = _settings(private_bucket=None)
    with pytest.raises(HTTPException) as exc:
        _require_private_bucket(s)
    assert exc.value.status_code == 503


def test_proposal_upload_allowed_when_private_bucket_configured():
    from app.services.crm.proposal_service import _require_private_bucket

    _require_private_bucket(_settings())


def test_private_bucket_guard_is_wired_into_write_paths():
    """两个写入口（建方案 / 追加版本）都必须调用守卫。"""
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from app.services.crm import proposal_service

    for fn_name in ("create_proposal", "add_version"):
        src = inspect.getsource(getattr(proposal_service, fn_name))
        assert "_require_private_bucket" in src, f"{fn_name} 缺少私有桶守卫"


# ---------------------------------------------------------------------------
# (8) 回归：既有公开内容行为不变
# ---------------------------------------------------------------------------


def test_special_pages_stay_public():
    """特殊功能页（/p/{id}）**必须**留在公开桶 —— 它按设计就是免鉴权公开页。"""
    s = _settings()
    assert resolve_bucket(s, SPECIAL_PAGE_KEY) == "believeboy-dash"
    assert is_private_key(SPECIAL_PAGE_KEY) is False


def test_shop_prefixes_stay_public():
    """店铺前缀（各店铺报表 / 巡检截图）保持公开，避免打挂现有页面。"""
    s = _settings()
    for key in (
        "华洋泛航/inspection-screenshots/a.jpg",
        "创酷/scheduled-reports/full/b.png",
        "exchange-rate-notes/images/c.webp",
    ):
        assert resolve_bucket(s, key) == "believeboy-dash"
        assert is_private_key(key) is False


def test_upload_bytes_result_shape_unchanged(fake_client):
    """返回结构保持 key/url/bucket/size 四字段（既有调用方依赖）。"""
    s = _settings()
    res = upload_bytes_to_r2(
        s, b"x", "a.jpg", project_slug="华洋泛航", file_type="t",
    )
    assert set(res) == {"key", "url", "bucket", "size"}
    assert res["size"] == 1
    assert res["key"] == "华洋泛航/t/a.jpg"


# ---------------------------------------------------------------------------
# (9) artifact_service.build_public_url —— 第二个公开 URL 构造器必须复用同一处
#     （BLF-1418 review 修 #7：敏感 key 不出公开 URL 的不变量只能守在一处）
# ---------------------------------------------------------------------------


def test_artifact_build_public_url_empty_for_sensitive_key():
    """敏感 key 经 artifact_service 也不得生成公开 URL。"""
    from app.services.artifact_service import ArtifactService

    with patch(
        "app.services.artifact_service.get_settings",
        return_value=_settings(),
    ):
        assert ArtifactService.build_public_url(CRM_KEY) == ""


def test_artifact_build_public_url_public_for_public_key():
    """公开 key 仍照旧生成公开 URL（行为不变）。"""
    from app.services.artifact_service import ArtifactService

    with patch(
        "app.services.artifact_service.get_settings",
        return_value=_settings(),
    ):
        url = ArtifactService.build_public_url(PUBLIC_KEY)
    assert url.startswith("https://bucket.believeboy.com/")
    assert "inspection-screenshots/abc.jpg" in url


def test_artifact_build_public_url_delegates_to_get_file_url():
    """回归锁定：artifact_service 不得再自己拼公开 URL（必须委托 get_file_url）。

    用 AST 判断「代码里有没有引用 r2_public_url」，而不是字符串匹配 ——
    docstring 里可以提到它作为说明，但实现里不能读它。
    """
    import ast
    import inspect
    import textwrap

    from app.services.artifact_service import ArtifactService

    src = textwrap.dedent(inspect.getsource(ArtifactService.build_public_url))
    assert "get_file_url" in src, "必须复用 r2_service.get_file_url()（单一守卫点）"

    tree = ast.parse(src)
    attrs = {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
    }
    assert "r2_public_url" not in attrs, (
        "不得在本函数里直接读 settings.r2_public_url（必须走 get_file_url 守卫）"
    )


# ---------------------------------------------------------------------------
# (10) 迁移脚本守卫（BLF-1418 review 修 #2 / #3）
# ---------------------------------------------------------------------------


def test_migrate_script_requires_isolation_for_all_write_actions():
    """任何写操作（--copy / --copy-back / --delete）都要求私有桶已隔离。

    旧实现漏了 --delete：私有桶未配置时 private_bucket 回落到公开桶，
    三重安全阀变成「自己跟自己比」→ 全过 → 把唯一副本删光。
    """
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts import migrate_r2_private_prefix as mig

    src = inspect.getsource(mig.main)
    guard_at = src.index("if not isolated:")
    # 守卫必须在任何写动作之前，且不能再按动作分别判断
    assert "if not isolated and (args.copy" not in src, (
        "隔离守卫不能只覆盖部分动作 —— --delete 同样会误删唯一副本"
    )
    assert guard_at < src.index("client.delete_object"), "守卫必须早于删除动作"
    assert guard_at < src.index("client.copy_object"), "守卫必须早于复制动作"


def test_migrate_script_copy_back_lists_private_bucket():
    """--copy-back 是回滚路径：源在私有桶（公开桶已空），必须列私有桶。"""
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts import migrate_r2_private_prefix as mig

    src = inspect.getsource(mig.main)
    assert "if args.copy_back:" in src, "--copy-back 必须走私有桶分支"
    assert "source_bucket = private_bucket" in src, (
        "--copy-back 必须列私有桶，否则公开桶已空 → 什么都 restore 不回来"
    )
    # 且 list_only（--dry-run 单独用）列的是公开桶
    assert "source_bucket = public_bucket" in src


# ---------------------------------------------------------------------------
# (11) 迁移脚本第二轮 review 修的三处
#     (a) --dry-run 必须真的可用（文档与 PR 正文都用了它）
#     (b) --delete 后必须输出待 purge 的 URL（删 origin ≠ 公开不可下载）
#     (c) --copy-back 要求私有桶仍配置着（回滚顺序）
# ---------------------------------------------------------------------------


def test_migrate_script_registers_dry_run_flag():
    """``--dry-run`` 必须在 parser 里注册 —— 文档与 PR 正文都拿它当预检命令。"""
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts import migrate_r2_private_prefix as mig

    src = Path(mig.__file__).read_text(encoding="utf-8")
    assert '"--dry-run"' in src, "--dry-run 必须是一个真实注册的 flag"


def test_migrate_script_dry_run_is_accepted_without_action():
    """``--dry-run`` 单独用不能被 argparse 拒（不要求再给 --copy/--delete）。"""
    import subprocess
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    script = backend / "scripts" / "migrate_r2_private_prefix.py"
    proc = subprocess.run(
        [sys.executable, str(script), "--dry-run", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "--dry-run" in proc.stdout


def test_migrate_script_emits_purge_targets_on_delete():
    """删掉 origin 后必须输出待 purge 的 URL 清单。

    删 origin ≠ 公开不可下载：R2 自定义域名对部分对象启用 Cloudflare 边缘缓存，
    边缘副本在 purge 前仍可被匿名下载。脚本必须把 purge 目标显式交出来。
    """
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts import migrate_r2_private_prefix as mig

    src = inspect.getsource(mig.main)
    assert "purge_targets" in src, "必须收集待 purge 的 URL"
    assert "purge_cache" in src, "必须打印 Cloudflare purge 的执行方式"
    # 删除动作后必须把 URL 记进 purge_targets
    delete_at = src.index("client.delete_object")
    append_at = src.index("purge_targets.append")
    assert append_at > delete_at, "purge 目标必须在删除之后记录"


def test_migrate_script_copy_back_requires_private_bucket_configured():
    """--copy-back 同样要求私有桶已配置（回滚时要知道从哪个桶恢复）。

    文档里的回滚顺序必须是「先 --copy-back，再考虑清 R2_PRIVATE_BUCKET_NAME」——
    清早了脚本就没有源桶可读，回滚无从下手。
    """
    import inspect
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from scripts import migrate_r2_private_prefix as mig

    src = inspect.getsource(mig.main)
    # 守卫是无条件的（不按动作分别判断）→ --copy-back 也在内
    assert "if not isolated and (args.copy" not in src
    assert "if not isolated:" in src
    # 错误提示里要写明回滚顺序
    assert "回滚" in src, "错误提示需说明 --copy-back 要在私有桶仍配置时跑"
