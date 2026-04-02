from datetime import datetime
import json
import os
import sys

import httpx


def trim_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith('/') else value


def build_search_query(query: str) -> str:
    current_date = datetime.now().date().isoformat()
    return (
        f'{query.strip()}\n'
        f'当前日期：{current_date}。\n'
        '请优先返回最近发布、最近更新、时效性最强的结果，并优先考虑最新信息。'
    ).strip()


def main() -> int:
    query = ' '.join(sys.argv[1:]).strip()
    if not query:
        print('Usage: python backend/scripts/test_tavily_search.py "your query"')
        return 1

    base_url = trim_trailing_slash(os.getenv('AI_CHAT_WEB_SEARCH_BASE_URL', 'https://search.believeboy.com').strip())
    api_key = os.getenv('AI_CHAT_WEB_SEARCH_API_KEY', '').strip()
    timeout_seconds = int(os.getenv('AI_CHAT_TIMEOUT_SECONDS', '90'))

    if not api_key:
        print('Missing AI_CHAT_WEB_SEARCH_API_KEY in environment')
        return 1

    payload = {
        'query': build_search_query(query),
        'topic': os.getenv('AI_CHAT_WEB_SEARCH_TOPIC', 'general').strip() or 'general',
        'search_depth': os.getenv('AI_CHAT_WEB_SEARCH_DEPTH', 'advanced').strip() or 'advanced',
        'max_results': int(os.getenv('AI_CHAT_WEB_SEARCH_MAX_RESULTS', '5')),
        'time_range': 'month',
        'include_answer': True,
        'include_raw_content': True,
        'include_favicon': True,
    }
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    response = httpx.post(f'{base_url}/search', json=payload, headers=headers, timeout=timeout_seconds)
    response.raise_for_status()
    data = response.json()

    print(json.dumps({'query': data.get('query'), 'answer': data.get('answer'), 'results': data.get('results', [])[:3]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
