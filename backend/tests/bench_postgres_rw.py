#!/usr/bin/env python3
"""Benchmark PostgreSQL read-write latency."""

from __future__ import annotations

import argparse
import math
import statistics
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.config import get_settings

BENCH_TABLE = 'public.codex_postgres_benchmark'


def normalize_postgres_url(url: str) -> str:
    normalized = (
        url.replace('postgresql+psycopg://', 'postgresql://')
        .replace('postgres+psycopg://', 'postgres://')
        .strip()
    )
    lower = normalized.lower()
    if not (lower.startswith('postgresql://') or lower.startswith('postgres://')):
        raise ValueError(
            f'DATABASE_URL 必须是 PostgreSQL 连接串，当前是: {url}'
        )

    split = urlsplit(normalized)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    if split.hostname and split.hostname.endswith('supabase.co') and 'sslmode' not in query:
        query['sslmode'] = 'require'
        normalized = urlunsplit(
            (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
        )
    return normalized


def redact_postgres_url(url: str) -> str:
    split = urlsplit(url)
    if split.password is None:
        return url

    username = split.username or ''
    host = split.hostname or ''
    port = f':{split.port}' if split.port else ''
    auth = f'{username}:***@' if username else ''
    netloc = f'{auth}{host}{port}'
    return urlunsplit((split.scheme, netloc, split.path, split.query, split.fragment))


def percentile(latencies: list[float], p: float) -> float:
    if not latencies:
        return 0.0
    ordered = sorted(latencies)
    rank = max(0, math.ceil((p / 100) * len(ordered)) - 1)
    return ordered[rank]


def render_stats(label: str, latencies: list[float]) -> str:
    if not latencies:
        return f'{label:<8} count=0'
    return (
        f'{label:<8} '
        f'count={len(latencies):4d} '
        f'avg={statistics.fmean(latencies):8.2f}ms '
        f'p50={percentile(latencies, 50):8.2f}ms '
        f'p95={percentile(latencies, 95):8.2f}ms '
        f'min={min(latencies):8.2f}ms '
        f'max={max(latencies):8.2f}ms'
    )


def run_benchmark(
    conn: psycopg.Connection,
    writes: int,
    reads: int,
    payload_bytes: int,
    warmup: int,
    cleanup: bool,
) -> dict[str, object]:
    run_id = f'bench_{uuid.uuid4().hex[:12]}'
    payload = 'x' * max(1, payload_bytes)
    write_latencies: list[float] = []
    read_latencies: list[float] = []
    ids: list[int] = []
    read_failures = 0

    with conn.cursor() as cur:
        cur.execute(
            f'''
            CREATE TABLE IF NOT EXISTS {BENCH_TABLE} (
                id BIGSERIAL PRIMARY KEY,
                run_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            '''
        )
        conn.commit()

        for _ in range(warmup):
            cur.execute(
                f'INSERT INTO {BENCH_TABLE} (run_id, payload) VALUES (%s, %s) RETURNING id',
                (run_id, payload),
            )
            warmup_id = cur.fetchone()[0]
            cur.execute(f'DELETE FROM {BENCH_TABLE} WHERE id = %s', (warmup_id,))
        conn.commit()

        for _ in range(writes):
            started = time.perf_counter()
            cur.execute(
                f'INSERT INTO {BENCH_TABLE} (run_id, payload) VALUES (%s, %s) RETURNING id',
                (run_id, payload),
            )
            row_id = cur.fetchone()[0]
            conn.commit()
            write_latencies.append((time.perf_counter() - started) * 1000)
            ids.append(row_id)

        for i in range(reads):
            row_id = ids[i % len(ids)]
            started = time.perf_counter()
            cur.execute(
                f'SELECT payload FROM {BENCH_TABLE} WHERE id = %s AND run_id = %s',
                (row_id, run_id),
            )
            row = cur.fetchone()
            read_latencies.append((time.perf_counter() - started) * 1000)
            if row is None:
                read_failures += 1

        if cleanup:
            cur.execute(f'DELETE FROM {BENCH_TABLE} WHERE run_id = %s', (run_id,))
            conn.commit()

    return {
        'run_id': run_id,
        'write_latencies': write_latencies,
        'read_latencies': read_latencies,
        'read_failures': read_failures,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='测试 PostgreSQL 数据库写入和读取延迟'
    )
    parser.add_argument('--writes', type=int, default=50, help='写入次数，默认 50')
    parser.add_argument('--reads', type=int, default=100, help='读取次数，默认 100')
    parser.add_argument(
        '--payload-bytes',
        type=int,
        default=512,
        help='每条写入 payload 大小（字节），默认 512',
    )
    parser.add_argument('--warmup', type=int, default=5, help='预热次数，默认 5')
    parser.add_argument(
        '--keep-data',
        action='store_true',
        help='保留本次压测写入数据（默认压测后删除）',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.writes <= 0:
        print('ERROR: --writes 必须 > 0', file=sys.stderr)
        return 1
    if args.reads <= 0:
        print('ERROR: --reads 必须 > 0', file=sys.stderr)
        return 1
    if args.payload_bytes <= 0:
        print('ERROR: --payload-bytes 必须 > 0', file=sys.stderr)
        return 1
    if args.warmup < 0:
        print('ERROR: --warmup 不能小于 0', file=sys.stderr)
        return 1

    settings = get_settings()
    db_url = normalize_postgres_url(settings.database_url)
    print('=' * 72)
    print('PostgreSQL 读写压测')
    print('=' * 72)
    print(f'DATABASE_URL: {redact_postgres_url(db_url)}')
    print(
        f'参数: writes={args.writes}, reads={args.reads}, payload_bytes={args.payload_bytes}, warmup={args.warmup}, cleanup={not args.keep_data}'
    )

    try:
        total_started = time.perf_counter()
        connect_started = time.perf_counter()
        with psycopg.connect(db_url, connect_timeout=30) as conn:
            connect_ms = (time.perf_counter() - connect_started) * 1000
            result = run_benchmark(
                conn=conn,
                writes=args.writes,
                reads=args.reads,
                payload_bytes=args.payload_bytes,
                warmup=args.warmup,
                cleanup=not args.keep_data,
            )
        total_ms = (time.perf_counter() - total_started) * 1000
    except Exception as exc:
        print(f'ERROR: 压测失败: {exc}', file=sys.stderr)
        return 1

    write_latencies = result['write_latencies']
    read_latencies = result['read_latencies']
    read_failures = result['read_failures']
    read_success_rate = ((args.reads - read_failures) / args.reads) * 100

    print('-' * 72)
    print(f'run_id: {result["run_id"]}')
    print(f'连接耗时: {connect_ms:.2f}ms')
    print(render_stats('WRITE', write_latencies))
    print(render_stats('READ', read_latencies))
    print(f'读取成功率: {read_success_rate:.2f}% ({args.reads - read_failures}/{args.reads})')
    print(f'总耗时: {total_ms:.2f}ms')
    print('=' * 72)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
