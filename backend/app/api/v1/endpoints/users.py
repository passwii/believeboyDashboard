from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected

router = APIRouter(prefix='/system-management/users', tags=['users'], dependencies=[Depends(protected)])


class UserItem(BaseModel):
    id: str
    name: str
    email: str
    operator_name_zh: str | None = None
    is_admin: bool
    is_active: bool
    created_at: str
    updated_at: str


class UsersResponse(BaseModel):
    items: list[UserItem]


class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    email: str = Field(min_length=3, max_length=255)
    operator_name_zh: str | None = Field(default=None, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    is_admin: bool = False


class CreateUserResponse(BaseModel):
    item: UserItem


class UpdateUserRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    operator_name_zh: str | None = Field(default=None, max_length=255)
    is_admin: bool | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)


class UpdateUserResponse(BaseModel):
    item: UserItem


def _is_yawei_account(name: str, email: str) -> bool:
    return name.strip().lower() == 'yawei' or email.strip().lower().startswith('yawei@')


def _ensure_pgcrypto(db: Session) -> None:
    try:
        db.execute(text("create extension if not exists pgcrypto"))
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail='数据库缺少 pgcrypto 扩展，且自动启用失败',
        )


def _to_item(row: dict) -> UserItem:
    is_yawei = _is_yawei_account(str(row['name']), str(row['email']))
    return UserItem(
        id=str(row['id']),
        name='Yawei' if is_yawei else str(row['name']),
        email=str(row['email']),
        operator_name_zh=(str(row['operator_name_zh']) if row['operator_name_zh'] is not None else None),
        is_admin=True if is_yawei else bool(row['is_admin']),
        is_active=True if is_yawei else bool(row['is_active']),
        created_at=str(row['created_at']),
        updated_at=str(row['updated_at']),
    )


@router.get('', response_model=UsersResponse)
def list_users(db: Session = Depends(get_db_session)) -> UsersResponse:
    rows = db.execute(
        text(
            '''
            select
              id::text as id,
              name,
              email,
              operator_name_zh,
              is_admin,
              is_active,
              created_at,
              updated_at
            from public.user_accounts
            order by created_at desc
            '''
        )
    ).mappings().all()
    return UsersResponse(items=[_to_item(row) for row in rows])


@router.post('', response_model=CreateUserResponse, status_code=status.HTTP_201_CREATED)
def create_user(payload: CreateUserRequest, db: Session = Depends(get_db_session)) -> CreateUserResponse:
    _ensure_pgcrypto(db)
    try:
        row = db.execute(
            text(
                '''
                insert into public.user_accounts (name, email, operator_name_zh, password_hash, is_admin, is_active)
                values (:name, :email, :operator_name_zh, crypt(:password, gen_salt('bf', 12)), :is_admin, true)
                returning
                  id::text as id,
                  name,
                  email,
                  operator_name_zh,
                  is_admin,
                  is_active,
                  created_at,
                  updated_at
                '''
            ),
            {
                'name': payload.name.strip(),
                'email': payload.email.strip().lower(),
                'operator_name_zh': payload.operator_name_zh.strip() if payload.operator_name_zh else None,
                'password': payload.password,
                'is_admin': bool(payload.is_admin),
            },
        ).mappings().first()
        db.commit()
    except Exception as exc:
        db.rollback()
        if getattr(exc, 'orig', None) is not None and 'duplicate key value' in str(exc.orig).lower():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='邮箱已存在')
        if 'duplicate key value' in str(exc).lower():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='邮箱已存在')
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail='创建用户失败')

    if row is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail='创建用户失败')
    return CreateUserResponse(item=_to_item(row))


@router.patch('/{user_id}', response_model=UpdateUserResponse)
def update_user(user_id: str, payload: UpdateUserRequest, db: Session = Depends(get_db_session)) -> UpdateUserResponse:
    _ensure_pgcrypto(db)
    name = payload.name.strip() if isinstance(payload.name, str) else None
    operator_name_zh = payload.operator_name_zh.strip() if isinstance(payload.operator_name_zh, str) else None
    is_admin = payload.is_admin if isinstance(payload.is_admin, bool) else None
    is_active = payload.is_active if isinstance(payload.is_active, bool) else None
    password = payload.password if isinstance(payload.password, str) and payload.password else None

    row = db.execute(
        text(
            '''
            update public.user_accounts
            set
              name = case
                when lower(email) like 'yawei@%' or lower(name) = 'yawei' then 'Yawei'
                else coalesce(:name, name)
              end,
              is_admin = case
                when lower(email) like 'yawei@%' or lower(name) = 'yawei' then true
                else coalesce(:is_admin, is_admin)
              end,
              is_active = case
                when lower(email) like 'yawei@%' or lower(name) = 'yawei' then true
                else coalesce(:is_active, is_active)
              end,
              operator_name_zh = coalesce(:operator_name_zh, operator_name_zh),
              password_hash = case
                when :password is null then password_hash
                else crypt(:password, gen_salt('bf', 12))
              end,
              updated_at = now()
            where id::text = :user_id
            returning
              id::text as id,
              name,
              email,
              operator_name_zh,
              is_admin,
              is_active,
              created_at,
              updated_at
            '''
        ),
        {
            'user_id': user_id,
            'name': name,
            'operator_name_zh': operator_name_zh,
            'is_admin': is_admin,
            'is_active': is_active,
            'password': password,
        },
    ).mappings().first()
    db.commit()

    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='用户不存在')
    return UpdateUserResponse(item=_to_item(row))
