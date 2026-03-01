#!/usr/bin/env python3
"""
简化的 PostgreSQL 数据库连接测试
"""

import os
import sys
import time
import psycopg
from pathlib import Path

# 添加 backend 目录到 Python 路径
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))

# 加载环境变量
try:
    from dotenv import load_dotenv
    env_file = backend_dir / ".env"
    if env_file.exists():
        load_dotenv(env_file)
        print(f"✅ 已加载环境变量: {env_file}")
except ImportError:
    pass

def test_connection():
    """测试直接连接"""
    print("\n" + "=" * 60)
    print("🔍 PostgreSQL 数据库连接测试 (直接 psycopg)")
    print("=" * 60)

    # 获取连接信息（优先 PG*，兼容 SUPABASE_DB_*）
    host = os.getenv("PGHOST") or os.getenv("SUPABASE_DB_HOST") or "localhost"
    port = int(os.getenv("PGPORT") or os.getenv("SUPABASE_DB_PORT") or "5432")
    dbname = os.getenv("PGDATABASE") or os.getenv("SUPABASE_DB_NAME") or "BLF"
    user = os.getenv("PGUSER") or os.getenv("SUPABASE_DB_USER") or "damon"
    password = os.getenv("PGPASSWORD") or os.getenv("SUPABASE_DB_PASSWORD")

    if not password:
        print("\n❌ 未设置数据库密码。请配置 PGPASSWORD 或 SUPABASE_DB_PASSWORD。")
        return False

    sslmode = os.getenv("PGSSLMODE")
    if not sslmode and (
        "supabase.co" in host.lower()
        or "sslmode=require" in (os.getenv("DATABASE_URL", "").lower())
    ):
        sslmode = "require"

    print(f"\n📡 连接信息:")
    print(f"   Host: {host}")
    print(f"   Port: {port}")
    print(f"   Database: {dbname}")
    print(f"   User: {user}")

    # 尝试连接
    print("\n" + "-" * 40)
    print("尝试连接...")
    print("-" * 40)

    try:
        connect_started = time.perf_counter()

        connect_kwargs = {
            "host": host,
            "port": port,
            "dbname": dbname,
            "user": user,
            "password": password,
            "connect_timeout": 30,
        }
        if sslmode:
            connect_kwargs["sslmode"] = sslmode

        # 使用 psycopg 直接连接
        conn = psycopg.connect(**connect_kwargs)
        connect_ms = (time.perf_counter() - connect_started) * 1000

        print("✅ 连接成功!")
        print(f"✅ 连接耗时: {connect_ms:.2f} ms")
        
        # 执行简单查询
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            result = cur.fetchone()
            print(f"✅ 测试查询结果: {result[0]}")
            
            cur.execute("SELECT NOW()")
            result = cur.fetchone()
            print(f"✅ 数据库时间: {result[0]}")
            
            # 获取表列表
            cur.execute("""
                SELECT tablename FROM pg_tables 
                WHERE schemaname = 'public'
            """)
            tables = cur.fetchall()
            if tables:
                print(f"✅ 找到 {len(tables)} 个表:")
                for table in tables:
                    print(f"   - {table[0]}")
            else:
                print("⚠️  数据库中没有表")
        
        conn.close()
        print("\n" + "=" * 60)
        print("✅ 所有测试通过!")
        print("=" * 60)
        return True

    except psycopg.Error as e:
        print(f"\n❌ 连接失败: {e}")
        return False

if __name__ == "__main__":
    success = test_connection()
    sys.exit(0 if success else 1)
