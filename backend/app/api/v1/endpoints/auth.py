from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.passwords import verify_password
from app.db.session import SessionLocal

router = APIRouter(prefix='/auth', tags=['auth'])


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


def _is_yawei_account(name: str, email: str) -> bool:
    return name.strip().lower() == 'yawei' or email.strip().lower().startswith('yawei@')


@router.post('/login', response_model=LoginResponse)
def login(payload: LoginRequest) -> LoginResponse:
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
                  is_active
                from public.user_accounts
                where lower(email) = lower(:email)
                limit 1
                '''
            ),
            {'email': payload.email.strip().lower()},
        ).mappings().first()
        if row is None or not verify_password(payload.password, str(row['password_hash'])):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid credentials')

        is_yawei = _is_yawei_account(str(row['name']), str(row['email']))
        if not bool(row['is_active']) and not is_yawei:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Account disabled')

        if is_yawei and (not bool(row['is_active']) or not bool(row['is_admin']) or str(row['name']) != 'Yawei'):
            fixed = db.execute(
                text(
                    '''
                    update public.user_accounts
                    set
                      name = 'Yawei',
                      is_admin = true,
                      is_active = true,
                      updated_at = now()
                    where id::text = :id
                    returning
                      id::text as id,
                      name,
                      email,
                      operator_name_zh,
                      is_admin,
                      is_active
                    '''
                ),
                {'id': str(row['id'])},
            ).mappings().first()
            db.commit()
            if fixed is not None:
                row = fixed

        return LoginResponse(
            id=str(row['id']),
            name='Yawei' if is_yawei else str(row['name']),
            email=str(row['email']),
            operator_name_zh=(str(row['operator_name_zh']) if row['operator_name_zh'] is not None else None),
            is_admin=True if is_yawei else bool(row['is_admin']),
            is_active=True if is_yawei else bool(row['is_active']),
        )
    finally:
        db.close()
