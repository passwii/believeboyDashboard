"""Configuration for the auto-report-upload service."""

import os
import platform
from pathlib import Path

# ─── Environment selection ────────────────────────────────────────────────────
# Set AUTO_REPORT_ENV to "local" or "production" (defaults to "production")
# - local:      uses localhost DB, localhost API, does NOT move files to processed/
# - production: uses remote DB / API, moves files to processed/ after ingestion
ENV = os.environ.get("AUTO_REPORT_ENV", "production").lower().strip()
IS_LOCAL = ENV == "local"
IS_PRODUCTION = ENV == "production"

# ─── Platform detection ────────────────────────────────────────────────────────
IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"

# OneDrive sync root — contains sub-folders named after each project
# macOS: iCloud/OneDrive local sync folder
WATCH_ROOT_MAC = Path(
    "/Users/damon/Library/CloudStorage/OneDrive-BelieveboysTeam/"
    "BLF-运营中心 - 文档/W_Sync_Docs"
)

# Windows: OneDrive local sync folder (EDY's machine)
WATCH_ROOT_WINDOWS = Path(
    r"C:\Users\EDY\OneDrive - Believeboys Team\BLF-运营中心 - 文档\W_Sync_Docs"
)

# Auto-select based on platform; env var overrides everything
def _resolve_watch_root() -> Path:
    env_path = os.environ.get("WATCH_ROOT", "").strip()
    if env_path:
        return Path(env_path)
    if IS_WINDOWS:
        return WATCH_ROOT_WINDOWS
    return WATCH_ROOT_MAC

WATCH_ROOT = _resolve_watch_root()

# All project folder names (must match projects.project_name in the DB)
PROJECTS = [
    "润茗",
    "博朗姆",
    "金石",
    "弥森",
    "卡斯摩",
    "创酷",
    "吕沃",
    "铨富",
    "骏成",
    "华洋泛航",
    "玥涵",
    "博智1店",
    "博智2店",
    "犀牛",
]

# How often (in minutes) the monitor loop checks for new files
CHECK_INTERVAL_MINUTES = 5

# Sub-folder under each project folder where processed files are moved
PROCESSED_SUBDIR = "processed"

# Folder names to ignore entirely
IGNORED_DIRS = {"sync.ffs_db"}

# File extensions the service cares about
SUPPORTED_EXTENSIONS = {".txt", ".csv", ".xlsx"}

# ─── Environment-specific defaults ────────────────────────────────────────────
LOCAL_DATABASE_URL = "postgresql+psycopg://damon:jrway2012@localhost:5432/BLF"
LOCAL_API_BASE = "http://127.0.0.1:8000"

PROD_DATABASE_URL = "postgresql+psycopg://damon:jrway2012@145.79.143.98:5432/BLF"
PROD_API_BASE = os.environ.get("BACKEND_API_BASE", "http://145.79.143.98:8000")

# Resolved configs (env vars override everything)
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    LOCAL_DATABASE_URL if IS_LOCAL else PROD_DATABASE_URL,
)
API_BASE = os.environ.get(
    "BACKEND_API_BASE",
    LOCAL_API_BASE if IS_LOCAL else PROD_API_BASE,
)
