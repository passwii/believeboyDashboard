"""搜索源卡片 (`build_search_source_cards`) 构造测试。

覆盖：
1. score 字段为字符串（SearXNG Tavily adapter 实际返回格式）→ 解析为 float
2. score 字段为 int/float → 保持 float
3. score 字段缺失 / 无效字符串 / None → None
4. url 缺失 → 跳过该 result
5. title 缺失 → "未命名结果"
6. content / raw_content → snippet 截取与回退
7. url → domain 解析
8. max_results 截断
"""
from __future__ import annotations

import pytest

from app.services.ai.search import build_search_source_cards


def test_score_string_is_parsed_as_float():
    """回归测试：adapter 实际将 score 以字符串返回（"0.9"），旧 isinstance 检查会拒绝。"""
    payload = {"results": [
        {"url": "https://example.com", "title": "结果", "content": "x", "score": "0.9"}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["score"] == 0.9
    assert isinstance(cards[0]["score"], float)


def test_score_numeric_is_kept_as_float():
    payload = {"results": [
        {"url": "https://a.com", "title": "x", "content": "x", "score": 0.71},
        {"url": "https://b.com", "title": "y", "content": "x", "score": 1},
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["score"] == 0.71
    assert cards[1]["score"] == 1.0


def test_score_none_value_yields_none():
    payload = {"results": [
        {"url": "https://example.com", "title": "x", "content": "x", "score": None}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["score"] is None


def test_score_missing_key_yields_none():
    payload = {"results": [
        {"url": "https://example.com", "title": "x", "content": "x"}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["score"] is None


def test_score_invalid_string_yields_none():
    payload = {"results": [
        {"url": "https://example.com", "title": "x", "content": "x", "score": "abc"}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["score"] is None


def test_snippet_uses_content_when_raw_missing():
    payload = {"results": [
        {"url": "https://example.com", "title": "t", "content": "摘要"}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["snippet"] == "摘要"


def test_snippet_truncates_long_content():
    payload = {"results": [
        {"url": "https://example.com", "title": "t", "content": "a" * 500}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["snippet"].endswith("...")
    assert len(cards[0]["snippet"]) <= 284  # 280 + "..."


def test_missing_url_skips_result():
    payload = {"results": [
        {"url": "https://ok.com", "title": "正常", "content": "x"},
        {"title": "无链接", "content": "x"},
    ]}
    cards = build_search_source_cards(payload)
    assert len(cards) == 1
    assert cards[0]["title"] == "正常"


def test_missing_title_defaults():
    payload = {"results": [
        {"url": "https://example.com", "content": "x"}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["title"] == "未命名结果"


def test_domain_extracted_from_url():
    payload = {"results": [
        {"url": "https://news.example.com/path?x=1", "title": "x", "content": "x"}
    ]}
    cards = build_search_source_cards(payload)
    assert cards[0]["domain"] == "news.example.com"


def test_max_results_caps_count():
    payload = {"results": [
        {"url": f"https://example.com/{i}", "title": f"r{i}", "content": "x"}
        for i in range(10)
    ]}
    cards = build_search_source_cards(payload, max_results=3)
    assert len(cards) == 3


def test_results_must_be_list():
    assert build_search_source_cards({"results": "not a list"}) == []


def test_favicon_omitted_when_missing():
    payload = {"results": [
        {"url": "https://example.com", "title": "x", "content": "x"}
    ]}
    cards = build_search_source_cards(payload)
    assert "favicon" not in cards[0]
