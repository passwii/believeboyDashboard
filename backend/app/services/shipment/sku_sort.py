"""SKU 排序 helper。

为 ``FBA 箱单明细`` tab 提供 SKU 排序 key：把 ``-`` 字符当成普通字符参与排序，
但优先级在字母之后、数字之后，其他完全保持 Python 默认 str 字典序。

## 规则

把 SKU 字符串里所有 ``-`` 替换为 ``\\x7f``（DEL 控制字符，ASCII 0x7F），再按
Python 默认 str 字典序排序。``\\x7f`` 位于：

- 数字 ``0-9`` 之后（``\\x7f`` > ``9``）
- 大写字母 ``A-Z`` 之后（``\\x7f`` > ``Z``）
- 小写字母 ``a-z`` 之后（``\\x7f`` > ``z``）

正常 SKU 字符串不会出现 ``\\x7f``，因此替换是安全的（不会改变原有字符顺序）。

## 等价语义

``s.replace('-', '\\x7f')`` 等价于"``-`` 按 ASCII 排序时被排在 ``Z`` 之后"，
即用户原话："把 ``-`` 当成普通字符，但优先级排在字母之后"。

## 动机

用户(2026-07-29)反馈 ``NEW-ELTB-002BEG-Q`` 这种带 ``-`` 的变体 SKU 会被排到
``NEW-ELTB-002BEGTR / TW``（无 ``-`` 的主 SKU 续段）前面，导致 FBA 标签号段不连续
（变体 SKU 的箱号会被夹在主 SKU 续段中间）。

期望顺序（``-`` 后变体沉底）::

    NEW-ELTB-002BEGTR   ← 主 SKU 续段（无 ``-``），标签号连续段优先
    NEW-ELTB-002BEGTW
    NEW-ELTB-002BEG-Q   ← 带 ``-`` 旁支，整段末尾

## 设计取舍

- **不引入数字自然序**：用户原话只提到 ``-`` 的位置，未要求 ``ABC-2`` <
  ``ABC-10``。保持 ASCII 字典序意味着 ``ABC-10`` 仍会排在 ``ABC-2`` 前——这是
  ``item.sku`` 字段的现有行为，保留以避免影响其他消费方。
- **不引入分类 token（letter/digit/dash）**：会改变同长度 SKU 的相对顺序
  （如 ``A-BC`` vs ``A-B-C``），超出用户原意。
- **保留区分大小写**：现有 ``item.sku`` 默认大小写敏感（``A`` < ``a``），不动。
"""

from __future__ import annotations

from collections.abc import Iterable

# 把 '-' 替换为 ASCII 0x7F (DEL)，使 '-' 在字典序中位于所有字母 + 数字之后。
_DASH_PLACEHOLDER = "\x7f"


def natural_sku_sort_key(sku: str) -> str:
    """返回 SKU 的排序 key，可直接传给 ``sorted(..., key=...)``。

    空字符串返回空字符串（最小），方便稳定排序。

    Args:
        sku: SKU 字符串。

    Returns:
        替换 ``-`` 为 ``\\x7f`` 后的字符串，可直接用作 dict / tuple 的比较元素。
    """
    if not sku:
        return ""
    return sku.replace("-", _DASH_PLACEHOLDER)


def sort_skus(skus: Iterable[str]) -> list[str]:
    """便捷包装：对可迭代 SKU 列表按自然序排序返回新列表。

    不修改入参。空 token（``""``）默认最小，排在最前。
    """
    return sorted(skus, key=natural_sku_sort_key)
