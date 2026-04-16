#!/usr/bin/env python3
import os
os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://damon:jrway2012@localhost:5432/BLF')

from sqlalchemy import create_engine, text, inspect

engine = create_engine(os.environ['DATABASE_URL'])

with engine.connect() as conn:
    # 1. Check alembic version
    result = conn.execute(text("SELECT version_num FROM alembic_version"))
    rows = result.fetchall()
    print("=== alembic_version ===")
    for row in rows:
        print(f"  version: {row[0]}")

    # 2. Check columns in pricing_calculation_runs
    print("\n=== pricing_calculation_runs columns ===")
    result = conn.execute(text("""
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'pricing_calculation_runs'
        ORDER BY ordinal_position
    """))
    for row in result:
        print(f"  {row[0]}: {row[1]} nullable={row[2]} default={row[3]}")

    # 3. Check columns in store_sku_pricing_snapshots
    print("\n=== store_sku_pricing_snapshots columns ===")
    result = conn.execute(text("""
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'store_sku_pricing_snapshots'
        ORDER BY ordinal_position
    """))
    for row in result:
        print(f"  {row[0]}: {row[1]} nullable={row[2]} default={row[3]}")

    # 4. Count rows in pricing_calculation_runs (total and with project_id)
    print("\n=== pricing_calculation_runs row counts ===")
    result = conn.execute(text("SELECT COUNT(*) FROM pricing_calculation_runs"))
    print(f"  Total rows: {result.scalar()}")
    result = conn.execute(text("SELECT COUNT(*) FROM pricing_calculation_runs WHERE project_id IS NOT NULL"))
    print(f"  Rows with project_id (店铺核算): {result.scalar()}")
    result = conn.execute(text("SELECT COUNT(*) FROM pricing_calculation_runs WHERE project_id IS NULL"))
    print(f"  Rows without project_id (新品核算): {result.scalar()}")

    # 5. Count rows in store_sku_pricing_snapshots
    print("\n=== store_sku_pricing_snapshots row counts ===")
    result = conn.execute(text("SELECT COUNT(*) FROM store_sku_pricing_snapshots"))
    print(f"  Total rows: {result.scalar()}")

    # 6. Sample some pricing_calculation_runs with project_id
    print("\n=== Sample pricing_calculation_runs with project_id ===")
    result = conn.execute(text("""
        SELECT id, project_id, sku, calculation_type, product_name, country, created_at
        FROM pricing_calculation_runs
        WHERE project_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 5
    """))
    for row in result:
        print(f"  id={row[0]} project_id={row[1]} sku={row[2]} type={row[3]} name={row[4]} country={row[5]} created={row[6]}")
