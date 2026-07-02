"""Configuration for the auto-report-upload service."""

import os
import sys
from pathlib import Path


def _require_api_config() -> tuple[str, str]:
    """Resolve API_BASE_URL and INTERNAL_INGEST_TOKEN from the environment.

    Both are required — there is no IP fallback on purpose. See BEL-75.
    Production endpoints move over time and the source of truth must be
    the runtime environment, not this file.
    """
    base_url = os.environ.get("API_BASE_URL", "").strip()
    token = os.environ.get("INTERNAL_INGEST_TOKEN", "").strip()

    # autoReportUpload/.env is auto-loaded if python-dotenv is available.
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).parent / ".env"
        if env_path.exists():
            load_dotenv(env_path, override=False)
            if not base_url:
                base_url = os.environ.get("API_BASE_URL", "").strip()
            if not token:
                token = os.environ.get("INTERNAL_INGEST_TOKEN", "").strip()
    except ImportError:
        pass

    if not base_url or not token:
        print(
            "错误: 未配置 API_BASE_URL 或 INTERNAL_INGEST_TOKEN。\n"
            "  请在 autoReportUpload/.env 写入:\n"
            "    API_BASE_URL=https://dash-api.believeboy.com\n"
            "    INTERNAL_INGEST_TOKEN=<32 字节随机串>\n"
            "  或在启动前 export 这两个变量。",
            file=sys.stderr,
        )
        sys.exit(1)
    return base_url, token


API_BASE_URL, INTERNAL_INGEST_TOKEN = _require_api_config()


# ─── Watch root (unchanged) ───────────────────────────────────────────────────
WATCH_ROOT_DEFAULT = Path("/Users/damon/Documents/RPA")


def _resolve_watch_root() -> Path:
    env_path = os.environ.get("WATCH_ROOT", "").strip()
    if env_path:
        return Path(env_path)
    return WATCH_ROOT_DEFAULT


WATCH_ROOT = _resolve_watch_root()

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
    "瑞迪特",
]

CHECK_INTERVAL_MINUTES = 5
PROCESSED_SUBDIR = "processed"
AD_PROCESSED_SUBDIR = "广告Processed"
IGNORED_DIRS = {"sync.ffs_db"}
SUPPORTED_EXTENSIONS = {".txt", ".csv", ".xlsx"}