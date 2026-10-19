import logging
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
from app.services.rate_limit_service import (
    clear_login_failures,
    release_attempt,
    reserve_attempt,
)
from app.services.user_api_key_service import ensure_user_api_key, normalize_client_id

router = APIRouter(prefix="/auth", tags=["auth"])

logger = logging.getLogger(__name__)

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


def _reserve_login_attempts(
    request: Request, email: str
) -> tuple[bool, int, str | None, str | None]:
    """先给本次登录**原子预占**两个桶各一次额度。

    BLF-1381：过去的写法把「检查」与「记账」拆开（先 ``peek_limit``，密码错才
    ``record_attempt``），虽然修掉了「成功登录也吃额度」和「被挡请求续窗」，却
    在**并发**下漏了：同一邮箱的一批并行请求可以全部看到「桶没满」、全部跑完
    密码校验，之后才一起记账 —— 攻击者于是在任何计数生效前就试过任意多组密码。

    现在改为先原子预占：密码错就保留（和原来只计失败等价），成功 / 不构成失败
    就 ``release_attempt`` 回滚（成功仍然零消耗），超限的预占当场撤回（被挡请求
    依旧不续窗）。拿到 ``(allowed=True, 0, ip_token, email_token)`` 后，调用方
    必须在每条退出路径上调用 ``_release_login_attempts``。
    """
    ip = _get_client_ip(request)
    ip_ok, ip_retry, ip_token = reserve_attempt(
        "login_ip", ip, LOGIN_IP_RATE_MAX, LOGIN_IP_RATE_WINDOW
    )
    if not ip_ok:
        return False, ip_retry, None, None

    email_key = email.strip().lower()
    email_ok, email_retry, email_token = reserve_attempt(
        "login_email_fail",
        email_key,
        LOGIN_EMAIL_FAILED_MAX,
        LOGIN_EMAIL_FAILED_WINDOW,
    )
    if not email_ok:
        # 邮箱桶满了：把刚占的 IP 额度退回去，别让被挡的请求消耗 IP 配额。
        release_attempt("login_ip", ip, ip_token, LOGIN_IP_RATE_WINDOW)
        return False, email_retry, None, None

    return True, 0, ip_token, email_token


def _release_login_attempts(
    request: Request,
    email: str,
    ip_token: str | None,
    email_token: str | None,
) -> None:
    """回滚**非失败**场景（密码对 / 账号停用 / 内部错误）预占的额度。

    密码错时不要调本函数：那正是要计数的那一次。成功路径上邮箱桶已被
    ``clear_login_failures`` 整桶清空，这里的 email 回滚退化为空操作。
    """
    if ip_token:
        release_attempt(
            "login_ip", _get_client_ip(request), ip_token, LOGIN_IP_RATE_WINDOW
        )
    if email_token:
        release_attempt(
            "login_email_fail",
            email.strip().lower(),
            email_token,
            LOGIN_EMAIL_FAILED_WINDOW,
        )


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

    # ── Rate limit check ──────────────────────────────────────────────────────
    # BLF-1381：先原子预占两个桶各一次额度 —— 并发批次到不了密码校验就把上限打满。
    allowed, retry_after, ip_token, email_token = _reserve_login_attempts(
        request, payload.email
    )
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
    # 预占只在「密码错」这一条路径上留下；其余（成功 / 停用 / 意外异常）都退回。
    count_as_failure = False
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
            # 保留本次预占：失败是通往攻击的唯一路径，这一笔就该计数。
            count_as_failure = True
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
            # 密码是对的，不算爆破：预占在 finally 里退回。
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
        clear_login_failures(payload.email)

        # Create session in Redis
        session_id = uuid4().hex
        try:
            write_session(str(row["id"]), session_id)
        except Exception:
            # Redis 不可用时降级：会话校验被跳过，登录本身不该因此失败。
            logger.warning("write_session failed user_id=%s", row["id"], exc_info=True)

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
        # 成功登录零消耗：非「密码错」路径都把预占退回去（只退一次，由本处统一负责）。
        if not count_as_failure:
            _release_login_attempts(request, payload.email, ip_token, email_token)


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
                logger.warning(
                    "delete_user_sessions failed on disabled account user_id=%s",
                    x_user_id,
                    exc_info=True,
                )
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
                # Redis 不可用 → 降级放行（不能因为缓存挂了把所有人踢下线）。
                logger.warning(
                    "validate_session failed user_id=%s", x_user_id, exc_info=True
                )

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
