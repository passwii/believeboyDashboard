"""Agent SKU Info 主数据域收口测试（BLF-582）。

BLF-584（PR #233）已上线 SKU Info 全量域（R1 列表 / R2 详情 / R3 审计 +
W1-W3 写，``tests/api/agent/test_sku_info.py`` 37 条覆盖 R1 parity / 鉴权 /
scope 门禁 / 镜像排除）。本文件只保留 **BLF-584 未覆盖** 的收口断言：

* ``external/sku_info.py`` 端点模块删除（BLF-584 未删该模块，BLF-582 收口）。
"""

from __future__ import annotations

import pytest


def test_external_sku_info_module_deleted():
    """external/sku_info.py 端点模块已删除：import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.sku_info  # noqa: F401
