from pydantic import BaseModel


class DatabaseStatus(BaseModel):
    engine: str
    source: str | None = None
    healthy: bool
    checked_at: str


class CacheStatus(BaseModel):
    sqlite_path: str
    exists: bool
    file_size_bytes: int
    ttl_seconds: int
    total_entries: int
    expired_entries: int
    active_entries: int
    latest_updated_at: str | None = None
    nearest_expire_at: str | None = None


class DataManagementStatusResponse(BaseModel):
    server_time: str
    database: DatabaseStatus
    cache: CacheStatus


class CacheClearResponse(BaseModel):
    cleared_at: str
    removed_entries: int
