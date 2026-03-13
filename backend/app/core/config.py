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

    database_url: str = Field(min_length=1)
    api_key: str = Field(default='change-me', min_length=8)

    upload_root: Path = Path(__file__).resolve().parents[2] / 'storage' / 'uploads'
    result_root: Path = Path(__file__).resolve().parents[2] / 'storage' / 'results'

    max_upload_bytes: int = 50 * 1024 * 1024
    allowed_upload_extensions: set[str] = {'.txt', '.csv', '.xlsx', '.pdf'}
    allowed_content_types: set[str] = {
        'text/plain',
        'text/csv',
        'application/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/pdf',
        'application/octet-stream',
    }


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)
    return settings
