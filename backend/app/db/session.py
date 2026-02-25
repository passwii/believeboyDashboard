from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()

# 根据数据库类型设置连接参数
if settings.database_url.startswith('sqlite'):
    connect_args = {'check_same_thread': False}
else:
    # PostgreSQL/Supabase 连接参数
    # 注意: sslmode=require 是 Supabase 必需的
    connect_args = {
        'connect_timeout': 60,
        'options': '-c statement_timeout=120s',
        'sslmode': 'require'
    }

engine = create_engine(
    settings.database_url,
    future=True,
    pool_pre_ping=True,
    connect_args=connect_args
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
