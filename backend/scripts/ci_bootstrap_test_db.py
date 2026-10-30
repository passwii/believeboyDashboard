#!/usr/bin/env python3
"""建 CI 测试库的 schema（bootstrap 表 + 迁移链）。

**为什么需要这个脚本**（背景见 `backend/scripts/setup_test_db.py` 的说明）：
迁移链假设 `user_accounts` / `projects` 两张"引导表"**已经存在**——
链上最早的迁移是 `20260224_000_product_costs_baseline`，而建这两张表的
动作在 `scripts/create_user_accounts_table.py` / `create_projects_table.py` 里，
不在迁移链里。直接从空库跑 `alembic upgrade head` 会在
`20260419_097_user_accounts_add_password_changed_at` 这类迁移上炸掉
（`column "password_changed_at" of relation "user_accounts" already exists`
—— 引导脚本已经建过这一列，迁移又加一次）。

所以顺序是：
1. 建两张引导表（**只建迁移链不会重复添加的列**）；
2. `alembic upgrade head` 补齐其余所有表 / 列。

⚠️ 引导表里**不要**预先创建 `password_changed_at` / `avatar_url` /
`role_type` / `operator_name_zh` / `full_name` 这几列——迁移链会自己加，
预建就会撞 DuplicateColumn。`projects` 同理：只建 `id` / `project_name` /
`sort_order` / `created_at` / `updated_at` 这几列。

`projects.source_file` 是模型有、迁移链没加的列（只在引导脚本里），
这里显式补上，否则表结构与模型不一致。

用法（CI 里）：
    export TEST_DATABASE_URL=postgresql+psycopg://ci:ci@localhost:5432/blf_ci
    export DATABASE_URL="$TEST_DATABASE_URL"
    python scripts/ci_bootstrap_test_db.py

本地一般**不需要**跑这个——本地用 `scripts/setup_test_db.py`（从源库 pg_dump
克隆 schema，更接近生产）。本脚本只服务于 CI 的"从零建库"场景。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 引导表 DDL —— 刻意**只含迁移链不会重复添加的列**。
BOOTSTRAP_SQL = """
create table if not exists public.user_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  password_hash text not null,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_user_accounts_email_ci
on public.user_accounts ((lower(email)));

create table if not exists public.projects (
  id bigint generated always as identity primary key,
  project_name text not null,
  sort_order integer not null default 0,
  source_file text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 迁移链里多个迁移的 trigger 依赖这个函数（见 20260326_071 等）。
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
"""


def _db_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
    if not url:
        print(
            "ci_bootstrap_test_db failed: TEST_DATABASE_URL (or DATABASE_URL) is not set.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return url


def main() -> None:
    url = _db_url()
    engine = create_engine(url, future=True)

    print("[1/2] 建引导表（user_accounts / projects）...")
    with engine.begin() as conn:
        # 整段执行（不能用 ";" 切分——函数体里的 $$ ... $$ 含分号）。
        # 引导表都是 "create table if not exists" / "create or replace"，
        # 重复执行安全。
        conn.execute(text(BOOTSTRAP_SQL))
    engine.dispose()
    print("      引导表就绪")

    print("[2/2] 跑迁移链（alembic upgrade head）...")
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(ROOT),
        env={**os.environ},
    )
    if result.returncode != 0:
        print(
            "ci_bootstrap_test_db failed: alembic upgrade head exited non-zero.",
            file=sys.stderr,
        )
        raise SystemExit(result.returncode)
    print("      schema 就绪")


if __name__ == "__main__":
    main()
