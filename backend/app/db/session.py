from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()

database_url_lower = settings.database_url.lower()

# 根据数据库类型设置连接参数
if database_url_lower.startswith('sqlite'):
    connect_args = {'check_same_thread': False}
else:
    # PostgreSQL 连接参数
    connect_args = {
        'connect_timeout': 60,
        'options': '-c statement_timeout=120s',
    }
    # 仅在明确要求 SSL 或使用 Supabase 域名时启用 SSL。
    if 'sslmode=require' in database_url_lower or 'supabase.co' in database_url_lower:
        connect_args['sslmode'] = 'require'

engine = create_engine(
    settings.database_url,
    future=True,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    pool_size=5,
    max_overflow=10,
    pool_use_lifo=True,
    connect_args=connect_args
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
