from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from app.core.config import Settings

CACHE_PREFIX = 'product_costs:list:'
PROJECTS_CACHE_PREFIX = 'projects:'
PROJECTS_OPTIONS_CACHE_KEY = f'{PROJECTS_CACHE_PREFIX}options'
PROJECTS_MANAGE_CACHE_KEY = f'{PROJECTS_CACHE_PREFIX}manage'


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
    payload = _get_cached_payload(settings, key)
    if not isinstance(payload, dict):
        return None
    return payload


def set_cached_list_response(settings: Settings, key: str, payload: dict) -> None:
    _set_cached_payload(settings, key, payload)


def get_cached_projects_options(settings: Settings) -> list[dict[str, str]] | None:
    payload = _get_cached_payload(settings, PROJECTS_OPTIONS_CACHE_KEY)
    if not isinstance(payload, list):
        return None
    return payload


def set_cached_projects_options(settings: Settings, payload: list[dict[str, str]]) -> None:
    _set_cached_payload(settings, PROJECTS_OPTIONS_CACHE_KEY, payload)


def get_cached_projects_manage(settings: Settings) -> list[dict] | None:
    payload = _get_cached_payload(settings, PROJECTS_MANAGE_CACHE_KEY)
    if not isinstance(payload, list):
        return None
    return payload


def set_cached_projects_manage(settings: Settings, payload: list[dict]) -> None:
    _set_cached_payload(settings, PROJECTS_MANAGE_CACHE_KEY, payload)


def invalidate_projects_cache(settings: Settings) -> None:
    _ensure_cache_table(settings)
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            conn.execute('delete from query_cache where cache_key like ?', (f'{PROJECTS_CACHE_PREFIX}%',))
            conn.commit()
    except sqlite3.Error:
        return


def clear_all_cache(settings: Settings) -> int:
    _ensure_cache_table(settings)
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            cursor = conn.execute('delete from query_cache')
            conn.commit()
            return max(0, cursor.rowcount)
    except sqlite3.Error:
        return 0


def get_cache_status(settings: Settings) -> dict[str, int | str | bool | None]:
    _ensure_cache_table(settings)
    now_ts = int(time.time())
    cache_path = Path(settings.product_cost_cache_sqlite_path)
    status: dict[str, int | str | bool | None] = {
        'sqlite_path': str(cache_path.resolve()),
        'exists': cache_path.exists(),
        'file_size_bytes': cache_path.stat().st_size if cache_path.exists() else 0,
        'ttl_seconds': max(1, settings.product_cost_list_cache_ttl_seconds),
        'total_entries': 0,
        'expired_entries': 0,
        'active_entries': 0,
        'latest_updated_at': None,
        'nearest_expire_at': None,
    }
    try:
        with sqlite3.connect(settings.product_cost_cache_sqlite_path) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                select
                  count(*) as total_entries,
                  sum(case when expires_at <= ? then 1 else 0 end) as expired_entries,
                  max(updated_at) as latest_updated_at,
                  min(case when expires_at > ? then expires_at end) as nearest_expire_at
                from query_cache
                """,
                (now_ts, now_ts),
            ).fetchone()
            if row:
                total_entries = int(row['total_entries'] or 0)
                expired_entries = int(row['expired_entries'] or 0)
                status['total_entries'] = total_entries
                status['expired_entries'] = expired_entries
                status['active_entries'] = max(0, total_entries - expired_entries)
                status['latest_updated_at'] = int(row['latest_updated_at']) if row['latest_updated_at'] else None
                status['nearest_expire_at'] = int(row['nearest_expire_at']) if row['nearest_expire_at'] else None
    except sqlite3.Error:
        return status
    return status


def _get_cached_payload(settings: Settings, key: str) -> dict | list | None:
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


def _set_cached_payload(settings: Settings, key: str, payload: dict | list) -> None:
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
