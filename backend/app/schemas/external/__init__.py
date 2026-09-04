"""Shared Pydantic schemas for the agent + internal read-query layer.

原 external 命名空间的共享 schema（external 机制已退役删除，BLF-583），
路径保留作为历史遗留共享层，供 agent 原生域与 internal 端点复用。
"""

from app.schemas.external.ad_raw import *  # noqa: F403,F401
from app.schemas.external.aggregate import *  # noqa: F403,F401
from app.schemas.external.common import *  # noqa: F403,F401
from app.schemas.external.orders_summary import *  # noqa: F403,F401
from app.schemas.external.projects import *  # noqa: F403,F401
