"""classify — 词性分类器（v2.2 §5）。

8 类无词典版 + 项目 taxonomy 接入。

类型：
  asin              - ASIN 词（B0xxx 模式）
  numeric_id        - 纯数字 ID（≥3 位）
  spec_size         - 尺寸规格（含 inch / mm / cm）
  comparison        - 比较/购买阶段词（best / vs / review / cheap）
  competitor_brand  - 竞品品牌词（从 taxonomy 加载）
  attribute_modifier- 属性修饰词（材质/规格：cobalt / m35 / hss / metric...）
  scene_specific    - 场景词（metal / steel / wood / masonry...）
  category_core     - 品类核心（1-2 词，无修饰）
  long_tail         - 长尾组合（3+ 词）
  other             - 未分类
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as e:  # pragma: no cover
    raise SystemExit("PyYAML is required: pip install pyyaml") from e


# ── 默认词典（无项目 taxonomy 时使用） ──
DEFAULT_ATTR_KW = frozenset({
    # 材质/规格
    "cobalt", "m35", "m42", "hss", "metric", "fractional", "titanium", "carbide",
    "hex", "shank", "tapered", "step", "twist", "center", "spot", "index",
    "jobber", "auger", "forstner", "point", "split",
    # 尺寸
    "large", "small", "mini", "long", "short", "thick", "thin", "heavy",
    # 颜色/外观
    "black", "gold", "silver", "diamond", "oxide",
})

DEFAULT_SCENE_KW = frozenset({
    "metal", "steel", "stainless", "aluminum", "wood", "masonry", "concrete",
    "plastic", "hardened", "iron", "brass", "copper", "alloy",
})

DEFAULT_BRAND_KW = frozenset({
    "dewalt", "milwaukee", "bosch", "makita", "ryobi", "irwin", "hilti", "klein",
    "drill hog", "neiko", "snadico", "kreg", "titan", "workpro", "craftsman",
})

DEFAULT_COMP_KW = frozenset({
    " vs ", " review", " best ", " top ", " cheap", " quality",
    " professional", " pro ",
})


class TermClassifier:
    """词性分类器，支持项目级 taxonomy 覆盖。"""

    def __init__(self, taxonomy: dict[str, Any] | None = None):
        """构造分类器。

        Args:
            taxonomy: 项目级 taxonomy dict（来自 4-yuehan-taxonomy.yaml），可空
        """
        tax = taxonomy or {}
        self.brand_self = frozenset(tax.get("brand_self", []))
        self.competitors = frozenset(tax.get("competitors", [])) or DEFAULT_BRAND_KW
        # 同义词展开（如 cobalt → [cobolt, coblat]）
        syn = tax.get("material_synonyms", {})
        attr = set(DEFAULT_ATTR_KW)
        for canon, variants in syn.items():
            attr.add(canon)
            for v in variants:
                attr.add(v)
        self.attr_kw = frozenset(attr)
        self.scene_kw = DEFAULT_SCENE_KW
        self.comp_kw = DEFAULT_COMP_KW
        # 项目专属 scene（drill_bits 加 hardened 等）
        project_scene = tax.get("project_specific", {}).get("scene_words", [])
        if project_scene:
            self.scene_kw = frozenset(DEFAULT_SCENE_KW | set(project_scene))

    def classify(self, term: str | None) -> str:
        """分类一个搜索词。"""
        if not term:
            return "other"
        t = term.lower().strip()
        padded = f" {t} "
        n = len(t.split())

        # 1. ASIN 词（B0xxx 8位）
        if re.match(r"^b0[a-z0-9]{8}$", t):
            return "asin"
        # 2. 纯数字 ID
        if re.match(r"^\d{3,}$", t):
            return "numeric_id"
        # 3. 尺寸规格
        if re.match(r'''^\d+["'\u201d\u2019/]''', t) or re.match(r"^\d+\s*(inch|mm|cm|in)\b", t):
            return "spec_size"
        # 4. 比较/购买阶段
        if any(kw in padded for kw in self.comp_kw) or any(
            t.startswith(kw.strip()) for kw in ["best", "top"]
        ):
            return "comparison"
        # 5. 自有品牌 / 竞品品牌
        brand_all = self.brand_self | self.competitors
        if any(b in padded for b in brand_all):
            return "competitor_brand"
        # 6. 属性修饰
        if any(k in padded for k in self.attr_kw):
            return "attribute_modifier"
        # 7. 场景词
        if any(k in padded for k in self.scene_kw):
            return "scene_specific"
        # 8. 短品类核心
        if n <= 2:
            return "category_core"
        # 9. 长尾组合
        if n >= 3:
            return "long_tail"
        return "other"


_default_classifier: TermClassifier | None = None


def get_classifier(project_id: int | None = None) -> TermClassifier:
    """获取分类器（单例 + 缓存）。"""
    global _default_classifier
    if _default_classifier is not None:
        return _default_classifier
    taxonomy = None
    if project_id is not None:
        try:
            from . import load_data
            cfg = load_data.load_config(project_id)
            taxonomy = cfg.get("taxonomy")
        except Exception:
            taxonomy = None
    _default_classifier = TermClassifier(taxonomy)
    return _default_classifier


def classify(term: str | None, project_id: int | None = None) -> str:
    """便捷函数：分类一个搜索词。"""
    return get_classifier(project_id).classify(term)


if __name__ == "__main__":
    # 自检（期望与 classify() 规则一致：n≤2 → category_core；n≥3 → long_tail；
    # 含 ATTR_KW → attribute_modifier 先于 scene_specific 命中）
    samples = [
        ("cobalt drill bit sets", "attribute_modifier"),
        ("b0drcc3hz3", "asin"),
        ("milwaukee drill bits", "competitor_brand"),
        ("drill bit", "category_core"),               # n=2
        ("115 cobalt drill bit set", "attribute_modifier"),
        ("best drill bits", "comparison"),
        ("1 inch drill bit", "spec_size"),
        ("drill bits for metal", "scene_specific"),
        ("metalworking & multipurpose drill sets", "scene_specific"),
        ("drill bit set", "long_tail"),                # n=3，无属性/场景词
        ("drill bits set for metal large set", "attribute_modifier"),  # large 命中
    ]
    print("=== 词性分类自检 ===")
    cls = TermClassifier()
    passed = 0
    for term, expected in samples:
        actual = cls.classify(term)
        mark = "✓" if actual == expected else "✗"
        if actual == expected:
            passed += 1
        print(f"  {mark} '{term}' → {actual} (期望 {expected})")
    print(f"\n通过率: {passed}/{len(samples)}")