"""共享 JSON 序列化工具。

集中处理 ``date`` / ``datetime`` / ``Decimal`` / ``UUID`` 等非原生 JSON
类型,避免各缓存模块重复实现一个自己的 ``_json_serializer``(``P0-2``)。

为什么不直接 ``json.dumps(value, default=str)`` —— 那会把 ``Decimal``
转成字符串而不是保留数值精度,会改变下游读取方的行为。我们只把真正
不可序列化的类型分派给 ``str()``,而 ``Decimal`` 走 ``float`` 转回。

如果将来需要支持其他 ORM 类型(``UUID`` / ``Enum`` 等),在 ``_default``
里加一个分支即可,各调用方会自动受益。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any


def json_default(obj: Any) -> Any:
    """``json.dumps(..., default=json_default)`` 的回调。

    序列化策略:
      - ``date`` / ``datetime`` → ISO 8601 字符串(保留时区/可解析)
      - ``Decimal`` → ``float``(与现有缓存值下游用法保持一致;
        如需更高精度可改为 ``str``)
      - 其它类型 → 退回 ``str(obj)``,避免 ``TypeError`` 把请求 500
    """
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    return str(obj)
