"""清理过期的 CRM 方案分段上传临时目录。

用法：
    cd backend && .venv/bin/python scripts/cleanup_crm_proposal_upload_temp.py

建议每小时 cron 一次；``init_upload`` 也会做一次惰性清理兜底。
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.core.config import get_settings  # noqa: E402
from app.services.crm.proposal_chunked_upload import cleanup_expired  # noqa: E402


def main() -> int:
    removed = cleanup_expired(get_settings())
    print(f"removed {removed} expired CRM proposal upload dirs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
