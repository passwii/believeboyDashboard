from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
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
from app.services.rate_limit_service import clear_key, increment_and_check

router = APIRouter(prefix='/auth', tags=['auth'])

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

    _, ip_retry = increment_and_check("login_ip", ip, LOGIN_IP_RATE_MAX, LOGIN_IP_RATE_WINDOW)
    if ip_retry > 0:
        return False, ip_retry

    email_key = email.strip().lower()
    _, email_retry = increment_and_check(
        "login_email_fail", email_key, LOGIN_EMAIL_FAILED_MAX, LOGIN_EMAIL_FAILED_WINDOW
    )
    if email_retry > 0:
        return False, email_retry

    return True, 0


@router.post('/login', response_model=LoginResponse)
def login(request: Request, payload: LoginRequest) -> LoginResponse | JSONResponse:
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
        row = db.execute(
            text(
                '''
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
                '''
            ),
            {'email': payload.email.strip().lower()},
        ).mappings().first()

        # ── Invalid credentials ─────────────────────────────────────────────
        if row is None or not verify_password(payload.password, str(row['password_hash'])):
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
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid credentials')

        # ── Account disabled ───────────────────────────────────────────────
        if not bool(row['is_active']):
            append_operation_audit_log(
                db,
                action="auth.login.account_disabled",
                target_type="user_account",
                target_id=str(row['id']),
                operator=str(row['email']),
                result="failure",
                error_message="Account disabled",
                request=request,
            )
            db.commit()
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Account disabled')

        # ── Login success ───────────────────────────────────────────────────
        append_operation_audit_log(
            db,
            action="auth.login.success",
            target_type="user_account",
            target_id=str(row['id']),
            operator=str(row['email']),
            result="success",
            request=request,
        )
        db.commit()

        # Clear failed-attempt counter on successful login
        clear_key("login_email_fail", payload.email.strip().lower())

        return LoginResponse(
            id=str(row['id']),
            name=str(row['name']),
            email=str(row['email']),
            operator_name_zh=(str(row['operator_name_zh']) if row['operator_name_zh'] is not None else None),
            is_admin=bool(row['is_admin']),
            is_active=bool(row['is_active']),
            role_type=UserRoleType(row['role_type']) if row['role_type'] else (UserRoleType.admin if row['is_admin'] else UserRoleType.operator),
        )
    finally:
        db.close()


@router.get("/me", response_model=MeResponse)
def get_current_user(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> MeResponse:
    if not x_user_id or not x_user_email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    db: Session = SessionLocal()
    try:
        row = db.execute(
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
        ).mappings().first()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        return MeResponse(
            id=str(row["id"]),
            email=str(row["email"]),
            name=str(row["name"]),
            operator_name_zh=(str(row["operator_name_zh"]) if row["operator_name_zh"] else None),
            is_admin=bool(row["is_admin"]),
            is_active=bool(row["is_active"]),
            role_type=UserRoleType(row["role_type"]) if row["role_type"] else (UserRoleType.admin if row["is_admin"] else UserRoleType.operator),
            password_changed_at=(str(row["password_changed_at"]) if row["password_changed_at"] else None),
        )
    finally:
        db.close()
