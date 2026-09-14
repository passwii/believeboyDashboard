from urllib.parse import unquote
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.passwords import verify_password
from app.db.session import SessionLocal
from app.schemas.system_management import UserRoleType
from app.services.audit_log_service import append_operation_audit_log
from app.services.infra import delete_user_sessions, validate_session, write_session
from app.services.rate_limit_service import clear_key, increment_and_check
from app.services.user_api_key_service import ensure_user_api_key, normalize_client_id

router = APIRouter(prefix="/auth", tags=["auth"])

limiter = Limiter(key_func=get_remote_address, default_limits=[])

LOGIN_IP_RATE_MAX = 10
LOGIN_IP_RATE_WINDOW = 15 * 60
LOGIN_EMAIL_FAILED_MAX = 5
LOGIN_EMAIL_FAILED_WINDOW = 30 * 60


class LoginRequest(BaseModel):
    email: str
    password: str = Field(min_length=1)


class LoginResponse(BaseModel):
    id: str
    name: str
    email: str
    operator_name_zh: str | None = None
    is_admin: bool
    is_active: bool
    role_type: UserRoleType = UserRoleType.operator
    session_id: str = ""
    # BLF-711（C2 方案）：登录按账号下发的专属 API key（桌面端直连后端用）。
    # hash-only 存储下每次登录都轮换下发新 key；web 端忽略该字段即可。
    api_key: str = ""


class MeResponse(BaseModel):
    id: str
    email: str
    name: str
    operator_name_zh: str | None = None
    is_admin: bool
    is_active: bool
    role_type: UserRoleType = UserRoleType.operator
    password_changed_at: str | None = None


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_login_rate_limits(request: Request, email: str) -> tuple[bool, int]:
    """Check both IP and per-email rate limits. Returns (allowed, retry_after_seconds)."""
    ip = _get_client_ip(request)

    _, ip_retry = increment_and_check(
        "login_ip", ip, LOGIN_IP_RATE_MAX, LOGIN_IP_RATE_WINDOW
    )
    if ip_retry > 0:
        return False, ip_retry

    email_key = email.strip().lower()
    _, email_retry = increment_and_check(
        "login_email_fail", email_key, LOGIN_EMAIL_FAILED_MAX, LOGIN_EMAIL_FAILED_WINDOW
    )
    if email_retry > 0:
        return False, email_retry

    return True, 0


@router.post("/login", response_model=LoginResponse)
def login(
    request: Request,
    payload: LoginRequest,
    x_client_id: str | None = Header(default=None, alias="X-Client-Id"),
) -> LoginResponse | JSONResponse:
    """登录并签发该设备槽的专属 API key（BLF-711 / BLF-1059）。

    设备槽通过请求头 ``X-Client-Id`` 携带（可选）：一个账号可以有多把 key，
    每个槽内只有一把有效 key；同一槽重登 = 轮换（旧 key 立即失效），**槽之间
    互不影响**。不携带此头的调用方（网页端代理、拆分前发布的桌面端构建）落
    ``default`` 槽，行为与拆分前完全一致，故网页端零改动。

    选头而不选请求体字段的理由：不动 ``/auth/login`` 的 request/response
    schema —— 已提交的契约文件（``frontend/types/api-generated/openapi.json``
    与 ``api.d.ts``）保持同步，``pnpm build`` 的 ``gen:api-types:check`` 不受
    影响，也不必为纯后端改动去做一次跨端契约导出；且本仓库的身份类入参本来就
    走头（``X-Operator`` / ``X-Is-Admin`` / ``X-User-Id`` / ``X-API-Key``）。

    形态非法（超 64 字符 / 含空白与控制字符）→ 400，而不是静默落 ``default``：
    静默降级会让发错标识的设备与网页端共用一把 key，比报错更难排查。
    """
    try:
        client_id = normalize_client_id(x_client_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid X-Client-Id"
        ) from None

    # ── Rate limit check ───────────────────────────────────────────────────────
    allowed, retry_after = _check_login_rate_limits(request, payload.email)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many login attempts. Please try again later."},
            headers={
                "Retry-After": str(retry_after),
                "X-RateLimit-Retry-After-Sec": str(retry_after),
            },
        )

    db: Session = SessionLocal()
    try:
        row = (
            db.execute(
                text(
                    """
                select
                  id::text as id,
                  name,
                  email,
                  password_hash,
                  operator_name_zh,
                  is_admin,
                  is_active,
                  role_type
                from public.user_accounts
                where lower(email) = lower(:email)
                limit 1
                """
                ),
                {"email": payload.email.strip().lower()},
            )
            .mappings()
            .first()
        )

        # ── Invalid credentials ─────────────────────────────────────────────
        if row is None or not verify_password(
            payload.password, str(row["password_hash"])
        ):
            append_operation_audit_log(
                db,
                action="auth.login.failed",
                target_type="user_account",
                operator=payload.email.strip().lower(),
                result="failure",
                error_message="Invalid credentials",
                request=request,
            )
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
            )

        # ── Account disabled ───────────────────────────────────────────────
        if not bool(row["is_active"]):
            append_operation_audit_log(
                db,
                action="auth.login.account_disabled",
                target_type="user_account",
                target_id=str(row["id"]),
                operator=str(row["email"]),
                result="failure",
                error_message="Account disabled",
                request=request,
            )
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Account disabled"
            )

        # ── Login success ───────────────────────────────────────────────────
        append_operation_audit_log(
            db,
            action="auth.login.success",
            target_type="user_account",
            target_id=str(row["id"]),
            operator=str(row["email"]),
            result="success",
            request=request,
        )
        db.commit()

        # Clear failed-attempt counter on successful login
        clear_key("login_email_fail", payload.email.strip().lower())

        # Create session in Redis
        session_id = uuid4().hex
        try:
            write_session(str(row["id"]), session_id)
        except Exception:
            pass  # Redis unavailable — degrade gracefully, session check will be skipped

        # BLF-711 / BLF-1059：登录按 (账号, 设备槽) 下发专属 API key（桌面端不再
        # 依赖 BELIEVEBOY_TOKEN）。轮换语义限定在本槽：同槽重登旧 key 立即失效、
        # 返回新明文——hash-only 存储下无法回显旧明文。不带 X-Client-Id 的调用方
        # 落 default 槽，行为与拆分前一致。数据库异常不阻断登录（桌面端仍有主 key
        # 兜底路径），降级为 api_key=""。
        api_key = ""
        try:
            _, api_key = ensure_user_api_key(db, str(row["id"]), client_id)
            db.commit()
        except Exception:
            db.rollback()

        return LoginResponse(
            id=str(row["id"]),
            name=str(row["name"]),
            email=str(row["email"]),
            operator_name_zh=(
                str(row["operator_name_zh"])
                if row["operator_name_zh"] is not None
                else None
            ),
            is_admin=bool(row["is_admin"]),
            is_active=bool(row["is_active"]),
            role_type=UserRoleType(row["role_type"])
            if row["role_type"]
            else (UserRoleType.admin if row["is_admin"] else UserRoleType.operator),
            session_id=session_id,
            api_key=api_key,
        )
    finally:
        db.close()


@router.get("/me", response_model=MeResponse)
def get_current_user(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> MeResponse:
    if not x_user_id or not x_user_email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    db: Session = SessionLocal()
    try:
        row = (
            db.execute(
                text("""
                select
                  id::text as id,
                  name,
                  email,
                  operator_name_zh,
                  is_admin,
                  is_active,
                  role_type,
                  password_changed_at
                from public.user_accounts
                where id::text = :user_id and lower(email) = lower(:email)
                limit 1
            """),
                {"user_id": x_user_id, "email": unquote(x_user_email)},
            )
            .mappings()
            .first()
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
            )

        # Account disabled → revoke all sessions and reject
        if not bool(row["is_active"]):
            try:
                delete_user_sessions(x_user_id)
            except Exception:
                pass
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Account disabled"
            )

        # Validate session in Redis (sliding window)
        if x_session_id:
            try:
                if not validate_session(x_user_id, x_session_id):
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Session revoked",
                    )
            except HTTPException:
                raise
            except Exception:
                pass  # Redis unavailable — degrade gracefully

        return MeResponse(
            id=str(row["id"]),
            email=str(row["email"]),
            name=str(row["name"]),
            operator_name_zh=(
                str(row["operator_name_zh"]) if row["operator_name_zh"] else None
            ),
            is_admin=bool(row["is_admin"]),
            is_active=bool(row["is_active"]),
            role_type=UserRoleType(row["role_type"])
            if row["role_type"]
            else (UserRoleType.admin if row["is_admin"] else UserRoleType.operator),
            password_changed_at=(
                str(row["password_changed_at"]) if row["password_changed_at"] else None
            ),
        )
    finally:
        db.close()
