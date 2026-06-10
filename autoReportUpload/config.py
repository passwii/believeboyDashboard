"""Configuration for the auto-report-upload service."""

import os
from pathlib import Path

# Ensure DATABASE_URL is available as env var — backend Pydantic Settings
# reads from os.environ, not from Python module-level variables.
# autoReportUpload used to load .env via dotenv which did this implicitly.
_DB_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg://damon:jrway2012@192.168.100.113:5432/BLF",
)
os.environ.setdefault("DATABASE_URL", _DB_URL)

# ─── Watch root ───────────────────────────────────────────────────────────────
# 本地磁盘根目录 — 子文件夹以各项目命名
WATCH_ROOT_DEFAULT = Path("/Users/damon/Documents/RPA")

# 环境变量 WATCH_ROOT 优先，否则用默认路径
def _resolve_watch_root() -> Path:
    env_path = os.environ.get("WATCH_ROOT", "").strip()
    if env_path:
        return Path(env_path)
    return WATCH_ROOT_DEFAULT

WATCH_ROOT = _resolve_watch_root()

# All project folder names (must match projects.project_name in the DB)
PROJECTS = [
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

# Ad reports use a dedicated archive folder so 10 ad subtypes (promoted
# product / campaign / placement / etc.) stay separate from general reports.
# 10 ad subtypes are recognized by ``app.services.ad.upload.specs.REPORT_SPECS``.
AD_PROCESSED_SUBDIR = "广告Processed"

# Folder names to ignore entirely
IGNORED_DIRS = {"sync.ffs_db"}

# File extensions the service cares about
SUPPORTED_EXTENSIONS = {".txt", ".csv", ".xlsx"}

# ─── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL = _DB_URL
