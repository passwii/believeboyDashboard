from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[2] / '.env'


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(ENV_FILE), env_file_encoding='utf-8', extra='ignore')

    app_name: str = 'believeboy-backend'
    app_env: str = 'development'
    app_host: str = '0.0.0.0'
    app_port: int = 8000

    database_url: str = 'sqlite:///./backend.db'
    redis_url: str = 'redis://localhost:6379/0'
    product_cost_list_cache_ttl_seconds: int = 72 * 60 * 60
    product_cost_cache_sqlite_path: Path = Path('./storage/cache/query_cache.db')
    api_key: str = Field(default='change-me', min_length=8)

    upload_root: Path = Path('./storage/uploads')
    result_root: Path = Path('./storage/results')

    max_upload_bytes: int = 50 * 1024 * 1024
    allowed_upload_extensions: set[str] = {'.txt', '.csv', '.xlsx'}
    allowed_content_types: set[str] = {
        'text/plain',
        'text/csv',
        'application/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream',
    }


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)
    settings.product_cost_cache_sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    return settings
