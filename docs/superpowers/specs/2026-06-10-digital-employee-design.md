#数字员工（Digital Employee）系统 — 设计规格

**日期：**2026-06-10
**状态：** 待用户审查
**作者：**头脑风暴环节产出

---

##1.背景与目标

###1.1现状

- `autoReportUpload/` 是一个独立服务，跑在另一台机器上
- 它扫描 `/Users/damon/Documents/RPA`下的项目文件夹，识别并上传各种报表
- 当前机器处理速度极快：**1 秒可处理几十上百份**
-监控日志写到本地 `logs/run_YYYYMMDD_HHMMSS.log` 文件
- 数据库里只记录**业务事实**（报表数据本身），没有"事件/活动流"

###1.2业务诉求

把 `autoReportUpload` 处理过的**每一条日志信息**都详细写入数据库，Backend读取后，在前端以"**拟人化数字员工**"的形式展示工作状态。

**核心体验目标：** 让运营人员打开数字员工页面，能像"看一个真实员工干活"一样，看到他正在处理什么报表、刚处理完哪个项目的任务、当前空闲还是忙碌。

###1.3关键约束（头脑风暴中确认的设计原则）

|约束 |原因 |
|------|------|
| DB真实时间戳不污染 |未来要做"处理耗时分析"时数据必须真实 |
|拟人化只发生在展示层 | 不影响监控告警、审计、对账 |
| 不显示百分比进度条 | 用户只需知道"在做什么"，不需要精确进度 |
|多数字员工零代码拓展 | 新增报表类型 = INSERT 一行配置 |
| MVP 默认严谨语气 |严肃运营场景优先，文案可后续按 persona 配置 |

---

##2.架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│ autoReportUpload（另一台机器，已存在） │
│ process_file() 完成时 → emit_event()写入 events 表 │
└──────────────────────────────────────┬───────────────────────────┘
 │写一行（秒级时间戳，真实）
 ▼
┌─────────────────────────────────────────────────────────────────┐
│ PostgreSQL — 新增2 张表 │
│ │
│ digital_employees (员工档案、归属报表类型、节奏配置) │
│ digital_employee_events (真实事件流：秒级时间戳) │
└──────────────────────────────────────┬───────────────────────────┘
 │读 +聚合
 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Backend（FastAPI）— 新增模块 │
│ │
│ digital_employees/ │
│ ├── models.py (SQLAlchemy:2 张新表) │
│ ├── schemas.py (Pydantic) │
│ ├── repository.py (DB读写) │
│ ├── aggregator.py (按 employee × project × type 分桶) │
│ ├── rhythm.py (节奏控制：固定间隔 +末尾延长) │
│ └── endpoints.py (REST列表 + SSE推流) │
└──────────────────────────────────────┬───────────────────────────┘
 │ SSE推送 + GET 历史
 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Frontend — 新增页面 │
│ │
│ /dashboard/digital-employees │
│ ├──员工列表（卡片网格） │
│ └──员工详情页（拟人化状态轮播 + 历史时间轴） │
└─────────────────────────────────────────────────────────────────┘
```

---

##3. 数据模型

###3.1 `digital_employees` —员工档案表

```sql
CREATE TABLE digital_employees (
 employee_id SERIAL PRIMARY KEY,
 employee_code TEXT NOT NULL UNIQUE, -- "payment-reporter"
 display_name TEXT NOT NULL, -- "Payment Report数字员工"
 avatar_emoji TEXT NOT NULL DEFAULT '🤖',
 description TEXT, -- 一句话人设描述
 report_types TEXT[] NOT NULL, --归属的报表类型（路由依据）
 persona_style JSONB NOT NULL DEFAULT '{}'::jsonb,
 rhythm_config JSONB NOT NULL DEFAULT '{}'::jsonb,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 display_order INTEGER NOT NULL DEFAULT 0, --列表页排序（越小越靠前）
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employees_report_types ON digital_employees USING GIN (report_types);
CREATE INDEX idx_employees_enabled ON digital_employees (enabled) WHERE enabled = TRUE;
```

**字段说明：**

- `employee_code`：稳定英文标识，用于代码引用和 SSE路由
- `report_types`：决定哪些报表类型的事件归属该员工（数组，支持多对一）
- `persona_style`：未来文案模板配置。MVP留空，使用代码内置的"严谨型"默认模板
- `rhythm_config`：节奏配置。MVP 默认值：
 ```json
 {
 "interval_seconds":3, // 每个状态普通停留时间
 "tail_extend_seconds":12, //队列清空前最后一项延长显示
 "idle_message_seconds":30 //空闲态持续多久后切到"下班"
 }
 ```

###3.2 `digital_employee_events` —事件流表

```sql
CREATE TABLE digital_employee_events (
 event_id SERIAL PRIMARY KEY,
 employee_id INTEGER NOT NULL REFERENCES digital_employees(employee_id) ON DELETE CASCADE,
 project_name TEXT, -- "润茗"（可空：某些全局报表无项目）
 report_type TEXT NOT NULL, -- "payment_report"
 report_label TEXT NOT NULL, -- "Payment Report"（展示用中文）
 country TEXT, -- "US"
 status TEXT NOT NULL, -- "success" / "failed" / "skipped"
 row_count INTEGER, -- 入库行数
 source_file_id INTEGER, --关联 analysis_source_files.id（可空）
 source_file_name TEXT, --原始文件名（展示用）
 detected_date_range TEXT, -- "06-05~06-05"压缩格式
 occurred_at TIMESTAMPTZ NOT NULL, --真实发生时间（秒级）
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_employee_time ON digital_employee_events (employee_id, occurred_at DESC);
CREATE INDEX idx_events_status ON digital_employee_events (status);
```

**关键设计决策：**

- `occurred_at` 是**真实时间**（autoReportUpload 处理完成时的 wall clock），**不被人为拉长**
- `employee_id` 由写入端按 `report_type`路由决定，**事件只属于一个员工**（模型 A平行独立）
- `source_file_id` 可空——MVP阶段不强求关联，未来可补

###3.3路由机制（写入端）

`autoReportUpload` 完成事件写入时，按 `report_type`查 `digital_employees` 表，**可能匹配到0 个、1 个或多个员工**：

```python
# autoReportUpload/emit_event.py (新文件)
def emit_event(db, report_type, project_name, country, status,
 row_count, source_file_name, detected_date_range, occurred_at):
 """按 report_type路由到对应的数字员工，写入事件表。"""
 matched = db.execute(
 select(DigitalEmployee)
 .where(DigitalEmployee.enabled == True)
 .where(DigitalEmployee.report_types.contains([report_type]))
 ).scalars().all()

 if not matched:
 logger.info(f"[emit_event] report_type={report_type} 未匹配任何员工，跳过事件写入")
 return

 for emp in matched:
 db.add(DigitalEmployeeEvent(
 employee_id=emp.employee_id,
 project_name=project_name,
 report_type=report_type,
 report_label=_report_label_for(report_type),
 country=country,
 status=status,
 row_count=row_count,
 source_file_name=source_file_name,
 detected_date_range=detected_date_range,
 occurred_at=occurred_at,
 ))
 db.commit()
```

**写入失败的容错策略：**
- `emit_event()`必须在 `process_file()` 主流程**之后**调用
-事件写入失败**不影响**报表数据本身（业务事实已落库）
- 仅记录 ERROR 日志 +监控告警

---

##4. 后端模块设计

###4.1 模块结构

```
backend/app/
├── models/
│ └── digital_employee.py # SQLAlchemy 模型（2 个表）
├── schemas/
│ └── digital_employee.py # Pydantic schemas
├── services/
│ └── digital_employee/
│ ├── repository.py # DB CRUD封装
│ ├── aggregator.py #事件聚合（分桶）
│ ├── rhythm.py #节奏控制状态机
│ └── stream.py # SSE推流管理器
└── api/v1/endpoints/
 └── digital_employees.py # REST + SSE路由
```

###4.2聚合器（aggregator.py）—核心算法

**输入：** `employee_id`, 查询时间窗口（默认最近5 分钟，可配）

**输出：**桶列表（按 `project_name × report_type` 分组）

```python
@dataclass
class Bucket:
 project_name: str
 report_type: str
 report_label: str
 country: str
 status: str #桶内事件的"主状态"（success占比 ≥80% → success，否则取最高级别）
 event_count: int
 row_count_total: int
 first_occurred_at: datetime
 last_occurred_at: datetime
 date_range: str #合并后的 "06-05~06-08"
 representative_files: list[str]  #最多展示3 个文件名

def aggregate_buckets(db, employee_id: int, since: datetime) -> list[Bucket]:
 """读取事件流，按 project × report_type 分桶聚合。"""
 events = db.execute(
 select(DigitalEmployeeEvent)
 .where(DigitalEmployeeEvent.employee_id == employee_id)
 .where(DigitalEmployeeEvent.occurred_at >= since)
 .order_by(DigitalEmployeeEvent.occurred_at.asc())
 ).scalars().all()

 # 按 (project_name, report_type) 分桶
 bucket_map: dict[tuple[str, str], list[Event]] = {}
 for e in events:
 key = (e.project_name or "_global", e.report_type)
 bucket_map.setdefault(key, []).append(e)

 buckets = [_merge_bucket(events_list) for events_list in bucket_map.values()]
 return sorted(buckets, key=lambda b: b.first_occurred_at)
```

**聚合粒度自适应（防止堆积）：**
- 如果同一桶内事件数 >20，**进一步合并**：把相同 `report_type` 不同项目的事件合并成"全局桶"
-合并后的桶标注 `project_name = "多项目"`，并展示项目数

###4.3节奏控制器（rhythm.py）

**核心状态机：**

```python
class RhythmState(Enum):
 IDLE = "idle" #空闲态
 WORKING = "working" # 普通工作态
 WORKING_TAIL = "working_tail" # 最后一项延长态
 OFFLINE = "offline" #长时间无活动 → "下班"

@dataclass
class RhythmTickResult:
 state: RhythmState
 text: str #拟人化文案
 detail: dict | None # 当前桶的元数据（项目、报表类型、计数等）

class RhythmPlayer:
 """每个员工一个独立实例，SSE 连接时由 stream.py 创建。"""

 def __init__(self, employee: DigitalEmployee):
 cfg = employee.rhythm_config
 self.interval = cfg.get("interval_seconds",3)
 self.tail_extend = cfg.get("tail_extend_seconds",12)
 self.idle_after = cfg.get("idle_message_seconds",30)
 self.employee = employee
 self.bucket_queue: deque[Bucket] = deque()
 self.last_event_at: datetime | None = None
 self.current_bucket: Bucket | None = None

 async def feed(self, new_buckets: list[Bucket]) -> None:
 """当聚合器检测到新桶时，喂入队列。"""
 for b in new_buckets:
 self.bucket_queue.append(b)
 self.last_event_at = datetime.utcnow()

 async def tick(self) -> RhythmTickResult:
 """每次 tick 返回当前应展示的状态。
 优先级：OFFLINE 检查 >新桶入队 >当前桶保持 >IDLE。
 """
 # 优先级1：长时间无活动 → 下班（即使队列还有内容也保持当前桶不变）
 if self.last_event_at and (datetime.utcnow() - self.last_event_at).total_seconds() > self.idle_after:
 # 但只有当队列已清空时才显示 OFFLINE，否则仍显示 WORKING_TAIL
 if not self.bucket_queue and self.current_bucket is None:
 return RhythmTickResult(state=OFFLINE, text="今日工作结束，明天再接续...", detail=None)

 # 优先级2：队列里有下一桶 → 立即切换
 if self.bucket_queue:
 self.current_bucket = self.bucket_queue.popleft()
 # 队列还有 → 普通节奏；队列空 → 延长态
 if self.bucket_queue:
 return RhythmTickResult(state=WORKING, text=_render_working(self.current_bucket), detail=...)
 else:
 return RhythmTickResult(state=WORKING_TAIL, text=_render_tail(self.current_bucket), detail=...)

 # 优先级3：队列空，保持当前桶
 if self.current_bucket is not None:
 return RhythmTickResult(state=WORKING_TAIL, text=_render_tail(self.current_bucket), detail=...)

 # 优先级4：完全空闲
 return RhythmTickResult(state=IDLE, text=_render_idle(self.employee), detail=None)
```

**节奏时间线示例（假设 `interval_seconds=3`、`tail_extend_seconds=12`）：**
```
T=0s  新事件进入 →队列：[B1, B2, B3]，调度 tick 在 T=3/6/9/21 触发
T=3s  tick → 切到 B1（WORKING），调度下次 tick T=6s
T=6s  tick → 切到 B2（WORKING），调度下次 tick T=9s
T=9s  tick → 切到 B3（WORKING_TAIL，因为队列清空），调度下次 tick T=21s（9+12）
T=21s tick → 队列空 + 无当前桶 → 切到 IDLE，调度下次 tick T=51s（21+30）
T=51s tick → 仍无新事件 + 超过 idle_after → 切到 OFFLINE
```

###4.4 SSE推流（stream.py + endpoints.py）

**端点设计：**

| 方法 |路径 | 功能 |
|------|------|------|
| GET | `/digital-employees` |列出所有员工（卡片页用） |
| GET | `/digital-employees/{id}` | 获取员工详情 + 当前状态 |
| GET | `/digital-employees/{id}/stream` | **SSE推流**（详情页用） |
| GET | `/digital-employees/{id}/history` | 历史事件查询（时间轴用，默认查最近24h，支持 `?since=&limit=` 查询参数，limit 默认50 上限500）|

**SSE协议规范：**

```
event: rhythm_tick
id: <tick_sequence>
data: {"state": "working", "text": "...", "detail": {...}}

event: heartbeat
data: {"server_time": "..."} // 每15s一次，防止代理超时
```

**客户端断线恢复：**
-客户端发送 `Last-Event-ID` header
- 服务端从该 sequence之后的事件补发（最多100 条历史，避免爆 buffer）

**SSE 连接生命周期：**
-浏览器打开详情页 → 建立 SSE
- 每5 秒服务端查询最新桶列表，喂给 RhythmPlayer
- RhythmPlayer异步 tick，状态变化时通过 asyncio.Queue推给 writer
-浏览器关闭页面 → SSE断开 → RhythmPlayer 被清理

###4.5拟人化文案模板（persona）

**MVP 内置"严谨型"模板（persona_style字段为空时使用）：**

|状态 | 文案模板 |
|------|---------|
| WORKING | `📊正在核对【{project_name}】的 {report_label}，数据范围 {date_range}…` |
| WORKING_TAIL | `✅ 【{project_name}】的 {report_label} 处理完成（共 {row_count_total} 行）。稍作整理中…` |
| IDLE | `🍵 当前没有新报表，静候下一批任务…` |
| OFFLINE | `🌙今日工作告一段落，明日再续。` |
| FAILED（桶主状态=failed） | `⚠️ 【{project_name}】的 {report_label} 入库失败，已记录日志，请人工确认` |

**未来扩展：**
- `persona_style.tone = "严谨" / "亲切" / "活泼"`
- `persona_style.templates = {state: "..."}` 自定义模板
- 不同员工可有不同人设（如"广告员工"活泼、"财务员工"严谨）

---

##5. 前端页面设计

###5.1路由

```
/dashboard/digital-employees #员工列表（卡片网格）
/dashboard/digital-employees/[id]         #员工详情（拟人化状态）
```

###5.2列表页（卡片网格）

**布局：**响应式网格，每张卡片显示：
- 大号 emoji头像
-员工名称
- 一句话描述
- 当前状态徽章（工作中/空闲/下班）
- "今日处理数"（最近24h聚合）

**交互：** 点击卡片进入详情页。

###5.3详情页（拟人化状态展示）

**核心区域（占视口60%）：**
-巨大的员工 emoji居中（64-96px）
-下方状态文字（28-32px字号，动效：轻微淡入淡出切换）
-状态文字下方一个次要信息条（项目名 ·报表类型 · 时间戳）

**辅助区域：**
-顶部：**拟人化进度条**（不显示百分比，仅显示"正在处理"动画 + 当前任务名）
-底部：**历史时间轴**（最近50 条事件，可滚动）
-右上角：**SSE 连接状态指示**（绿点=已连接，灰=重连中，红=断开）

**动效细节：**
-状态切换时，旧文字 fade-out200ms + 新文字 fade-in200ms
-状态徽章颜色：工作中=蓝色脉冲，空闲=灰色，下班=深灰
-拟人化进度条：纯动画（无限循环的 shimmer），不显示百分比——**符合"不显示精确进度"的设计决策**

###5.4 技术栈

-沿用现有 Next.js14 + shadcn/ui + Tailwind
- SSE客户端：`new EventSource('/api/...')`（浏览器原生）
-状态管理：本地 React state + `useEffect`（不需要 Zustand/Redux，规模小）

---

##6. autoReportUpload端改动

###6.1 新增文件

- `autoReportUpload/emit_event.py` —事件发射函数（如 §3.3路由机制示例）
- `autoReportUpload/models.py` 中新增2 个 model import（从 backend 单源导入）

###6.2 修改文件

- `autoReportUpload/processor.py` — `process_file()`完成后调用 `emit_event()`
- `autoReportUpload/run.py` —启动时 sanity check：能查到至少一个 enabled 的员工配置

###6.3 不改动

-现有的报表数据写入逻辑（`Analysis*Row`、`ad_upload_*` 等）保持不变
-现有的日志文件机制保留（作为兜底和人工排查用）

---

##7.业务拓展机制

###7.1 新增一个数字员工（零代码）

**场景：**运营说"我们想新增一个'库存报表数字员工'"。

**操作步骤：**

1. Alembic 创建新员工配置：
 ```sql
 INSERT INTO digital_employees (employee_code, display_name, avatar_emoji, report_types, description)
 VALUES ('inventory-reporter', '库存报表数字员工', '📦',
 ARRAY['inventory_report'],
 '负责核对各项目库存报表的入库情况');
 ```

2. 前端列表页自动展示新员工（无需代码改动）。

3. `autoReportUpload` 处理到 `inventory_report` 类型时，`emit_event()` 自动按 `report_type`路由到该员工。

**完成。零代码改动。**

###7.2 修改节奏配置（运营调优）

```sql
UPDATE digital_employees
SET rhythm_config = jsonb_set(rhythm_config, '{interval_seconds}', '5')
WHERE employee_code = 'payment-reporter';
```

后端下一次聚合时自动应用新节奏（无需重启服务）。

###7.3未来可能的拓展方向（YAGNI — 先不做）

|方向 |触发条件 |
|------|---------|
|多数字员工联动（跨报表类型汇总） |运营提出"我想要看今天的整体工作量" |
|百分比进度条 |运营明确要求看到精确进度 |
|数字员工互动（运营留言 →员工回应） |出现"我要和数字员工沟通"的需求 |
|数字员工"下班/上班"手动控制 |出现"我希望晚上不被打扰"的需求 |

---

##8.错误处理与边界情况

|场景 | 处理策略 |
|------|---------|
| `emit_event()`写入失败 | **不影响主流程**——日志告警 +监控，报表数据本身已落库 |
| 后端聚合服务重启 | SSE客户端自动重连，`Last-Event-ID`续传最近100 条 |
|同一文件被多次识别（重复） |写入端按 `(source_file_name, detected_date_range)` 去重（UNIQUE索引） |
|节奏过快导致事件堆积（机器闲时 →突发1000 条） | **聚合粒度自适应** ——同一桶 >20事件则进一步合并 |
|员工被禁用 (`enabled=false`) | 后端停止为该员工推送 SSE；前端展示"已下班"占位 |
| SSE 长连接被代理超时（如 nginx60s） | 服务端每15s发送 heartbeat事件保活 |
| 数据库连接失败 | 后端返回503，前端展示"数字员工离线" |

###8.1重复事件去重（写入端）

```sql
-- 在 digital_employee_events 上加唯一索引
CREATE UNIQUE INDEX idx_events_dedupe
ON digital_employee_events (employee_id, source_file_name, detected_date_range, report_type)
WHERE source_file_name IS NOT NULL;
```

写入时用 `INSERT ... ON CONFLICT DO NOTHING`语义。

---

##9. 测试策略

###9.1单元测试

| 模块 | 测试点 |
|------|--------|
| `aggregator.py` | 分桶逻辑正确；同桶合并；粒度自适应触发条件 |
| `rhythm.py` |状态机转换正确；tail_extend 时机；IDLE → OFFLINE边界 |
| 文案模板 | 各状态文案渲染正确；占位符替换无遗漏 |

###9.2集成测试

|流程 |验证点 |
|------|--------|
| autoReportUpload → emit_event → DB |事件被正确路由到对应员工 |
| 后端聚合 → SSE推送 |客户端收到节奏正确的 tick序列 |
| SSE断线重连 | `Last-Event-ID`续传不丢事件 |

###9.3手工验证（端到端）

1.准备测试项目文件夹，放入3-5 个不同报表类型的文件
2.启动 autoReportUpload，确认事件写入 DB
3.启动 backend，打开浏览器访问详情页
4.观察 SSE推送节奏是否符合预期（普通3s +末尾12s）
5.关闭 SSE 重连，确认断线恢复

---

##10.实施里程碑

由于这是 brainstorming 设计文档阶段，**实施计划**会在下一步通过 `writing-plans`技能生成。

**预期里程碑顺序：**

1. **M1 — 后端基础**：Alembic迁移 +2 张表 + models/repository
2. **M2 — autoReportUpload端**：emit_event接入 processor.py
3. **M3 — 后端聚合 +节奏**：aggregator.py + rhythm.py +单元测试
4. **M4 — 后端 SSE**：stream.py + endpoints.py +集成测试
5. **M5 — 前端列表页**：员工卡片网格
6. **M6 — 前端详情页**：SSE消费 +拟人化状态展示 + 历史时间轴
7. **M7 — 配置默认员工**：INSERT1 个 Payment Report员工作为 MVP
8. **M8 —端到端验证**：手工验证流程

---

##11.开放问题 /未来决策

| 问题 | 当前决策 |触发重新评估的条件 |
|------|---------|------------------|
| 文案语气细节 | MVP 默认严谨型 |运营要求切换 |
|拟人化进度条样式 |纯 shimmer动画 |运营要求更多信息 |
| 历史时间轴保留多久 |详情页查询 DB实时聚合，不预存 |性能问题 |
| 是否需要"今日小结" | 不做 |运营明确提出 |

---

##附录 A：术语表

|术语 | 定义 |
|------|------|
|数字员工 (Digital Employee) | 前端拟人化展示的工作实体，对应一种或多种报表类型 |
|桶 (Bucket) | 按 (project × report_type) 分组的事件聚合单位 |
|节奏 (Rhythm) |拟人化状态切换的时间间隔规则 |
|路由 (Routing) | 按 `report_type` 把事件分发给对应员工的过程 |
| SSE | Server-Sent Events，浏览器原生支持的服务器推送协议 |

---

**状态：** 待用户审查。审查通过后调用 `writing-plans`技能生成实施计划。
