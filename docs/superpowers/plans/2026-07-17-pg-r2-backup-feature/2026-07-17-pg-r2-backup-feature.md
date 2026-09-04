# 方案:数据库备份功能页面 —— 前端一键触发 PG 备份并上传 Cloudflare R2

- **日期**:2026-07-17
- **状态**:P0/P1 关键决策 5 条已 frozen(Q1/Q2/Q3/Q4/Q5 用户已拍板);**其余 6 条待评审**(见 §10,主要是 P0-2/P0-4/P1-1/P1-4/P2-1/P2-2 实现细节),拍板后即可进入 Phase 1 实现。
- **目标读者**:实现该功能的后端 / 前端工程师

---

## 0. 一句话总结

把"前端点击 → 后端跑 `pgbackrest` 全量 / 增量备份 → 备份归档上传到 Cloudflare R2 → 在前端展示进度 / 历史 / 下载"这条**端到端链路**打通,并加上**每日凌晨自动备份**、**保留策略**、**异步化**、**失败重试**等生产必备能力。

---

## 1. 现状盘点(做之前先看清仓库里已经有什么)

> 调研方法:`grep` 关键词 + 读关键文件。**结论:前端 UI、后端 API、DB 模型、R2 客户端、pgbackrest 命令封装都已存在**,但**关键链路是断的**,需要在它们之间补齐异步化、R2 上传、定时、保留、轮询五件大事。

### 1.1 已存在 ✅

| 模块 | 位置 | 备注 |
| --- | --- | --- |
| **前端 UI** | `frontend/app/dashboard/system/backup-management/{page.tsx,backup-management-client.tsx}` | 已是功能页:概览卡 / 记录表 / pgBackRest 信息 / 手动备份弹窗 / 验证按钮。已在调用 `/api/v1/backups/{status,records,trigger,verify,info,health}` |
| **后端 API** | `backend/app/api/v1/endpoints/backups.py` | 6 个端点全实现,`X-Is-Admin` 鉴权已就位 |
| **DB 模型** | `backend/app/models/backup_record.py` | `backup_records` 表 + 3 个 status 枚举 + 3 个 type 枚举 + 3 个索引 |
| **pgbackrest 封装** | `backend/app/services/backup_service.py` | `_run_pgbackrest` / `trigger_backup` / `verify_backups` / `get_raw_backup_info` 等函数齐了 |
| **R2 客户端** | `backend/app/services/r2_service.py` | `upload_file_to_r2` / `upload_bytes_to_r2` / `check_file_exists` / `download_file_to_path` / `try_delete_file_from_r2` 全部就绪 |
| **Celery 基础** | `backend/app/celery_tasks/{run_job,scheduled_report,ai_summary,ping}.py` + `app.tasks.celery_app` | task 装饰器、`acks_late=True` / `max_retries=3` / `soft_time_limit` 模式、`@shared_task` 路由都已成例 |
| **环境变量** | `backend/.env.example:137-144` | R2 6 个字段(`R2_*`)已留好占位 |

### 1.2 缺失 ❌(本次设计要补的 7 个洞)

| # | 缺失 | 影响 |
| --- | --- | --- |
| **D1** | **`trigger_backup` 是同步阻塞 `subprocess.run(timeout=7200)`** —— 在 API 进程内直接跑 | API 请求挂 2 小时;多 worker 部署时 `BackupStatus.RUNNING` 在不同 worker 内存里互不可见,状态错乱 |
| **D2** | **没有 R2 上传** —— `pgbackrest` 备份数据只落到本地仓库(默认 `/var/lib/pgbackrest`),从未上传 R2 | "上传到 CF R2" 完全没实现,目前的备份离开 VPS 即丢 |
| **D3** | **没有异步任务** —— 备份流程没用 Celery | API 进程风险 + 没有 broker 持久化 + 无重试 + 无进度上报 |
| **D4** | **没有定时备份** —— 前端文案"每天凌晨 3:00 自动备份"是空头支票 | 用户以为有,实际没有 |
| **D5** | **`BackupRecord` 没有 R2 字段** —— 没有 `r2_key` / `r2_url` / `r2_uploaded_at` | 不知道备份在 R2 哪里,无法下载/恢复/统计存储用量 |
| **D6** | **没有保留策略** —— 本地仓库和 R2 都没设 retention | R2 账单随时间线性增长;旧备份无限堆积 |
| **D7** | **前端没有轮询 / 进度** —— `useEffect` 只在挂载时拉一次,没有轮询 `running` 任务状态;没有 R2 文件列表 / 下载按钮 / 恢复入口 | 用户看不到进度、点完按钮不知道何时完 |

### 1.3 现状到目标的关键事实

- **生产端 db 是 `pgbackrest` 而不是 `pg_dump`**(`backup_service.py:32` 用 `pgbackrest info --stanza=blf`、第 64 行 `["backup", "--stanza=blf"]` 全程走 `pgbackrest`)。这意味着:
  - 备份产物是 **pgbackrest 自家格式**(`/var/lib/pgbackrest/backup/blf/...` 一棵目录树),不是单文件 `.sql` / `.dump`。
  - 真正的"上传 R2"对象应该是 **pgbackrest archive 目录**或**单次备份目录**打成 tar.gz。
  - 不存在"把 SQL 灌回去"这种简单恢复路径;恢复要走 `pgbackrest restore --stanza=blf --type=... --set=...`。
- **R2 客户端现成**:`upload_file_to_r2` 接受 `BinaryIO`,可以直接喂 `Path.open("rb")`。
- **Celery 现有 queue**:`default / reports / insights / ai_summary / scheduled`(参考 `2026-07-10-scheduled-report-to-celery` plan)。本次**新增 `backups` 队列**避免与现有重活竞争。

---

## 2. 目标 / 非目标

### 2.1 目标(必须达成)

1. **G1**:前端 `/dashboard/system/backup-management` 点击「手动备份」后,**5 秒内**得到 `202 Accepted` + `record_id`,按钮变"进行中"轮询状态。
2. **G2**:Celery worker 在 `backups` 队列里跑完 `pgbackrest` 备份,完成后**自动归档目录 → tar.gz → 上传 R2** → 回写 `r2_key / r2_url / size_bytes / r2_uploaded_at`。
3. **G3**:前端通过 `GET /backups/records/{id}` 看到实时状态(`pending / running / uploading / completed / failed`)与阶段(`backup_phase` 字段)。
4. **G4**:**每日凌晨 03:00**(生产时区)自动跑一次全量备份,通过 Celery Beat 触发。
5. **G5**:保留策略:本地仓库保留最近 **7 份全量 + 全部增量**,R2 保留最近 **7 份**(可在 `.env` 调,默认 `R2_BACKUP_RETENTION_COUNT=7`),超期由 Celery Beat 周期清理任务删除 R2 对象。**用户决策(2026-07-17)**:R2 保留与本地对齐为 7 份,定位 R2 为"每周异地灾备"。
6. **G6**:前端可一键**生成 R2 临时下载链接**(`presigned_url`, 1 小时有效)给运维拿回来;并暴露 `pgbackrest restore --set=...` 命令的**干跑预览**(不真执行,只生成可复制粘贴的命令文本 + 风险提示)。
7. **G7**:所有失败写入 `error_message`,worker 跑挂 broker 重投 ≤3 次不重复上传(幂等护栏)。

### 2.2 非目标(本次明确不做)

- N1 不做 R2 → 本地的"自动恢复"按钮(只做命令预览,避免误操作炸生产 db)。
- N2 不做 PITR(Point-in-Time Recovery)的精细化时间点恢复(只做 set 级恢复)。
- N3 不做异地多 R2 bucket 复制(只用一个 bucket)。
- N4 不动 `pgbackrest` 的 stanza / repository 配置(假设运维已配好 `blf` stanza;`is_backup_configured()` 已能 check)。
- N5 不重构 `scheduled_report` 的 Celery 模式(本方案沿用其 `@shared_task` + `acks_late` 范式)。
- N6 不做备份加密(假设 R2 侧走 `r2_bucket_name` 的 bucket-level SSE 即可)。

---

## 3. 关键设计决策(待评审 P0–P3 共 11 条)

> 每条决策**先说我的推荐 + 理由**,如有替代方案也一并给出。等用户逐条拍板后冻结。

### 3.1 P0-1 备份异步化:从 API 进程迁到 Celery worker ⭐ 承重墙

- **现状**:`backup_service.py:trigger_backup()` 在 API 进程内同步 `subprocess.run(..., timeout=7200)`。
- **风险**:
  - 单次备份占 API 进程 2h,期间 API 卡死(慢查询、Playwright 截图同理,见 `2026-07-10-scheduled-report-to-celery` 背景);
  - API 多 worker(规划 `--workers 4`,见 `deployment-runbook.md`)时,每个 worker 独立内存,`BackupStatus.RUNNING` 在不同进程互不可见;
  - 没有 broker 持久化:API 重启 = 备份在途丢失。
- **方案**:**新增 `app.celery_tasks.backup:run_backup_task`**,API 端只 `record_id = db INSERT (status=pending) + run_backup_task.delay(record_id)`,5 ms 返回。
- **task 参数**:只传 `record_id`,**不传 `backup_type` / 时间戳**(全部从 DB 读,保证重投时拿到的状态与首次一致)。
- **decorator 范式**(参考 `run_job.py:55-65`):
  ```python
  @shared_task(
      name="app.celery_tasks.backup.run_backup_task",
      bind=True, acks_late=True, max_retries=2,
      default_retry_delay=60,
      soft_time_limit=BACKUP_SOFT_TIME_LIMIT,  # 默认 90 分钟
      time_limit=BACKUP_HARD_TIME_LIMIT,       # 默认 120 分钟
  )
  ```
- **time_limit 取值依据**:全量备份 P99 未知,先用 `90 / 120 min` 占位,Phase 1 实现前**必须**跑一遍生产 `pgbackrest info` 历史数据,按 `duration` 字段统计 P50/P90/P99 调上下限(参考 `2026-07-10-scheduled-report-to-celery` §4.8 流程)。

### 3.2 P0-2 阶段状态机 + 幂等护栏 ⭐ 承重墙

- **目标**:
  1. worker 重投不重复跑 `pgbackrest`(避免半途插入重复 backup set);
  2. 上传 R2 不重复传(避免 R2 上同一对象多份);
  3. API 多 worker 触发同一 record 不并发执行。
- **方案**:
  - **阶段字段**:在 `BackupRecord` 加 `phase: String(20)`,值域 `pending → pgbackrest_running → compressing → r2_uploading → completed / failed`(默认 `pending`)。
  - **数据库幂等键**:`(id, phase)` 唯一保护不够;改用 `SELECT ... FOR UPDATE SKIP LOCKED` 拿到行锁后,`if phase IN ('r2_uploading', 'completed'): return`(短路返回)。
  - **Celery 任务幂等性**:`run_backup_task(record_id)` 入口:
    1. `db.get(BackupRecord, record_id, with_for_update=True)` 拿行锁;
    2. 若 `status='completed' and r2_uploaded_at is not None` → 直接 return(已成功);
    3. 若 `status='failed' and retry_count >= max_retries` → 不再重试,return;
    4. 推进 phase 之前,**用乐观锁**:`UPDATE backup_records SET phase=:next WHERE id=:id AND phase=:current`,affected=0 说明别的 task 抢先了,return。
  - **R2 幂等**:上传前用 `check_file_exists(r2_key)` 检查;若存在且 `r2_uploaded_at` 已写,跳过上传(避免重复传)。`r2_key` 命名 `backups/blf/{start_ts}_{type}_{record_id}.tar.gz`,record_id 后缀保证唯一。
- **理由**:参考 `scheduled_report` plan 的 P0-2/P0-3 决策,同样的"邮件承重墙"模式,只是这里"承重墙"是 **R2 对象不重复 + 状态机不乱跳**。

### 3.3 P0-3 R2 上传在 worker 内做(不在 API 端)

- **方案**:`pgbackrest` 跑完后,worker 在 worker 进程内:
  1. `pgbackrest info --stanza=blf --output=json` 解析拿到最新 backup set 的目录路径(如 `/var/lib/pgbackrest/backup/blf/20260717-030000-F/`);
  2. `tar -czf /tmp/{record_id}.tar.gz -C /var/lib/pgbackrest/backup/blf {set_name}/`(临时目录,跑完删除);
  3. `upload_file_to_r2(settings, open(tar_path, 'rb'), filename=..., project_slug='db-backups', file_type='pgbackrest')`;
  4. 写回 `r2_key` / `r2_url` / `r2_uploaded_at` / `compressed_size_bytes` / `r2_bucket`;
  5. 删 `/tmp/{record_id}.tar.gz`。
- **R2 路径设计**:
  - `key = db-backups/pgbackrest/blf/{YYYY-MM-DD}_{type}_{record_id}.tar.gz`
  - **为什么带 `record_id`**:同名(同日同 type)不会撞;删除时可定位到 record;前端可拼出下载链接。
- **压缩选项**:`tar -czf`(gzip 压缩,默认 6 级)→ 一般可压到原目录 30-50%;若全量太大,Phase 5 数据验证后再切 `zstd` 提速。
- **不传整个 `/var/lib/pgbackrest`**:只传**单次 backup set 目录**;WAL archive 不进 R2(只让全量 / 增量进 R2,WAL 由本地 repo 自己 retain)。

### 3.4 P0-4 DB 模型补 4 个 R2 字段 + 1 个 phase 字段

- **新增字段**(alembic 迁移):
  | 字段 | 类型 | 含义 |
  | --- | --- | --- |
  | `phase` | `String(20)` | `pending / pgbackrest_running / compressing / r2_uploading / completed / failed`,默认 `pending` |
  | `r2_key` | `String(500)` | R2 对象 key,成功上传后写 |
  | `r2_url` | `String(1000)` | 公开 URL(用 `r2_public_url` 拼) |
  | `r2_bucket` | `String(200)` | bucket 名(冗余存储,便于审计) |
  | `r2_uploaded_at` | `DateTime(timezone=True)` | 上传成功时间 |
  | `r2_deleted_at` | `DateTime(timezone=True)` | R2 对象被 retention 清理时写(记录行不删) |
  | `compressed_size_bytes` | `BigInteger` | tar.gz 大小(用于显示 "R2 用了多少") |
  | `backup_set_name` | `String(100)` | pgbackrest set 名(如 `20260717-030000-F`),便于 restore |
  | `backup_set_path` | `String(500)` | set 在本地的绝对路径(便于审计) |
  | `retry_count` | `Integer`,默认 0 | worker 重投次数 |
  | `triggered_by` | `String(20)`,默认 `manual` | `manual / auto`,便于审计 |
- **新索引**:`Index("idx_br_phase", "phase")` + `Index("idx_br_r2_key", "r2_key")`(后者用于 R2 retention 清理时反查 record)。
- **不破坏**:`backup_records` 现有 8 个字段 + 3 个索引全保留;alembic migration 纯加列,可平滑回滚。

### 3.5 P1-1 新增 `backups` Celery 队列 + 独立 worker 进程

- **新 queue**:`backups`(路由 `task_routes` 加 `"app.celery_tasks.backup.run_backup_task": {"queue": "backups"}`)。
- **新 systemd unit**:`backend/deploy/systemd/believeboy-worker-backups.service`:
  ```
  ExecStart=...celery -A app.tasks.celery_app worker -Q backups -c 1 --loglevel=info
  ```
  `-c 1`:一次只跑 1 个备份(磁盘 IO 瓶颈,真并发没意义)。
- **理由**:
  1. 备份是 IO 重活,与 Playwright 截图(`scheduled` 队列)、手动月报(`reports` 队列)互不抢;
  2. 备份任务可能跑 1-2h,单进程隔离便于内存 / 句柄泄漏排查;
  3. `-c 1` 强制单并发,避免两个备份同时 IO 互锁。

### 3.6 P1-2 Celery Beat 调度:每日凌晨 03:00 全量备份

- **方案**:利用现有 Celery Beat(若未启用,需 `celery -A ... beat` 进程),加 beat schedule:
  ```python
  app.conf.beat_schedule = {
      "daily-pg-full-backup": {
          "task": "app.celery_tasks.backup.schedule_daily_backup_task",
          "schedule": crontab(hour=3, minute=0),
          "kwargs": {"backup_type": "full", "triggered_by": "auto"},
      },
  }
  ```
- **`schedule_daily_backup_task`**:thin wrapper,做 `INSERT (status=pending, type=full, triggered_by='auto') + run_backup_task.delay(record_id)`。
- **不与 APScheduler 重复**:不再走 API 进程内的 `app.core.scheduler`;若现有 beat 计划里没有则新增。
- **多副本安全**:`celery beat` 必须**单实例**(约定通过 systemd `WantedBy=`,只能 enable 一台);`run_backup_task` 内的 P0-2 乐观锁护栏保证即便误启多 beat 也不会重复跑。

### 3.7 P1-3 保留策略:本地 + R2 双层 retention

- **本地 repo**:`pgbackrest` 自己的 `retention-full` / `retention-diff` 配置决定(运维侧,本次不动 `pgbackrest.conf`);默认值假设是 `retention-full=7` / `retention-diff=14`。
- **R2 保留**:新增 `app.celery_tasks.backup:cleanup_r2_task`,Beat schedule `crontab(hour=4, minute=30)`(凌晨 4:30,排在 03:00 自动备份之后):
  1. 拉 `backup_records WHERE r2_uploaded_at IS NOT NULL AND r2_deleted_at IS NULL ORDER BY r2_uploaded_at DESC`;
  2. 跳过前 `R2_BACKUP_RETENTION_COUNT` 条(**用户决策 2026-07-17:默认 7**,与本地 `retention-full=7` 对齐,R2 定位为"每周异地灾备");
  3. 对超出部分的每条记录,`try_delete_file_from_r2(key)`(已有函数,自动捕获 BotoCoreError 不抛);
  4. 删除成功后 `UPDATE r2_deleted_at = now()`(不删 record 行,留审计);
  5. 失败的对象写入新表 `r2_delete_failures`(可借鉴 `app.services.r2_service:R2DeleteResult`,本方案不强制建表,失败先 log,Phase 5 决定是否建表)。
- **为什么不直接用 S3 lifecycle policy**:R2 支持 S3 lifecycle 但配置繁琐;且本方案要"删 R2 时同步更新 DB 的 r2_deleted_at",放代码里更可控。

### 3.8 P1-4 前端轮询 + 进度展示

- **方案**:
  - **轮询触发**:`useEffect` 监听 `records` 里任何一条 `status IN ('pending', 'running', 'uploading')` → 启动 `setInterval(loadData, 3000)`,全部完成后 `clearInterval`。
  - **不引入 WebSocket / SSE**:保持简单;备份通常 ≤ 2h,3s 轮询 2400 次可接受。
  - **进度展示**:`last_backup` 卡片下加一个 phase 进度条组件:
    - `pending` → "排队中" 灰
    - `pgbackrest_running` → "执行 pgbackrest" 蓝
    - `compressing` → "打包中" 紫
    - `r2_uploading` → "上传 R2" 青
    - `completed` → "完成" 绿
    - `failed` → "失败" 红
  - **实时大小**:`size_bytes`(pgbackrest 报告大小)与 `compressed_size_bytes`(压缩后)分开显示;上传阶段显示进度用 `pgbackrest` stdout 的"已处理字节"行解析(复杂,Phase 1 先做"压缩中 / 上传中"两段无数字,Phase 2 再加数字)。
- **新依赖**:无(纯 React state + `setInterval`)。
- **轮询退出条件**:`records.every(r => r.status === 'completed' || r.status === 'failed')`。

### 3.9 P1-5 前端:备份详情 / 下载 / 恢复干跑 + 命令预览

- **记录表行展开**:点击行展开 detail 面板(不用路由,Modal 或 inline expand 二选一,推荐 inline expand 与现有风格一致):
  - `pgbackrest info` 解析后的 metadata(原 `backup_info` JSON,前端 pretty-print 关键字段:db 大小 / 备份类型 / 起止时间);
  - **R2 文件信息**:`r2_key` / `r2_bucket` / `compressed_size_bytes` / `r2_uploaded_at`;
  - **下载按钮**:`GET /backups/{id}/download-url` → 后端返回 `presigned_url(1h)` → 前端 `<a href target=_blank>`;`Content-Disposition: attachment` 走 R2 端 `ResponseContentDisposition` 参数。
  - **恢复干跑按钮**:`POST /backups/{id}/restore-dry-run` → 后端**实际执行** `pgbackrest restore --stanza=blf --set={set_name} --type=time --target={target_time} --target-action=pause --dry-run`(假设该 set 在本地 repo 仍在 retention 内;若已被本地清理则报 422),抓 stdout/stderr 返回;前端展示干跑日志 + 一个黄色"⚠️ 仅校验,不写库"提示。
  - **恢复命令预览**:`GET /backups/{id}/restore-command?target_time=2026-07-17T10:00:00Z` → 后端返回可复制的 `pgbackrest restore --stanza=blf --set=...` 命令文本(去掉 `--dry-run` 即可真执行);UI 给一个红色警告"此操作会覆盖目标数据库,生产前请在测试环境验证"。
  - **删除按钮**(仅 `completed` 状态):`DELETE /backups/{id}` → 后端删 R2 对象 + 软删 record(`r2_deleted_at = now()`);二次确认 `useConfirm`。
- **权限**:与现有 `require_admin` 一致,所有新端点继承。
- **用户决策(2026-07-17)**:Q5 选"干跑(dry-run)" — 后端真跑 `--dry-run` 让用户看到实际校验结果,比纯命令文本更有用;同时保留"恢复命令预览"按钮(给真正要执行的运维拷贝命令)。

### 3.10 P2-1 双触发源互斥:自动 vs 手动

- **场景**:03:00 自动跑时,管理员手动也点了一份。
- **方案**:
  - 互斥**不做**(不阻止并发);`P0-2` 行锁 + 乐观锁保证两份都跑完但 R2 key 不撞(`record_id` 后缀唯一);
  - `triggered_by` 字段(`manual / auto`,已在 §3.4 字段表加);
  - 前端记录表加列 `触发方式` 显示;自动任务的 `created_by = null`。

### 3.11 P2-2 API 端点扩展(共 6 个 → 9 个)

| 端点 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- |
| `POST /backups/trigger` (已有) | 触发手动备份 | admin | **改造**:5ms 返回 + `record_id`,不阻塞 |
| `GET /backups/{id}` (新) | 单条 record 详情(含 phase / r2_key) | admin | 给前端轮询用 |
| `GET /backups/{id}/download-url` (新) | 拿 R2 presigned URL | admin | 1h 有效 |
| `POST /backups/{id}/restore-dry-run` (新) | 真跑 pgbackrest restore --dry-run,返回日志 | admin | **用户决策**:实际校验,不写库 |
| `GET /backups/{id}/restore-command` (新) | 生成可复制的恢复命令文本 | admin | 不真执行,给运维复制 |
| `DELETE /backups/{id}` (新) | 软删 record + 删 R2 | admin | 二次确认 |
| `POST /backups/cleanup` (新) | 手动触发 R2 retention | admin | 一般不用,留 ops 入口 |
| 已有 6 个端点 | status / records / trigger / verify / info / health | 视情况 | trigger / records 加 `phase` 字段透出 |

---

## 4. 端到端流程图(从点击到 R2)

```
┌────────────┐   POST /backups/trigger  ┌──────────────────────────────────────┐
│  前端 UI   │ ──────────────────────▶ │ API:  INSERT backup_records          │
│ backup-mgt │                          │       status=pending, phase=pending   │
│            │ ◀───── 202 + record_id ─│       .delay(run_backup_task, id)     │
└────────────┘                          └──────────────────────────────────────┘
                                                 │
                                  ┌──────────────┴───────────────┐
                                  ▼                              ▼ (timeout)
                       ┌──────────────────┐         ┌──────────────────────┐
                       │ Celery worker    │         │ retry (≤ 2 次)       │
                       │ queue=backups    │         │ default_retry_delay  │
                       │ -c 1             │         │ = 60s                │
                       └──────────────────┘         └──────────────────────┘
                                  │
                  1) 行锁 + phase 短路(已 completed return)
                                  │
                  2) phase=pgbackrest_running, 跑 pgbackrest backup --stanza=blf --type={type}
                                  │
                  3) phase=compressing,  tar -czf /tmp/{id}.tar.gz {set_name}/
                                  │
                  4) phase=r2_uploading,  upload_file_to_r2(...)
                                  │
                  5) phase=completed, 写 r2_key / r2_url / r2_uploaded_at
                                  │
                  6) rm /tmp/{id}.tar.gz
                                  │
                  ┌───────────────┴────────────────┐
                  ▼                                ▼
        ┌────────────────────┐         ┌──────────────────────┐
        │ GET /backups/{id}  │         │ Celery Beat 04:30     │
        │ 前端 3s 轮询       │         │ cleanup_r2_task       │
        │ 显示 phase 进度    │         │ 保留前 7 份, 删其他  │
        └────────────────────┘         └──────────────────────┘
                                                       │
                                                       ▼
                                            try_delete_file_from_r2
                                            UPDATE r2_deleted_at=now()
```

---

## 5. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `backend/app/celery_tasks/backup.py` | **新建**:`run_backup_task` / `schedule_daily_backup_task` / `cleanup_r2_task` |
| `backend/app/tasks/celery_app.py` | `include += ["app.celery_tasks.backup"]`;`task_routes += {"app.celery_tasks.backup.run_backup_task": {"queue": "backups"}}`;`beat_schedule` 加 2 条 |
| `backend/app/services/backup_service.py` | **改造**:`trigger_backup` 拆为 `_run_pgbackrest_backup` (worker 内部用) + `enqueue_backup` (API 端用,只 insert + delay);新增 `_archive_to_tar_gz` / `_upload_to_r2` 私有函数;新增 `get_record_by_id` / `get_r2_download_url` / `run_restore_dry_run` / `get_restore_command` / `soft_delete_record` |
| `backend/app/api/v1/endpoints/backups.py` | **改造**:`POST /trigger` 改为 `enqueue_backup` + 5ms 返回;新增 5 个端点(`GET /{id}` / `GET /{id}/download-url` / `POST /{id}/restore-dry-run` / `GET /{id}/restore-command` / `DELETE /{id}`) |
| `backend/app/schemas/backup.py` | **改造**:`BackupRecordItem` 加 phase / r2_key / r2_url / r2_bucket / r2_uploaded_at / r2_deleted_at / compressed_size_bytes / backup_set_name / retry_count / triggered_by 字段;新增 5 个 ResponseSchema |
| `backend/app/models/backup_record.py` | **改造**:加 11 个新字段(见 §3.4 表);加 2 个新索引 |
| `backend/alembic/versions/xxxx_add_r2_fields_to_backup_records.py` | **新建**:alembic 迁移,纯加列 + 2 索引,可平滑回滚 |
| `backend/app/core/config.py` | **改造**:新增 4 个字段(见 §11 配置项);`backup_soft_time_limit` / `backup_hard_time_limit` / `backup_r2_retention_count` / `backup_daily_schedule_hour` |
| `backend/.env.example` | **改造**:补 4 个配置项 + 注释 |
| `backend/deploy/systemd/believeboy-worker-backups.service` | **新建**:`-Q backups -c 1` 独立 unit |
| `frontend/app/dashboard/system/backup-management/backup-management-client.tsx` | **改造**:加 phase 进度条;3s 轮询逻辑(条件触发);下载/恢复预览/删除 3 个按钮 + Modal |
| `frontend/app/dashboard/system/backup-management/page.tsx` | 不动 |
| `frontend/lib/api/backups.ts` (或类似) | **新建**(或扩现有):封装 `getBackupRecord` / `getDownloadUrl` / `getRestoreCommand` / `deleteBackup` |
| `docs/REFERENCE.md` | **改造**:Background Jobs 段加 backups 队列说明 + R2 retention 策略 |
| `docs/deployment-runbook.md` | **改造**:补 `believeboy-worker-backups.service` 部署 + Celery Beat 多实例约束 |

**不改动**:`pgbackrest.conf`(运维侧) / `backup_service.py` 的 pgbackrest 命令封装函数体 / 前端 `page.tsx` / DB 表名 / 任何 R2 客户端函数。

---

## 6. 落地 Phase

### Phase 1 — DB schema + Celery task 骨架(异步化承重墙)

- 新建 alembic 迁移(§3.4 字段)
- 新建 `backend/app/celery_tasks/backup.py`:
  - `run_backup_task(record_id)`: 行锁 + 状态机推进(本阶段只做 `pending → pgbackrest_running → completed/failed`,**还不做 R2 上传**)
  - `schedule_daily_backup_task(backup_type, triggered_by)`: thin wrapper
- 改造 `backup_service.py:trigger_backup` → 拆为 `_run_pgbackrest_backup` (worker 用) + `enqueue_backup` (API 端只 insert + delay)
- 改造 `POST /backups/trigger` → 5ms 返回 + `record_id`
- 验证:**手动触发**一份能看到 phase 跑完,status=completed,**但 R2 还没东西**(Phase 2 接上)

### Phase 2 — R2 上传链路 + 详情 / 下载 / 恢复命令

- 改造 `run_backup_task`:phase 推 `compressing → r2_uploading → completed`,落 9 个新字段
- 改造 `backup_service.py`:加 `_archive_to_tar_gz` / `_upload_to_r2` 私有函数
- 新增 4 个 API 端点:`GET /{id}` / `GET /{id}/download-url` / `GET /{id}/restore-command` / `DELETE /{id}`
- 前端:加 `getBackupRecord` / `getDownloadUrl` / `getRestoreCommand` / `deleteBackup` API 封装
- 验证:手动跑一份,phase 跑到 `completed`,R2 上能看到 `db-backups/pgbackrest/blf/...tar.gz`,点下载能拉下来 `tar -tzf` 看 set 目录结构

### Phase 3 — 前端轮询 + 进度条 + 详情 UI

- `backup-management-client.tsx`:
  - 3s 轮询(条件触发,全部 completed/failed 后停)
  - phase 进度条组件(`pending / pgbackrest_running / compressing / r2_uploading / completed / failed`)
  - 记录表行展开:显示 R2 信息 / 大小 / pgbackrest metadata
  - 下载 / 恢复干跑 / 恢复命令预览 / 删除 4 个按钮 + Modal
- 验证:UAT 录屏:点击 → 看到进度条推进 → 完成后能看到 R2 信息 + 下载链接 + 恢复干跑日志 + 恢复命令文本

### Phase 4 — Celery Beat 调度 + 自动备份 + 独立 worker 进程

- `celery_app.py` beat_schedule 加 2 条(`daily-pg-full-backup` + `r2-cleanup`)
- `backend/deploy/systemd/believeboy-worker-backups.service` 新建
- VPS 上:`systemctl daemon-reload && systemctl enable --now believeboy-worker-backups` + 启用 Celery Beat 进程
- `deployment-runbook.md` 补 Beat 多实例约束
- 验证:把 `crontab(hour=3, minute=0)` 临时改成 5 分钟后,等 5 分钟看到自动 record 落地并跑完;再恢复成 03:00

### Phase 5 — R2 保留策略 + 软删 + 监控

- `cleanup_r2_task` 实现(§3.7)
- `R2_BACKUP_RETENTION_COUNT` 配置化(默认 7)
- 验证:手动塞 12 条 record(用 `INSERT`),跑一次 `cleanup_r2_task`,前 7 留,后 5 个 R2 key 消失 + `r2_deleted_at` 被写

### Phase 6 — 灰度与回滚(不依赖代码改动)

- **回滚开关**(沿用 `2026-07-10-scheduled-report-to-celery` 的双开关模式):
  - `BACKUP_VIA_CELERY=true` (默认):API 端走 `.delay()`(新路径)
  - `BACKUP_VIA_CELERY=false`:**回滚形态**,API 端走旧 `subprocess.run(同步)`(本方案**保留旧函数体不删**,作为回滚兜底)
- **回滚 = 改 env + 重启 API,零代码改动**;Celery worker 任务如果已经在跑,会被新代码路径自然消费完。
- **生产灰度顺序**:
  1. 部署代码,`BACKUP_VIA_CELERY=false` → 旧路径跑,新代码空载
  2. 验证:`enqueue_backup` 单测过(不真发 Celery)
  3. 启动 `believeboy-worker-backups` 进程,观察 worker 日志
  4. 切 `BACKUP_VIA_CELERY=true` 一次(只在一台 API 副本)
  5. 手动触发一份,观察 5min 内 R2 上出现新对象

---

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| **`tar` 临时文件占满 /var** | 用 `/tmp` 即可(默认有空间);上传后立即 `rm`;若 Vmstat 报警,Phase 2 实现后观察一周再调 |
| **R2 上传时 worker 进程被杀 → 半成品对象** | `upload_file_to_r2` 用 multipart upload 还是单 PUT?本方案走 `upload_fileobj` 单 PUT(已有);R2 端 `Content-MD5` 校验(可选,Phase 1 暂不强制);下次 `cleanup_r2_task` 扫到 `r2_uploaded_at IS NULL` 的孤儿对象时按 7 天策略删(Phase 5 加) |
| **Celery Beat 多实例同时触发自动备份** | systemd `WantedBy=` 单实例约束 + P0-2 乐观锁护栏(即便误启 2 个 beat,数据库层兜底) |
| **API 多 worker 触发同一 record 并发** | P0-2 `SELECT FOR UPDATE` 行锁 + `phase` 乐观锁,DB 层兜底 |
| **pgbackrest 全量备份 P99 > 2h 触顶 time_limit** | Phase 1 实现前先跑 `pgbackrest info` JSON 里的 `duration` 字段统计;`BACKUP_SOFT_TIME_LIMIT` / `BACKUP_HARD_TIME_LIMIT` 占位 90/120 min,跑出来再调 |
| **大文件上传触发 nginx / haproxy 代理超时(若有)** | R2 走 `endpoint_url` 直连,不经反代(参考 `r2_service.py:get_r2_client`);无此风险 |
| **前端轮询风暴(200 个用户同时点 200 个 record)** | 每个 tab 独立轮询;`/api/v1/backups/{id}` 是单条 record 查询(DB 索引 PK),无 N+1;3s 间隔够 |
| **R2 凭据泄漏** | 与现有 R2 客户端共用同一套凭据,本方案不引入新凭据;`R2_*` 6 个字段已在 `.env` 走 Vault 加载 |
| **alembic 迁移失败** | 纯加列 + 2 索引,回滚用 `alembic downgrade -1` 即可 |

---

## 8. 测试策略

1. **单测**:
   - `_archive_to_tar_gz`:传入 mock 的 set 目录,断言 tar.gz 字节流 + 临时文件清理
   - `_upload_to_r2`:patch `upload_file_to_r2`,断言调用参数 + `r2_key` 拼写
   - 状态机:`run_backup_task` 入口 6 个分支(行锁命中 / 已 completed / failed 重试上限 / phase 推进 / 失败回滚)
   - `cleanup_r2_task`:mock 12 条 record,断言只删 5 条 + `r2_deleted_at` 正确写
2. **集成**(手动):
   - `enqueue_backup(type='full', user_id=1)` → DB 有 record + Celery task 入队
   - worker 起来后看 phase 演进日志(`logger.info("phase=... msg=...")`)
   - R2 上 `s3-cli ls s3://bucket/db-backups/pgbackrest/blf/` 看到新对象
   - presigned URL 用 `wget` 拉下来,`tar -tzf` 看 set 目录结构完整
   - 恢复命令预览:`GET /backups/{id}/restore-command?target_time=...` 拿到命令文本,人工对一遍参数正确
3. **失败注入**:
   - 把 `R2_SECRET_ACCESS_KEY` 改错,跑一份,断言 `status=failed, error_message` 含 `InvalidAccessKeyId`
   - `pgbackrest` 假造失败(用 `--type=invalid` 让它报错),断言 `phase=pgbackrest_running, status=failed, retry_count=1`
   - worker kill -9 中途,broker 重投后断言:**没有产生 R2 孤儿对象**(因为 P0-2 在 `r2_uploading` 阶段才进上传,前面阶段不传)
4. **回归**:
   - `scheduled_report` / `run_job` / `generate_insight` 不受新 `backups` 队列影响
   - 现有 `POST /backups/trigger` 旧行为:旧路径(`BACKUP_VIA_CELERY=false`)下与之前完全一致

---

## 9. 验收标准

- [ ] 前端点击「手动备份」,5 秒内收到 `202 + record_id`,按钮变"进行中",开始 3s 轮询
- [ ] phase 进度条依次走 `pending → pgbackrest_running → compressing → r2_uploading → completed`,全过程在 UI 可见
- [ ] R2 控制台(或 `aws s3 ls`)能看到 `db-backups/pgbackrest/blf/{date}_{type}_{record_id}.tar.gz`
- [ ] 记录表行展开后,能看到 R2 元信息(大小 / 上传时间 / bucket / key)
- [ ] 点击"下载"按钮,浏览器能拉到 tar.gz,`tar -tzf` 看到 pgbackrest set 目录结构
- [ ] 点击"恢复干跑"按钮,后端真跑 `pgbackrest restore --dry-run`,前端能看到 stdout 日志 + 黄色"仅校验"提示
- [ ] 点击"恢复命令"按钮,弹窗显示 `pgbackrest restore --stanza=blf --set=...` 完整命令,可一键复制
- [ ] 点击"删除"按钮,二次确认后:R2 对象消失 + DB 记录 `r2_deleted_at` 写
- [ ] 凌晨 03:00 自动跑出一份 `triggered_by='auto'` 的 record(把 crontab 临时调到 5min 后验证)
- [ ] 凌晨 04:30 `cleanup_r2_task` 跑一次,R2 保留数 ≤ 7(默认 `R2_BACKUP_RETENTION_COUNT`)
- [ ] `BACKUP_VIA_CELERY=false` 时回到同步旧路径,前端体验与改前一致
- [ ] 任何失败任务,worker 重试 ≤ 2 次后落地 `status=failed, error_message` 含可读原因
- [ ] API 日志不再出现"pgbackrest 同步完成"打印(都移到 worker 日志)

---

## 10. 待评审关键决策(请逐条拍板)

| 决策点 | 我的推荐 | 用户决策(2026-07-17) | 状态 |
| --- | --- | --- | --- |
| §3.1 P0-1 异步化 | Celery worker,`@shared_task` | ✅ 确认迁到 Celery | ✅ frozen |
| §3.2 P0-2 状态机 + 幂等 | `phase` 字段 + 行锁 + 乐观锁 | 待评审 | ⏸ |
| §3.3 P0-3 R2 上传内容 | 单次 backup set 打成 tar.gz | ✅ 确认 tar.gz 单 set 目录 | ✅ frozen |
| §3.4 P0-4 DB 字段 | 11 个新字段(含 r2_deleted_at / triggered_by,见 §3.4 表) | 待评审 | ⏸ |
| §3.5 P1-1 独立 worker 队列 | `backups` 队列 + `-c 1` 独立 systemd | 待评审 | ⏸ |
| §3.6 P1-2 定时 | Celery Beat 03:00 全量 | ✅ 确认 Celery Beat 03:00 | ✅ frozen |
| §3.7 P1-3 R2 保留 | 7 份 / `.env` 可调,代码周期清理 | ✅ 改为 7 份(与本地对齐) | ✅ frozen |
| §3.8 P1-4 前端轮询 | 3s setInterval,条件触发 | 待评审 | ⏸ |
| §3.9 P1-5 恢复入口 | 干跑(dry-run)+ 命令预览 | ✅ 升级为干跑(dry-run)+ 命令预览 | ✅ frozen |
| §3.10 P2-1 双触发源 | 不互斥,DB 护栏兜底 | 待评审 | ⏸ |
| §3.11 P2-2 API 端点 | 6 → 10 个,`/{id}` + `/download-url` + `/restore-dry-run` + `/restore-command` + `DELETE` | 待评审 | ⏸ |

> 5/11 条已 frozen。**剩余 6 条 ⏸ 拍板后**,本方案进入 Phase 1 实现。剩余条目多为实现细节(P0-2 状态机、P0-4 字段、P1-1 队列、P1-4 轮询、P2-1 互斥、P2-2 端点粒度),风险低,可在我写 Phase 1 代码时再确认。

**已 frozen 决策摘要:**
- Q1:Celery 异步化(`backups` 队列)
- Q3:`tar.gz` 单 set 目录上传,key = `db-backups/pgbackrest/blf/{date}_{type}_{record_id}.tar.gz`
- Q6:Celery Beat 03:00 全量 + 04:30 retention
- Q4:R2 保留 7 份(与本地 retention 对齐)
- Q5:恢复入口提供**真 dry-run** + 可复制命令文本

---

## 11. 配置项清单(实现后 `backend/.env.example` 必须有)

```bash
# --- 数据库备份 (PostgreSQL via pgbackrest → Cloudflare R2) ---------------

# 备份 async 化开关。true=API 端只 enqueue,worker 跑;
# false=API 端同步跑(回滚形态,留作紧急回滚)。
# BACKUP_VIA_CELERY=true

# Celery task 软/硬时间限制(秒)。Phase 1 跑 pgbackrest info 历史数据后调。
# 默认 90/120 min,占位值,需根据实际 P99 调整。
# BACKUP_SOFT_TIME_LIMIT=5400
# BACKUP_HARD_TIME_LIMIT=7200

# R2 保留份数。超出后由 Celery Beat 04:30 周期清理。
# 用户决策 2026-07-17:与本地 pgbackrest retention-full=7 对齐,R2 定位为"每周异地灾备"。
# R2_BACKUP_RETENTION_COUNT=7

# 自动备份时间(小时,24h 制)。默认凌晨 3:00。
# BACKUP_DAILY_SCHEDULE_HOUR=3
```

---

## 12. 后续文档更新(实现完成后)

- `docs/REFERENCE.md`:Background Jobs 段加 `backups` 队列 + R2 retention
- `docs/deployment-runbook.md`:补 `believeboy-worker-backups.service` 部署 + Celery Beat 多实例约束
- `docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/`(本目录):实现完成后写 `implementation-review.md`,记录与 frozen 方案的偏差
- `CHANGELOG.md`:`feat(backup): 数据库备份端到端链路 + R2 异步上传`

---

## 13. 关联引用

- **现状代码**:
  - 前端:`frontend/app/dashboard/system/backup-management/backup-management-client.tsx`
  - API:`backend/app/api/v1/endpoints/backups.py`
  - 服务:`backend/app/services/backup_service.py`
  - 模型:`backend/app/models/backup_record.py`
  - R2 客户端:`backend/app/services/r2_service.py`
  - Celery 范例:`backend/app/celery_tasks/run_job.py`(参考 task 装饰器范式)
- **设计参考**:`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md`(P0-2 幂等护栏、双开关回滚模式、time_limit 验证流程)
- **仓库约定**:`AGENTS.md` 关键约定 + `docs/superpowers/plans/README.md` 命名规则
