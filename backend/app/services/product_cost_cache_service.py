from __future__ import annotations

import json
import sqlite3
import time

from app.core.config import Settings

CACHE_PREFIX = 'product_costs:list:'


def _normalize_filter(value: str | None) -> str:
    return (value or '').strip()


def build_list_cache_key(
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    page: int,
    page_size: int,
    include_total: bool,
    ) -> str:
    return (
        f'{CACHE_PREFIX}'
        f'project={_normalize_filter(project_name)}|'
        f'sku={_normalize_filter(sku)}|'
        f'asin={_normalize_filter(asin)}|'
        f'page={page}|size={page_size}|total={int(include_total)}'
    )


def get_cached_list_response(settings: Settings, key: str) -> dict | None:
    _ensure_cache_table(settings)
    now_ts = int(time.time())
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                select payload, expires_at
                from query_cache
                where cache_key = ?
                """,
                (key,),
            ).fetchone()
            if not row:
                return None
            if int(row['expires_at']) <= now_ts:
                conn.execute('delete from query_cache where cache_key = ?', (key,))
                conn.commit()
                return None
            return json.loads(str(row['payload']))
    except (sqlite3.Error, json.JSONDecodeError):
        return None


def set_cached_list_response(settings: Settings, key: str, payload: dict) -> None:
    _ensure_cache_table(settings)
    ttl = max(1, settings.product_cost_list_cache_ttl_seconds)
    now_ts = int(time.time())
    expires_at = now_ts + ttl
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            conn.execute(
                """
                insert into query_cache (cache_key, payload, expires_at, updated_at)
                values (?, ?, ?, ?)
                on conflict(cache_key) do update set
                  payload = excluded.payload,
                  expires_at = excluded.expires_at,
                  updated_at = excluded.updated_at
                """,
                (key, json.dumps(payload, ensure_ascii=False), expires_at, now_ts),
            )
            conn.commit()
    except (sqlite3.Error, TypeError, ValueError):
        return


def invalidate_list_cache(settings: Settings) -> None:
    _ensure_cache_table(settings)
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            conn.execute('delete from query_cache where cache_key like ?', (f'{CACHE_PREFIX}%',))
            conn.commit()
    except sqlite3.Error:
        return


def _ensure_cache_table(settings: Settings) -> None:
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            conn.execute('pragma journal_mode = wal;')
            conn.execute(
                """
                create table if not exists query_cache (
                  cache_key text primary key,
                  payload text not null,
                  expires_at integer not null,
                  updated_at integer not null
                )
                """
            )
            conn.execute('create index if not exists idx_query_cache_expires_at on query_cache (expires_at)')
            conn.commit()
    except sqlite3.Error:
        return
