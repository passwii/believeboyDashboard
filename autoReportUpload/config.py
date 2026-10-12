"""Configuration for the auto-report-upload service."""

import os
import sys
from pathlib import Path


def _require_database_url() -> str:
    """Resolve DATABASE_URL strictly from the environment.

    No IP fallback on purpose — see [BEL-75]. Production endpoints move over
    time and the source of truth must be the runtime environment, not this
    file. Operators should export DATABASE_URL (or place it in
    ``autoReportUpload/.env``) before starting the service.

    ``autoReportUpload/.env`` is auto-loaded if ``python-dotenv`` is
    available; otherwise the variable must come from the shell.
    """
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        try:
            from dotenv import load_dotenv

            env_path = Path(__file__).parent / ".env"
            if env_path.exists():
                load_dotenv(env_path, override=False)
                url = os.environ.get("DATABASE_URL", "").strip()
        except ImportError:
            pass
    if not url:
        print(
            "错误: 未配置 DATABASE_URL。\n"
            "  请在 autoReportUpload/.env 写入 DATABASE_URL=postgresql+psycopg://<user>:<pass>@<host>:<port>/<db>\n"
            "  或在启动前 export DATABASE_URL=...。\n"
            "  此项目不再在源码中硬编码任何生产端 IP。",
            file=sys.stderr,
        )
        sys.exit(1)
    return url


# Ensure DATABASE_URL is visible to backend Pydantic Settings (which only
# reads os.environ, not Python module-level variables) once the URL has
# been resolved above.
DATABASE_URL = _require_database_url()
os.environ["DATABASE_URL"] = DATABASE_URL

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
    "卡斯摩",
    "创酷",
    "吕沃",
    "铨富",
    "骏成",
    "华洋泛航",
    "玥涵",
    "犀牛",
    # 2026-06-27 增量：瑞迪特（WESTTHOR）— 之前未在白名单导致新订单无法入库
    "瑞迪特",
]

# Country site subfolders under each project folder. A file placed in either
# the project root or one of these subfolders belongs to the same project;
# the subfolder marks the country site (e.g. "美国" = US). Only 美国 exists
# for now — add new entries here when other country sites land.
COUNTRY_SUBFOLDERS: frozenset[str] = frozenset({"美国"})


def resolve_project_dir(file_path: Path) -> Path:
    """Resolve the project root dir for a file, handling country subfolders.

    ``<project>/a.csv``            -> ``<project>``
    ``<project>/美国/a.csv``        -> ``<project>``
    """
    parent = file_path.parent
    if parent.name in COUNTRY_SUBFOLDERS:
        return parent.parent
    return parent


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
# DATABASE_URL is resolved at module load time from the environment only
# (see _require_database_url() above). Callers should import it like:
#     from config import DATABASE_URL
# It is intentionally NOT a hardcoded fallback — see [BEL-75].
