from fastapi import HTTPException

from app.core.config import Settings
from app.services import ai_chat_service


def build_settings(**overrides):
    data = {
        'database_url': 'sqlite:///./test.db',
        'api_key': 'test-api-key',
        'ai_chat_provider_base_url': 'https://example.com/v1',
        'ai_chat_provider_api_key': 'sk-test',
        'ai_chat_default_model': 'GLM-5.0',
        'ai_chat_title_model': 'Qwen3-8B',
        'ai_chat_reasoning_models': 'GLM-5.0,Qwen3-32B',
        'ai_chat_default_reasoning_effort': 'medium',
        'ai_chat_timeout_seconds': 90,
        'ai_chat_web_search_base_url': 'https://search.believeboy.com',
        'ai_chat_web_search_api_key': 'tvly-test',
        'ai_chat_web_search_topic': 'general',
        'ai_chat_web_search_depth': 'advanced',
        'ai_chat_web_search_max_results': 5,
    }
    data.update(overrides)
    return Settings(**data)


def test_resolve_title_model_prefers_title_model():
    settings = build_settings()
    assert ai_chat_service.resolve_title_model(settings) == 'Qwen3-8B'


def test_resolve_title_model_falls_back_to_default_model():
    settings = build_settings(ai_chat_title_model='')
    assert ai_chat_service.resolve_title_model(settings) == 'GLM-5.0'


def test_get_reasoning_models_parses_csv():
    settings = build_settings(ai_chat_reasoning_models='GLM-5.0, Qwen3-32B ,,')
    assert ai_chat_service.get_reasoning_models(settings) == {'GLM-5.0', 'Qwen3-32B'}


def test_build_llm_config_includes_reasoning_effort_for_supported_model():
    settings = build_settings()

    config = ai_chat_service.build_llm_config(
        settings=settings,
        model='GLM-5.0',
        system_prompt='system',
        reasoning_effort='high',
    )

    assert config.model == 'GLM-5.0'
    assert config.reasoning_effort == 'high'


def test_build_llm_config_rejects_reasoning_for_unsupported_model():
    settings = build_settings(ai_chat_reasoning_models='Qwen3-32B')

    try:
        ai_chat_service.build_llm_config(
            settings=settings,
            model='GLM-5.0',
            system_prompt='system',
            reasoning_effort='high',
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == '当前模型不支持思考强度设置'
    else:
        raise AssertionError('expected build_llm_config to reject unsupported reasoning model')


def test_normalize_generated_title_strips_wrapper_text():
    value = '标题："广告投放优化建议"\n这里是额外解释'
    assert ai_chat_service.normalize_generated_title(value) == '广告投放优化建议'


def test_generate_conversation_title_uses_title_model(monkeypatch):
    settings = build_settings()
    captured: dict[str, object] = {}

    def fake_request_chat_completion(llm_config, messages, temperature):
        captured['model'] = llm_config.model
        captured['messages'] = messages
        captured['temperature'] = temperature
        return {'choices': [{'message': {'content': '新品上架规划'}}]}

    monkeypatch.setattr(ai_chat_service, 'request_chat_completion', fake_request_chat_completion)

    title = ai_chat_service.generate_conversation_title(settings, '帮我规划新品上架', '可以先拆阶段执行')

    assert title == '新品上架规划'
    assert captured['model'] == 'Qwen3-8B'
    assert captured['temperature'] == 0.2


def test_regenerate_conversation_title_uses_recent_messages(monkeypatch):
    settings = build_settings()
    captured: dict[str, object] = {}

    class StubMessage:
        def __init__(self, role: str, content: str):
            self.role = role
            self.content = content

    def fake_request_chat_completion(llm_config, messages, temperature):
        captured['model'] = llm_config.model
        captured['messages'] = messages
        captured['temperature'] = temperature
        return {'choices': [{'message': {'content': '广告复盘结论'}}]}

    monkeypatch.setattr(ai_chat_service, 'request_chat_completion', fake_request_chat_completion)

    title = ai_chat_service.regenerate_conversation_title(
        settings,
        [
          StubMessage('user', '帮我复盘本周广告'),
          StubMessage('assistant', '我先从花费、转化和点击率三部分分析'),
        ],
    )

    assert title == '广告复盘结论'
    assert captured['model'] == 'Qwen3-8B'
    assert captured['temperature'] == 0.2
    assert '帮我复盘本周广告' in str(captured['messages'])


def test_regenerate_conversation_title_returns_none_when_messages_empty():
    settings = build_settings()
    assert ai_chat_service.regenerate_conversation_title(settings, []) is None


def test_is_web_search_configured():
    settings = build_settings()
    assert ai_chat_service.is_web_search_configured(settings) is True
    assert ai_chat_service.is_web_search_configured(build_settings(ai_chat_web_search_api_key='')) is False


def test_request_web_search_uses_configured_endpoint(monkeypatch):
    settings = build_settings()
    captured: dict[str, object] = {}

    class StubResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {'answer': 'done', 'results': []}

    def fake_post(url, json, headers, timeout):
        captured['url'] = url
        captured['json'] = json
        captured['headers'] = headers
        captured['timeout'] = timeout
        return StubResponse()

    monkeypatch.setattr(ai_chat_service.httpx, 'post', fake_post)

    payload = ai_chat_service.request_web_search(settings, 'latest amazon ads update')

    assert payload['answer'] == 'done'
    assert captured['url'] == 'https://search.believeboy.com/search'
    assert 'latest amazon ads update' in captured['json']['query']
    assert '当前日期：' in captured['json']['query']
    assert captured['json']['time_range'] == 'month'
    assert captured['json']['include_answer'] is True
    assert captured['json']['include_raw_content'] is True
    assert captured['headers']['Authorization'] == 'Bearer tvly-test'


def test_format_web_search_context_includes_results():
    payload = {
        'answer': '这是摘要',
        'results': [
            {
                'title': 'Result A',
                'url': 'https://example.com/a',
                'content': 'content A',
            }
        ],
    }

    content = ai_chat_service.format_web_search_context(payload, 'test query')

    assert '搜索词：test query' in content
    assert 'Result A' in content
    assert 'https://example.com/a' in content
    assert '这是摘要' in content


def test_build_payload_messages_with_search_injects_context():
    payload = ai_chat_service.build_payload_messages_with_search([], '用户问题', '系统提示', '搜索上下文')

    assert payload == [
        {'role': 'system', 'content': '系统提示'},
        {'role': 'system', 'content': '搜索上下文'},
        {'role': 'user', 'content': '用户问题'},
    ]


def test_build_search_source_cards_returns_compact_cards():
    payload = {
        'results': [
            {
                'title': 'Result A',
                'url': 'https://example.com/path',
                'content': 'summary text',
                'score': 0.83,
            }
        ]
    }

    cards = ai_chat_service.build_search_source_cards(payload)

    assert cards == [
        {
            'title': 'Result A',
            'url': 'https://example.com/path',
            'snippet': 'summary text',
            'domain': 'example.com',
            'score': 0.83,
        }
    ]


def test_build_search_source_cards_includes_favicon_only_when_present():
    payload = {
        'results': [
            {
                'title': 'Result A',
                'url': 'https://example.com/path',
                'content': 'summary text',
                'favicon': 'https://example.com/favicon.ico',
            }
        ]
    }

    cards = ai_chat_service.build_search_source_cards(payload)

    assert cards == [
        {
            'title': 'Result A',
            'url': 'https://example.com/path',
            'snippet': 'summary text',
            'domain': 'example.com',
            'score': None,
            'favicon': 'https://example.com/favicon.ico',
        }
    ]


def test_merge_stream_tool_calls_reconstructs_fragmented_arguments():
    merged = ai_chat_service.merge_stream_tool_calls(
        [],
        [
            {
                'index': 0,
                'id': 'call_123',
                'type': 'function',
                'function': {'name': 'web_search', 'arguments': '{"query":"Amazon'},
            }
        ],
    )
    merged = ai_chat_service.merge_stream_tool_calls(
        merged,
        [
            {
                'index': 0,
                'function': {'arguments': ' Ads 最新动态","time_range":"week"}'},
            }
        ],
    )

    assert merged == [
        {
            'id': 'call_123',
            'type': 'function',
            'function': {
                'name': 'web_search',
                'arguments': '{"query":"Amazon Ads 最新动态","time_range":"week"}',
            },
        }
    ]


def test_parse_search_sources_returns_empty_list_for_bad_json():
    assert ai_chat_service.parse_search_sources('not-json') == []


def test_build_web_search_query_includes_date_and_freshness_hint():
    query = ai_chat_service.build_web_search_query('Amazon Ads 最新动态')

    assert 'Amazon Ads 最新动态' in query
    assert '当前日期：' in query
    assert '最近发布' in query
