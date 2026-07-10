# 多 Worker 运维手册

> 适用于 Celery + Redis 多 worker 落地后的所有环境（staging / production）。
> 阅读对象：值班 SRE、运维、产品开发。
> 与之相关的 issue：[BEL-72](mention://issue/00d5c284-a29f-4581-8a97-021e3ca37455) · 父 issue：[BEL-55](mention://issue/ede9a089-8b45-4da8-b3b4-934b7d652f15)

本文档覆盖引入 Celery + Redis 多 worker 之后，日常运维最常触达的 5 件事：

1. 启停 `believeboy-worker.service`
2. 查看队列 / 任务状态（CLI + 前端 Job 表）
3. 队列堆积时的处置 SOP
4. 把任务从 DLQ 拉回主队列
5. 常见告警（worker 反复 OOM、任务长时间 running）的排查路径

## 1. systemd 单元速查

| 单元文件 | 作用 | 关键命令 |
| --- | --- | --- |
| `deploy/systemd/believeboy-api.service` | FastAPI（uvicorn）单进程 | 端口 8100，nginx 转发 `/api/*` |
| `deploy/systemd/believeboy-worker.service` | Celery worker（`-c 4`） | 消费 `default,reports,insights` 三个队列 |


> **为什么只起一个 worker 进程？** `believeboy-worker.service` 用的是
> `celery -A app.tasks.celery_app worker -c 4`：一个 worker **进程** + 4
> 个并发线程。这是 CPU 4 核的 VPS 的默认配置。需要更多并行槽位时，参见
> 末尾「横向扩展」一节；目前不建议直接调高 `-c`，因为报告类任务 IO
> 密集，4 个 thread 已经接近 4 核的承载上限。

### 1.1 启停 worker

```bash
# 查看状态
systemctl status believeboy-worker

# 启动 / 停止 / 重启
sudo systemctl start believeboy-worker
sudo systemctl stop believeboy-worker
sudo systemctl restart believeboy-worker

# 看最近 200 行日志（journald；用 `--no-pager` 避免一次性卡住）
sudo journalctl -u believeboy-worker -n 200 --no-pager

# 实时跟踪
sudo journalctl -u believeboy-worker -f

# 只看 ERROR 级别
sudo journalctl -u believeboy-worker -p err -n 100 --no-pager
```

`believeboy-worker.service` 已在 `[Service]` 段声明 `Restart=always` +
`RestartSec=3`：进程崩溃后 3 秒自动拉起。**只有当业务层反复 OOM 时才
需要手工停掉它排查**，见第 5 节。

### 1.2 修改并发数

`/root/believeboyDashboard/backend/.env`：

```bash
# CPU 几核就写几；VPS 升配后只需要改这里 + restart worker
CELERY_WORKER_CONCURRENCY=8
```

`sudo systemctl restart believeboy-worker` 即可生效。用
`celery -A app.tasks.celery_app inspect stats` 可立即看到新 `concurrency`。

> 不要把单进程 `concurrency` 调到 `nproc × 2` 以上：CPU 切换 + DB 连
> 接池会同时打满。VPS 升配后优先调 `CELERY_WORKER_CONCURRENCY`，
> 而不是手动加 worker 进程。

## 2. 查看队列 / 任务状态

Flower 监控面板已移除（冗余：任务状态已由 Job 表 + 前端轮询完整覆盖）。日常查
worker / 队列 / 任务用以下手段：

### 2.1 worker 是否在线（CLI）

```bash
# worker 进程在不在
systemctl status believeboy-worker
ps -ef | grep -E "celery -A app.tasks" | grep -v grep

# 用 celery inspect 看在线 worker + 并发 + 当前活跃任务
cd /root/believeboyDashboard/backend && source .venv/bin/activate
celery -A app.tasks.celery_app inspect active
celery -A app.tasks.celery_app inspect stats
```

### 2.2 队列长度（redis-cli）

```bash
# broker 在 REDIS_DB + 1（见 backend/app/core/config.py 的 _celery_broker_url_resolved）
redis-cli -n <broker_db> LLEN reports
redis-cli -n <broker_db> LLEN default
redis-cli -n <broker_db> LLEN insights
```

### 2.3 任务级状态（前端 Job 表）

任务级状态（pending / running / succeeded / failed）、失败 traceback、历史记录
直接看前端任务列表（轮询 `GET /api/v1/jobs/:id`），不需要额外的监控面板。

## 3. 队列堆积 SOP

### 3.1 判定标准

| 队列 | 阈值（连续 5 分钟） | 含义 |
| --- | --- | --- |
| `default` | `ready > 50` | ping / 通用任务积压；多半是 worker 全部挂掉 |
| `reports` | `ready > 100` | 月报 / 产品分析 / 返单分析 排队；**通常**= 月初 / 月末全量任务集中入队 |
| `insights` | `ready > 30` | AI 洞察排队；**正常**，单条任务跑 30-90s，且 `MAX_CONCURRENT_INSIGHTS=3` |

判定方式：用 `redis-cli -n <broker_db> LLEN <queue>` 直接看队列长度：
`redis-cli -n <broker_db> LLEN <queue>`。

### 3.2 处置流程

1. **先看 worker 是否在跑**：
   ```bash
   systemctl status believeboy-worker
   sudo journalctl -u believeboy-worker -p err -n 50 --no-pager
   ```
   进程不在 / 一直 OOM 退出 → 看第 5.1 节。

2. **进程在跑但队列还在涨**：
   ```bash
   # 看 worker 的并发是否被吃满
   redis-cli -n 0 KEYS 'celery-task-meta-*' | wc -l
   # 看 worker 的 heartbeat（最近一次 ack 距今多久）
   sudo journalctl -u believeboy-worker --since "10 min ago" | tail
   ```
   现象 1：**所有任务都卡在 `Received` 不动** —— 任务体里 `await` 了一
   个永不返回的 RPC / DB 死锁。`systemctl restart believeboy-worker`
   把 worker 进程整体踢掉，broker 会把未 ack 的消息 rebalance 给新进程
   （`task_acks_late=True` 已开），新进程从 `STARTED` 步骤开始重做。

   现象 2：**任务在跑但很慢** —— 不需要 restart，调高并发或临时
   横向扩 worker（见「横向扩展」一节）。

3. **任务全部 `FAILURE`**：
    - 进前端 Job 列表按 `FAILED` 过滤，挑一条点开看 `exception` / traceback。
   - 多半是 `RuntimeError: 报告数据缺失` / 数据库迁移没跑完。
     修完根因后**不需要**清队列：把同 id 的消息用 `requeue` 拉回即可
     （见第 4 节）。

4. **事故已经影响业务（SLA 超时）**：
   - 在 incident 频道发一句话：「reports 队列堆积 N 分钟，正在 restart
     worker / 横向扩容，ETA X 分钟」。
   - 完成后再发一条「已恢复，本次积压根因 = ……」。

### 3.3 不要做的事

- ❌ **不要**直接 `FLUSHDB` 或 `FLUSHALL` 业务 Redis db（会被业务缓
  存 / session 一锅端）。Celery broker 在 `REDIS_DB + 1`、result 在
  `+ 2`，可单独 flush 这两个 db，但**只在确认不会引发新副作用** 时
  才做。
- ❌ **不要**把 `task_acks_late` 改成 `False` 来"减少积压"——消息
  会被 worker 启动瞬间 ack 掉，但任务可能根本没跑完，监控就丢了。

## 4. DLQ → 主队列 恢复

本项目目前**没有显式 DLQ**（Dead Letter Queue），但 Celery 5.4 默认
对 ack 失败 / 超过 `max_retries` 的任务**不会自动进 DLQ**，而是把
异常写进 `celery-task-meta-*` 然后丢弃。前端 Job 表的 `FAILED` 状态
态就是事实源。

### 4.1 单条任务重新入队

在前端 Job 列表找到目标任务，用「重跑」按钮重新入队即可（也可用 CLI，见 4.2）。重新入队的任务会**重新跑一遍完整 body**；
如果是幂等任务（带 `INSERT ... ON CONFLICT` / `JobRun` 状态机
防重入）就安全，非幂等任务（写文件 / 触发外部 RPC）需要先确认不会
产生重复副作用。

### 4.2 批量把某次事故里的失败任务全部 requeue

走 CLI，更稳：

```bash
# 在 VPS 上进项目 venv
cd /root/believeboyDashboard/backend
source .venv/bin/activate

# 列出 broker 中所有失败任务的 id（走 result backend）
python - <<'PY'
from app.core.config import get_settings
from celery import Celery

app = Celery("believeboy",
             broker=get_settings()._celery_broker_url_resolved,
             backend=get_settings()._celery_result_url_resolved)

# 取最近 200 条 FAILURE 任务（按时间过滤可自己加 WHERE）
failed = app.backend.client.zrevrange("unacked", 0, 200)
print(f"Found {len(failed)} unacked/failed refs; pick what to requeue.")
for ref in failed:
    meta = app.backend.get(ref)  # noqa
    print(ref, meta.get("status"), meta.get("name"))
PY
```

挑出 id 后，逐个用前端「重跑」或 CLI 重新入队；**不要写脚本自动 requeue
一切**——失败原因可能跨多种任务类型，批量放回只会把脏数据再喂一
次 worker。

### 4.3 真要清队列（极端情况）

```bash
# 仅当 broker 完全错乱（broker 写盘损坏 / 业务主动 abandon）
redis-cli -n <broker_db> DEL celery  # 删除 broker 队列
# ⚠️ 上面这条会把 default+reports+insights 一锅端，请先在 incident
# 频道通报，并确认不会再有新消息灌进来。
```

## 5. 常见告警排查

### 5.1 Worker 反复 OOM

症状：journald 里反复看到：

```
believeboy-worker.service: Main process exited, code=killed, status=9/KILL
```

或花式 `MemoryError`、`Cannot allocate memory`。

排查路径：

1. `journalctl -u believeboy-worker -n 200 --no-pager | grep -E "Memory|OOM"` 看任务级别堆栈。
2. 90% 的 case 是**单条报告任务拉了整张 200w+ 行的 `monthly_reports` 表到
   Python list**。在 `app/services/report_*` 里找 `df = pd.read_sql(...)` 看是不是
   没用 `chunksize=`。
3. 临时止血：
   ```bash
   # 把 worker 暂停 5 分钟让任务在 broker 端排队，避免雪崩
   sudo systemctl stop believeboy-worker
   sleep 300
   sudo systemctl start believeboy-worker
   ```
4. 永久修复 PR 走正常的 code review 流程。

### 5.2 任务长时间 `RUNNING`（超过 30 分钟）

症状：前端 Job 表里某条任务卡在 `RUNNING` > 30min，worker
process 也一直没退。

排查路径：

1. **worker 进程是否还在**？
   ```bash
   systemctl status believeboy-worker
   ps -ef | grep -E "celery -A app.tasks" | grep -v grep
   ```
2. **worker 进程还在**：极可能是任务体里在 `await` 一个永不返回的对象
   （AI 聊天 / 文件上传 / HTTP 拉取）。Ssh 进 worker 主机，`py-spy dump
   --pid <worker_pid>` 看调用栈。
3. **worker 进程已不在**：journald 里看 killed 时间点前后的记录；多半
   是 5.1 的 OOM 走完后 broker 把消息 redelivery 给新 worker，新 worker
   从 `STARTED` 重新跑。`task_acks_late=True` 保护就是这个用途——你
   不需要手工 requeue。

### 5.3 Redis 连接拒绝

症状：journald 里反复 `redis.exceptions.ConnectionError: Error 111
connecting to ...`。

排查路径：

1. `redis-cli -h <REDIS_HOST> -p <REDIS_PORT> PING` 确认 Redis 还活着。
2. Redis 内存满了？`redis-cli INFO memory | grep used_memory_human`。
3. 怀疑 OOM killer：`dmesg -T | grep -i 'oom\|killed process'`。

### 5.4 月初 / 月末 全量任务集中入队

`reports` 队列在每月 1 号凌晨 / 28-31 号会出现 `ready > 500` 的毛刺，
属于**正常业务高峰**，**不要按"堆积"告警**。处理：

- 把 `REPORTS_QUEUE_THRESHOLD`（业务监控里）调成 1000。
- 短期内不扩容，**业务自然**在 2-3 小时内消化完。

## 6. 横向扩展（备查）

> 这一节**不是 P4 验收的硬性要求**，仅供未来扩容参考。

把单 worker 进程扩成 N 个 worker 进程，每进程 `-c 4`，总共 `N × 4`
并发槽位：

```bash
cd /root/believeboyDashboard/backend
# 关掉 systemd 单元（不要同时跑）
sudo systemctl stop believeboy-worker
# 拉起 3 个 worker 进程
./run_worker.sh multi 3
# 验证
./run_worker.sh ping
ls run/celery/  # 3 个 pidfile
```

横向扩展后会**绕过** systemd 的 `Restart=always`——要恢复自动拉起
行为，需要写一个新的 systemd 单元（`believeboy-worker@.service`），
用 `celery multi start N` 替换 `ExecStart`，并 `systemctl enable
celery-workers.target`。这一改造不在本 issue 范围内，等真的需要时
另起子 issue。

## 7. 链接

- BEL-55-P0（broker + worker 基建）：[BEL-68](mention://issue/c713c1f1-697e-4770-8f54-f43d08e48fd0)
- BEL-55-P1（run_job 迁移）：[BEL-69](mention://issue/a9e277c7-03f7-46e3-b2a2-6fb87f1d1d82)
- BEL-55-P2（AI 洞察迁移）：[BEL-70](mention://issue/02f38ac1-b23a-458e-9aed-994198b1b305)
- BEL-55-P3（关闭月报内存表）：[BEL-71](mention://issue/bc5fdac3-deaf-40db-a6b3-0e7b9e8ebc47)
- 本 issue：[BEL-72](mention://issue/00d5c284-a29f-4581-8a97-021e3ca37455)
- backend `REDIS_PLAN.md`：Celery / Redis 选型 + 部署计划
- backend `docs/deployment-runbook.md`：API 侧部署手册
