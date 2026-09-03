# 基线快照 Baseline（Python 现状资源占用）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **测量日期：** 2026-09-03　**测量环境：** 本地 Mac（darwin/arm64），本地常驻 PG 18.4 + Redis
> **用途：** Go 构建完成后，用**相同方法**重测做对比。所有命令可直接重跑。

## 一、进程内存（本地实测）

| 进程 | RSS | 说明 |
|------|-----|------|
| uvicorn 单 worker（`app.main:app`）启动后 | **262 MB** | 10 次请求后仍 262MB（稳定，无泄漏迹象） |
| celery worker（solo, concurrency=1）空闲 | **208 MB** | `celery -A app.tasks.celery_app worker` |
| 冷启动 `import app.main` | 1.9 s | 全部路由懒加载后的 import 时间 |

测量命令（重跑用）：

```bash
cd backend
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 18099 &
ps aux | grep "[u]vicorn app.main"   # 第 6 列即 RSS(KB)
.venv/bin/python -c "import time; t=time.time(); import app.main; print(f'{time.time()-t:.1f}s')"
.venv/bin/celery -A app.tasks.celery_app worker --concurrency=1 --pool=solo --without-heartbeat -l WARNING &
ps aux | grep "[c]elery -A"
```

## 二、API 延迟（本地，auth-reject 路径）

`/api/v1/health` 无 API key 时返回 `{"detail":"Missing API key"}`，10 次：min 1.9ms / p50 2.3ms / max 3.2ms。
> 说明：带鉴权的业务端点延迟基线**本次未测**（需登录态），留到 Phase S/Phase 4 影子流量时补（录制真实延迟分布）。

## 三、磁盘占用

| 路径 | 大小 | 备注 |
|------|------|------|
| `backend/` 总计 | 669 MB | — |
| `backend/.venv` | **631 MB** | 94% 是虚拟环境（pandas/numpy/playwright/chromium 为主） |
| `backend/app`（生产代码 136,542 行） | 14 MB | — |
| `backend/tests`（68,543 行） | 16 MB | — |
| `backend/alembic`（238 迁移） | 5.1 MB | — |
| `backend/storage` | 1.4 MB | 本地样例文件 |

> 关键洞察：代码本身只有 ~35MB，**631MB 虚拟环境是部署体积大头**——Go 单二进制（~30–50MB）在此项天然胜出，无需优化。

## 四、PostgreSQL（本地 BLF = 生产快照，769MB）

- 版本 PG 18.4（Homebrew），常驻连接 9 个
- `BLF`：**769 MB** / 114 表 / 约 621K 行（reltuples 估算）
- `BLF_test`：82 MB / 114 表
- Top 5 大表：`monthly_report_transactions` 117MB（72K 行）、`ad_upload_promoted_product_rows` 91MB（55K 行）、`analysis_sales_order_rows` 91MB（50K 行）、`_sales_rows_bak_20260718` 71MB（⚠️ 可能是可删的备份表，Phase 6 清理候选）、`inventory_snapshot_rows` 61MB（30K 行）
- 完整 Top 20 见测量原表（2026-09-03 实测，已归档本文件 v1）

重跑命令：

```bash
PW=$(grep -E "^DATABASE_URL=" backend/.env | sed -E "s#.*://damon:([^@]+)@.*#\1#"); export PGPASSWORD="$PW"
psql -h localhost -U damon -d postgres -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname IN ('BLF','BLF_test');"
psql -h localhost -U damon -d BLF -c "SELECT relname, pg_size_pretty(pg_total_relation_size(C.oid)), reltuples::bigint FROM pg_class C JOIN pg_namespace N ON N.oid=C.relnamespace WHERE N.nspname='public' AND C.relkind='r' ORDER BY pg_total_relation_size(C.oid) DESC LIMIT 20;"
```

## 五、Redis（本地）

- `used_memory_human: 1.77M`，33 keys（db0: 27 session keys `bb:session:*`，db1: 2，db2: 4）
- 本地 Redis 基本空载；生产 Redis 占用以后补（见 §七）。

## 六、Go 对比验收标准（Phase S / Phase 4 填第二列）

| 指标 | Python 基线（本文件） | Go 实测（待填） | 目标 |
|------|----------------------|----------------|------|
| API worker RSS | 262 MB | | ≤130MB（-50%） |
| 后台 worker RSS | 208 MB | | ≤100MB |
| 部署体积（含运行时） | 631 MB（.venv） | | ≤50MB（二进制） |
| ingest 耗时（试点类型） | 待 Phase S 录制 | | ≥10x |
| ingest 峰值内存 | 待 Phase S 录制 | | ≤1/3 |
| 报表端到端耗时 | 待 Phase 3 录制 | | ≤1/2 |

## 七、生产 VPS 基线（待手动补——只读命令，不影响生产）

本地无法代替 VPS（2GB 内存 + 真实流量），切换前必须在 VPS 上跑一遍以下只读命令，把结果贴回本文件：

```bash
# 内存/进程（只读）
free -m && ps aux --sort=-%mem | head -15
systemctl status believeboy-api believeboy-celery believeboy-celery-scheduled believeboy-beat --no-pager
# 磁盘（只读）
du -sh /root/believeboyDashboard/backend/.venv /root/believeboyDashboard/backend
# 生产库大小（只读查询）
sudo -u postgres psql -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname='BLF';"
# 生产 Redis（只读）
redis-cli info memory | grep used_memory_human && redis-cli dbsize
```
