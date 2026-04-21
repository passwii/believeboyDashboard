"""Configuration for the auto-report-upload service."""

from pathlib import Path

# OneDrive sync root — contains sub-folders named after each project
WATCH_ROOT = Path(
    "/Users/damon/Library/CloudStorage/OneDrive-BelieveboysTeam/"
    "BLF-运营中心 - 文档/W_Sync_Docs"
)

# All project folder names (must match projects.project_name in the DB)
PROJECTS = [
    "润茗",
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
    "宝勒1店",
    "博智2店",
]

# How often (in minutes) the monitor loop checks for new files
CHECK_INTERVAL_MINUTES = 5

# Sub-folder under each project folder where processed files are moved
PROCESSED_SUBDIR = "processed"

# Folder names to ignore entirely
IGNORED_DIRS = {"sync.ffs_db"}

# File extensions the service cares about
SUPPORTED_EXTENSIONS = {".txt", ".csv", ".xlsx"}
