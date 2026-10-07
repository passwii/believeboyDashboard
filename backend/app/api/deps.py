import base64
from urllib.parse import unquote

from fastapi import Depends, HTTPException, status
from fastapi import Header
from sqlalchemy.orm import Session

from app.core.security import require_api_key
from app.db.query_timeout import install_statement_timeout
from app.db.session import get_db, get_primary_db, get_read_db


DbSession = Session


def get_db_session(db: Session = Depends(get_db)) -> Session:
    return db


def get_read_db_session(db: Session = Depends(get_read_db)) -> Session:
    """Read-routed session. Use for pure-GET handlers (BEL-55-P5 / BEL-73).

    When `database_read_url` is blank this transparently returns a primary
    session, so endpoints can adopt it without breaking the no-replica path.
    """
    return db


def get_primary_db_session(db: Session = Depends(get_primary_db)) -> Session:
    """Primary-only session. Use for write handlers and write-after-read."""
    return db


def get_bounded_read_db_session(db: Session = Depends(get_read_db_session)) -> Session:
    """Read-routed session **带事务级 statement_timeout 上限**（BLF-1262 Stage 1）。

    与 `get_read_db_session` 的唯一区别：在 Session 上装一个 `after_begin` 监听器，
    把 `statement_timeout` 收紧到 `Settings.order_info_statement_timeout_ms`
    （默认 15s，全局兜底仍是 120s）。

    **刻意不做成全局默认**：月报 / AI / 定时报告这些合法长跑端点要跑得比 15s 长，
    在没有逐端点实测数据之前统一收紧等于把它们打挂。所以只让明确知道自己在
    收窄的端点显式声明依赖。

    非 Postgres 方言（SQLite 单测）下是 no-op，行为与 `get_read_db_session` 一致。
    """
    from app.core.config import get_settings

    install_statement_timeout(db, get_settings().order_info_statement_timeout_ms)
    return db


def protected(_: None = Depends(require_api_key)) -> None:
    return None



def _decode_header_value(value: str) -> str:
    if not value:
        return value
    # Try base64 first (front-end encoding for non-ASCII)
    try:
        decoded = base64.b64decode(value).decode('utf-8')
        return decoded
    except Exception:
        pass
    # Fall back to URL decoding
    return unquote(value).strip()


def get_request_operator(
    x_operator: str | None = Header(default=None, alias='X-Operator'),
    x_user_name: str | None = Header(default=None, alias='X-User-Name'),
) -> str | None:
    raw_value = x_operator if x_operator is not None else x_user_name
    if raw_value is None:
        return None
    value = _decode_header_value(raw_value)
    return value[:255] if value else None


def get_request_is_admin(x_is_admin: str | None = Header(default=None, alias='X-Is-Admin')) -> bool:
    if x_is_admin is None:
        return False
    return x_is_admin.strip().lower() in {'1', 'true', 'yes', 'on'}


def get_request_role_type(x_role_type: str | None = Header(default=None, alias='X-Role-Type')) -> str | None:
    if x_role_type is None:
        return None
    value = _decode_header_value(x_role_type)
    return value[:32] if value else None


def get_request_user_id(
    x_user_id: str | None = Header(default=None, alias='X-User-Id'),
) -> str | None:
    """Read the authenticated user id from the proxy-injected ``X-User-Id`` header.

    Returns None when missing so individual endpoints can decide whether to
    raise 401 (vs. treating it as anonymous, e.g. health checks).
    """
    if x_user_id is None:
        return None
    value = _decode_header_value(x_user_id)
    return value[:64] if value else None


def require_admin(is_admin: bool = Depends(get_request_is_admin)) -> bool:
    """管理员专属依赖（流程模板 / 项目节点定义等写接口）。

    管理员判定沿用既有 ``X-Is-Admin`` 口径（与 scheduled_reports.require_admin 同形）；
    前端隐藏入口只是体验，后端 403 才是权限权威。
    """
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail='需要管理员权限'
        )
    return True
