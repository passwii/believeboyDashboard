#!/usr/bin/env python3
"""
简化的 Supabase 数据库连接测试
"""

import os
import sys
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
    print("🔍 Supabase 数据库连接测试 (直接 psycopg)")
    print("=" * 60)
    
    # 获取连接信息
    host = "db.nkeieekzajfdsuxuywux.supabase.co"
    port = 5432
    dbname = "postgres"
    user = "postgres"
    password = "XeonJJ2024@"
    
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
        # 使用 psycopg 直接连接
        conn = psycopg.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=password,
            sslmode="require",
            connect_timeout=30
        )
        
        print("✅ 连接成功!")
        
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
