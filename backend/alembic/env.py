from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool, create_engine

from app.core.config import get_settings
from app.db.session import Base
from app.models import (  # noqa: F401
    AIConversation,
    AIMessage,
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPT1Calculation,
    AnalysisPaymentRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    Job,
    JobRun,
    ExchangeRate,
    ProductCost,
    Project,
)

config = context.config
settings = get_settings()

# 设置数据库 URL（使用 %% 转义 % 字符以兼容 ConfigParser）
database_url_escaped = settings.database_url.replace('%', '%%')
config.set_main_option('sqlalchemy.url', database_url_escaped)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option('sqlalchemy.url')
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={'paramstyle': 'named'},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix='sqlalchemy.',
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
