# 数字员工虚拟办公室（工牌墙 + 后端拟人化伸展引擎）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **父 plan：** 本文件即主 plan。Phase 1 详细任务见 [`2026-07-22-digital-employee-virtual-office-phase1.md`](./2026-07-22-digital-employee-virtual-office-phase1.md)；后续 phase 在推进到该阶段时起草独立文件。

**目标：** 把内网各机器上 Agent 员工的真实心跳，经后端"拟人化伸展引擎"平滑拉伸成全天动态，在前端一个"虚拟办公室工牌墙"上以工牌形式实时展示多个 Agent 当前正在做的事项。

**架构：**
- **上报层（已有，复用）**：内网 Agent 通过 HTTP 心跳 API（`POST /api/v1/digital-employees/{id}/heartbeat`，`api_secret` 鉴权）把 start/progress/complete 报上来，落入 `digital_employee_tasks` / `digital_employee_logs`。支持 `task_name` / `task_type` / `metadata_json` 透传（P2-1）。**不让 Agent 直连数据库**（凭据分散、强耦合）。
- **伸展引擎（新增，后端核心）**：`playback_engine.py` 纯逻辑模块，把“脉冲式”真实任务流拉伸成平滑的“虚拟当前状态”——短任务（5-10 分钟）拉伸到 1-2 小时慢慢演、人为插入停顿、新心跳涌来时自适应加速消化、持续高负载的 Agent 标记“忙碌”。每个员工一行 `digital_employee_playback` 持久化游标。
- **推进层（新增，Celery beat）**：`office_tick` 每 3s 推进所有员工虚拟态，将整墙快照 + chatter 事件存入 Redis（TTL 5s）。解决多 SSE 客户端各自 advance 的竞态。
- **推送层（新增）**：SSE 端点 `GET /api/v1/digital-employees/office/stream`（FastAPI `StreamingResponse`），每 tick（3s）优先读 Redis 缓存，miss 时 fallback 直接计算（dev 无 Redis 兼容）。推送 `event: snapshot`（整墙快照）+ `event: chatter`（拟人化动态事件）。
- **展示层（新增，前端）**：`/dashboard/ai/digital-employees/office` 工牌墙页面，`EventSource` 接收，纯渲染。工牌突出“当前工作事项”，支持多 Agent 同时展示 + 拟人化交互 + 投屏模式（`?mode=presentation`）。

**技术栈：**
- 后端：FastAPI + SQLAlchemy + Alembic（沿用）；SSE 用 `StreamingResponse`（已有范式）；引擎纯逻辑 + pytest TDD。
- 前端：Next.js 16 + React 18 + TS + shadcn/ui + Tailwind（沿用）；`EventSource` 接收 SSE；framer-motion 做拟人化动效（已在依赖里）；Vitest 测纯逻辑。

---

## 0. 用户需求 → 设计映射（验收口径）

| 用户原话 | 设计落点 |
|---------|---------|
| "避免突变…不能一下子不停变化，要定期刷新" | 前端不直接显示真实进度；显示后端每 3s 推进的**平滑虚拟进度**（`virtual_progress` 单调缓增，永不跳变） |
| "拟人化动态效果，人为插入中断或放慢速度" | 引擎在任务之间插入 `pause_until` 停顿（"整理中/喝口水"）；`display_duration` 远大于真实时长 |
| "5-10 分钟做完的拆成 1-2 小时" | `stretch_duration_s()`：`real × stretch_factor` 钳制到 `[min_display, max_display]`（默认 30min~2h） |
| "新心跳进来就加快进度把新任务插进来继续拖延" | `compute_pace()`：排队任务越多 → `pace` 越大 → `display_duration / pace` 越短（加速消化），消化完回落到慢节奏 |
| "某 Agent 特别忙要做特殊标识" | `busy_level`（IDLE/NORMAL/BUSY/SWAMPED）→ 前端忙碌光晕/火焰标/排队计数 |
| "根据进来的量适当加快或减速…动态伸展" | pace 是排队长度的连续函数，随真实负载实时伸缩 |
| "工牌一定要突出工作事项" | 工牌中央 hero 区 = 当前任务名 + 项目，最大字号 |
| "支持同时展示多个 Agent" | 工牌墙响应式网格 + 整墙 SSE 快照 |
| "多 Agent 交互需要你来设定" | 见 §6 多 Agent 交互设计 |

---

## 1. 现状地基（不用从零造）

| 已有 | 位置 | 说明 |
|------|------|------|
| 数据模型 | `backend/app/models/digital_employee.py` | `DigitalEmployee`（含 `api_secret`/`last_heartbeat_at`/`is_silent_alert_threshold_minutes`）、`DigitalEmployeeTask`（`progress_percent`/`current_step`/`metadata_json`）、`DigitalEmployeeLog` |
| Reporter | `backend/app/services/digital_employee_reporter.py` | `get_or_create_employee`/`start_task`/`report_heartbeat`/`complete_task` |
| 心跳 API | `backend/app/api/v1/endpoints/digital_employees.py:167` | `POST /{id}/heartbeat`（`api_secret` 鉴权）+ `/register` |
| Service | `backend/app/services/digital/employee_service.py` | `heartbeat`/`list_employees`/`list_tasks`/`list_employee_logs` 等 |
| 前端类型 | `frontend/types/digital-employee.ts` | `DigitalEmployee`/`DigitalEmployeeTask`/`DigitalEmployeeLog` |
| 前端 REST | `frontend/lib/digital-employee-api.ts` | 轮询式 client（`/api/backend` 代理） |
| 工牌雏形 | `frontend/components/digital-employee/` | `persona.tsx`（PERSONA_MAP）、`digital-employee-card`、`status-badge`、`heartbeat-dot`、`progress-bar` 等 |
| SSE 范式 | `backend/app/api/v1/endpoints/ai_chat_v2.py:92`、`ai_insight.py:224` | `StreamingResponse(media_type="text/event-stream")`；测试 `tests/api/test_ai_chat_stream_v2.py:153` |
| 旧拟人化尝试 | `docs/superpowers/plans/2026-06-10-digital-employee-personified-display-plan.md` | 把 rhythm-player 放在**前端**、15s 轮询、单员工详情页。**本计划是其进化版**：引擎搬到后端 + 自适应伸展 + 多员工工牌墙 + SSE |

**缺口（本计划要补）**：后端伸展引擎、`digital_employee_playback` 表、SSE 端点、前端 `useOfficeStream` + 工牌墙页面 + 多 Agent 交互层、Agent 上报 SDK/模拟器。

---

## 2. 数据模型变更

### 新增表 `digital_employee_playback`（每员工一行，持久化虚拟播放游标）

| 列 | 类型 | 说明 |
|----|------|------|
| `employee_id` | int PK FK→digital_employees.id | |
| `virtual_index` | int default 0 | 已"播完"的真实任务数（游标） |
| `current_task_id` | str(64) nullable | 正在展示的真实 task_id |
| `virtual_progress` | float default 0 | 平滑虚拟进度 0~100 |
| `display_started_at` | timestamptz nullable | 当前任务开始展示的时刻 |
| `display_duration_s` | float default 0 | 当前任务拉伸后的展示时长（秒） |
| `pause_until` | timestamptz nullable | 拟人化停顿截止时刻 |
| `pace` | float default 1.0 | 当前节奏倍率（1=常态慢播，>1=忙碌加速） |
| `busy_level` | str(16) default 'IDLE' | IDLE/NORMAL/BUSY/SWAMPED |
| `last_advanced_at` | timestamptz nullable | 上次推进时刻 |
| `updated_at` | timestamptz | |

> **不动**现有三张表。`metadata_json` 已可承载 project/report 上下文（旧 plan 已让 `start_task` 支持）。

### （Phase 3 才加，本期不建）`digital_employee_display_event`
拟人化"办公室 chatter"事件流（`employee_id`/`event_type`/`human_text`/`created_at`）。Phase 1-2 不需要。

---

## 3. 伸展引擎规格（后端核心，纯逻辑可单测）

模块：`backend/app/services/digital/playback_engine.py`。**不碰 DB**，输入数据输出状态，pytest 全覆盖。

### 3.1 数据结构

```python
@dataclass(frozen=True)
class RealTask:
    task_id: str
    task_name: str
    task_type: str
    status: str                 # RUNNING/SUCCEEDED/FAILED/CANCELLED
    progress_percent: int
    current_step: str | None
    started_at: datetime
    ended_at: datetime | None
    metadata: dict | None       # {project_name, report_label, row_count, ...}

@dataclass
class PlaybackState:            # 与 digital_employee_playback 表一一对应
    employee_id: int
    virtual_index: int = 0
    current_task_id: str | None = None
    virtual_progress: float = 0.0
    display_started_at: datetime | None = None
    display_duration_s: float = 0.0
    pause_until: datetime | None = None
    pace: float = 1.0
    busy_level: str = "IDLE"
    last_advanced_at: datetime | None = None

@dataclass(frozen=True)
class VirtualSnapshot:          # 推给前端的单员工虚拟态
    employee_id: int
    display_status: str         # WORKING/PAUSING/IDLE/OFFLINE/FAILED
    current_task: RealTask | None
    virtual_progress: float     # 0~100，平滑
    step_label: str             # 拟人化当前步骤文案
    pace: float
    busy_level: str
    queued_count: int           # 排队待展示的真实任务数

@dataclass(frozen=True)
class PlaybackConfig:
    stretch_factor: float = 12.0     # 600s×12=7200s=2h
    min_display_s: float = 1800.0    # 单任务最少展示 30min
    max_display_s: float = 7200.0    # 单任务最多展示 2h
    calm_queue: int = 1              # 排队≤此值视为从容，pace=1
    pace_per_extra: float = 0.5      # 每多排 1 个任务，pace +0.5
    max_pace: float = 6.0            # pace 上限
    pause_min_s: float = 90.0        # 任务间停顿下限
    pause_max_s: float = 300.0       # 任务间停顿上限
    offline_after_s: float = 1800.0  # 无心跳多久算 OFFLINE
```

### 3.2 核心算法 `advance()`

```
advance(state, real_tasks, now, config) -> (new_state, snapshot)
```

1. `real_tasks` 按 `started_at` 升序。`pending = real_tasks[state.virtual_index:]`（尚未播完的真实任务）。
2. `queued = len(pending) - (1 if state.current_task_id else 0)`；`pace = compute_pace(queued)`；`busy_level = classify_busy(queued, pace)`。
3. **停顿中**：若 `state.pause_until and now < pause_until` → 保持，返回 `PAUSING` 快照（进度不变）。
4. **无当前任务**：
   - `pending` 非空 → 取 `pending[0]` 为当前任务，`display_started_at = now`，`display_duration_s = stretch_duration_s(real_dur, pace)`。
   - `pending` 空 → 若 `now - last_heartbeat > offline_after_s` 返回 `OFFLINE`，否则 `IDLE`。
5. **有当前任务**：`elapsed = now - display_started_at`；`virtual_progress = min(100, elapsed / display_duration_s × 100)`。
   - 若 `virtual_progress >= 100` → 该任务播完：`virtual_index += 1`，清当前任务，设 `pause_until = now + random(pause_min_s, pause_max_s) / pace`（忙碌时停顿也缩短）。
6. `step_label` 由 `current_step` + 拟人化模板生成（FAILED 任务前缀告警）。
7. 写回 `last_advanced_at = now`，返回新状态 + 快照。

### 3.3 关键纯函数

```python
def stretch_duration_s(real_dur_s: float, pace: float, cfg: PlaybackConfig) -> float:
    base = clamp(real_dur_s * cfg.stretch_factor, cfg.min_display_s, cfg.max_display_s)
    return base / pace                      # 忙碌 → pace>1 → 展示更快

def compute_pace(queued: int, cfg: PlaybackConfig) -> float:
    if queued <= cfg.calm_queue:
        return 1.0
    return clamp(1.0 + (queued - cfg.calm_queue) * cfg.pace_per_extra, 1.0, cfg.max_pace)

def classify_busy(queued: int, pace: float) -> str:
    if queued == 0: return "IDLE"
    if pace < 1.5:  return "NORMAL"
    if pace < 3.0:  return "BUSY"
    return "SWAMPED"
```

> **可调参**：所有节奏常量集中在 `PlaybackConfig`，调舒适度只改这里。停顿用确定性伪随机（以 `employee_id + virtual_index` 为种子）保证可单测、可复现。

### 3.4 单测要点（`backend/tests/services/digital/test_playback_engine.py`）
- 空任务 → IDLE；久无心跳 → OFFLINE
- 单任务：5min 真实时长 → `display_duration_s` 落在 [30min, 2h]
- 进度平滑：连续两次 advance（间隔 < display_duration）→ virtual_progress 单调递增且 < 100
- 播完插入停顿：progress 到 100 后下一次 advance 处于 PAUSING
- 排队加速：queued=0 → pace=1；queued=5 → pace>1 且 display_duration 变短
- busy_level 分级边界
- FAILED 任务 step_label 带告警前缀

---

## 4. SSE 协议与 API 契约

### 4.1 端点
`GET /api/v1/digital-employees/office/stream`（`StreamingResponse`，`text/event-stream`，参考 `ai_chat_v2.py:92`）。

- 鉴权：沿用 `protected`（cookie/session 同源携带）。**EventSource 不能设自定义 header**，靠 cookie。
- 每 tick（默认 3s）：对所有 `is_deleted=0` 员工，读 tasks + playback 行 → `advance()` → 写回 playback → 组装整墙快照推送。
- 心跳保活：每 tick 发 `: keep-alive\n\n` 注释行，防代理超时断流。

### 4.2 事件格式
```
event: snapshot
data: {"server_time":"...","employees":[{...VirtualSnapshot + persona 字段...}]}

```
单员工 payload（在 VirtualSnapshot 基础上补展示字段）：
```json
{
  "employee_id": 3,
  "name": "报表快递员",
  "persona": {"emoji": "📤", "color_key": "blue", "tagline": "报表快递员", "human_name": "小王"},
  "display_status": "WORKING",
  "busy_level": "BUSY",
  "queued_count": 4,
  "pace": 2.5,
  "current_task": {"task_id": "...", "task_name": "润茗/payment_report", "status": "RUNNING"},
  "work_item": {"project_name": "润茗", "report_label": "Payment Report"},
  "virtual_progress": 42.5,
  "step_label": "📊 正在核对【润茗】的 Payment Report，数据范围 06-05~06-06…",
  "today_done": 12,
  "success_rate": 0.95,
  "last_heartbeat_at": "..."
}
```

### 4.3 前端代理验证（Phase 1 风险点）
前端走 `/api/backend/[...path]` Next.js 代理。**需验证该代理能透传 SSE 流**（不缓冲）。Phase 1 含一个验证任务；若代理缓冲，回退方案：① 代理 route 显式 `export const dynamic='force-dynamic'` + 流式返回；② 或 EventSource 直连后端（经 next-auth 同源）。

---

## 5. 前端架构

| 文件 | 职责 |
|------|------|
| `frontend/lib/digital-employee/office-stream-types.ts` | SSE payload 类型（`OfficeSnapshot`/`OfficeEmployee`） |
| `frontend/lib/digital-employee/use-office-stream.ts` | `useOfficeStream()` hook：`EventSource` 连接、解析、重连、`prefers-reduced-motion` 感知，返回 `{employees, status, lastEventAt}` |
| `frontend/components/digital-employee/office/office-badge.tsx` | **工牌组件**（见 §6.2） |
| `frontend/components/digital-employee/office/office-wall.tsx` | 工牌墙网格 + 顶部办公室概览条 + 排序 |
| `frontend/components/digital-employee/office/office-chatter.tsx` | （Phase 3）办公室 chatter 信息流 |
| `frontend/app/dashboard/ai/digital-employees/office/page.tsx` | 页面：`useOfficeStream` + `<OfficeWall/>` |

> 旧的列表页 / 详情页 / `digital-employee-card` 等**保留**做管理用，互不干扰（用户已选"新建专属页面"）。

---

## 6. 多 Agent 交互设计（用户委托设定）

### 6.1 整体氛围
一面"办公室工牌墙"：不是 3D，而是有呼吸感的平面网格。整墙顶部一条**办公室概览**："🟢 在岗 6 · 🔥 忙碌 2 · 🍵 休息 3 ·  今日合计完成 48 件"。默认排序：忙碌/在岗优先、休息/离线沉底；可切"只看忙碌""按团队"。整墙节奏由后端统一驱动，所有工牌共享同一份 SSE 快照——**视觉永远一致、永不突变**。

### 6.2 单张工牌（必须突出工作事项）
```
┌────────────────────────────────┐
│ 📤 报表快递员·小王      [🔥忙碌] │  ← 头像(persona渐变环)+名+human_name+状态pill
│ ────────────────────────────── │
│   正在核对                       │  ← kicker（小字 uppercase）
│   【润茗】Payment Report         │  ← ★HERO★ 当前工作事项，最大字号
│   ▓▓▓▓▓▓▓░░░░░░░  42%          │  ← 平滑虚拟进度条（缓动，不跳）
│   "📊 数据范围 06-05~06-06…"     │  ← 拟人化状态气泡（ gentle 切换）
│ ────────────────────────────── │
│ 今日 12 件 · 成功率 95% · 排队 4 │  ← footer 战绩 + 排队计数（忙碌时显示）
└────────────────────────────────┘
```
- **HERO 工作事项**是视觉中心（`dashboard-display` 体系字号），一眼看清"这个员工此刻在干嘛"。
- **进度条**走 `virtual_progress`，CSS 缓动过渡，绝不跳变（呼应"避免突变"）。
- **状态 pill** 走 Badge 语义 variant：在岗=info、忙碌=warning、收尾=secondary、失败=destructive、休息/离线=outline（复用本次新加的 success/warning/info variant）。

### 6.3 多 Agent 交互模式
1. **呼吸感（ambient life）**：在岗工牌状态点柔和脉动、进度条缓慢爬行、状态气泡偶发"打字"微光——办公室"活着"但安静。全部走 motion token + `prefers-reduced-motion` 降级。
2. **注意力分级**：
   - **忙碌**：光晕环 + 微放大 + 上浮排序 + "🔥 忙碌 · 排队 N" 计数，进度条 shimmer 加快。
   - **失败**：工牌 gentle 红色闪烁 + 状态气泡拟人化报错（"😵 润茗的 Payment Report 卡住了，需要人帮忙"）+ 触发整墙轻量提醒。
   - **完成**：短暂庆祝微光（confetti-lite）+ 气泡冒一句成功文案，随后平复。
   - **休息/离线**：降饱和、压暗、沉底。
3. **办公室 chatter 信息流**（Phase 3，侧栏或底部 ticker）：跨员工的拟人化事件流——"小王 完成了 弥森/Business Report"、"小李 正在核对 润茗/Payment Report…"、"小张 遇到了问题…"。限速、自动滚动、gentle。给"办公室"叙事感。
4. **Spotlight / Toast**（Phase 3）：大事发生（大任务完成/出错）时，对应工牌瞬态高亮或弹一个小 toast，引而不扰。
5. **Hover / Click 展开**：hover 上浮 + 多显示当前步骤细节与最近 3 条 chatter；click 打开详情抽屉/跳现有 `[id]` 详情页看真实任务与日志。
6. **拟人化身份**：复用 `PERSONA_MAP`（emoji/色/标语），并叠加可选 human_name（"小王/小李…"）增温。
7. **投屏模式**（Phase 3）：一键隐藏 chrome、放大工牌、放慢节奏，适配大屏挂墙。

---

## 7. Phase 地图

| Phase | 主题 | 范围 | 状态 |
|-------|------|------|------|
| **Phase 1** | **端到端骨架** | 1 个真实/模拟 Agent 上报 → 后端伸展引擎（基础自适应）→ `digital_employee_playback` 表 → SSE 端点 → 前端 `useOfficeStream` + 单张工牌渲染。**跑通"1 分钟真实任务拉伸成 ~10 分钟展示"** | ✅ 完成（2026-07-23）— 含质量修复（SSE 连接泄漏/查询优化/测试补全）+ 端到端模拟器验证通过。详见 [phase1 文件](./2026-07-22-digital-employee-virtual-office-phase1.md) |
| **Phase 2** | 多 Agent 工牌墙 | 扩展到 N 个 Agent：响应式网格、办公室概览条、忙碌优先排序、per-badge persona 渐变环、heartbeat metadata 透传、模拟器多员工场景、Celery beat 独立推进器 | ✅ 完成（2026-07-23）— 网格/概览条/排序/persona/metadata/模拟器/Celery beat 独立推进器（Redis 缓存 + SSE 读缓存优先）全部落地 |
| **Phase 3** | 拟人化交互层 | office chatter 信息流、完成/失败 spotlight+toast、忙碌光晕、ambient 动效、hover 展开、投屏模式、`prefers-reduced-motion` 全覆盖 | ✅ 完成（2026-07-23）— 呼吸脉动/忙碌 shimmer/失败红闪/hover 展开+click 跳详情/reduced-motion 降级/chatter ticker/spotlight toast/投屏模式（?mode=presentation 全屏深色+时钟+ESC 退出）全部落地。human_name 为可选叠加项，不阻塞 |
| **Phase 4** | 接入真实内网 Agent + 调参 | 把 autoReportUpload 等真实 Agent 接上心跳 SDK，用真实数据调 `PlaybackConfig`（stretch/pace/忙碌阈值），接静默心跳告警（`is_silent_alert_threshold_minutes` 已建模） | 推进到时起草 |

**推进原则**：Phase 1 跑通端到端再横向扩；每个 phase 独立可验证、可上线。

### 合并前待验证

- [ ] Next.js `/api/backend` 代理 SSE 透传（Plan §4.3 风险点）：前端 `EventSource` 走代理，需确认不缓冲。回退：代理 route 强制流式 / EventSource 直连后端。

---

## 8. 风险与回滚

| 风险 | 缓解 | 状态 |
|------|------|------|
| Next.js `/api/backend` 代理缓冲 SSE | 代理 route 强制流式 / EventSource 直连 | ⚠️ 待验证（合并前） |
| 多 SSE 客户端各自推进引擎竞态 | Celery beat 独立推进器（`office_tick` 每 3s 写 Redis，SSE 读缓存优先） | ✅ 已解决 |
| 节奏参数不舒服 | 全集中在 `PlaybackConfig`，改常量即可 | ✅ 设计就绪 |
| 引擎逻辑 bug 影响展示 | 纯逻辑 + pytest 全覆盖（32 tests）；引擎不碰 DB，故障面小 | ✅ 已覆盖 |
| 新表迁移 | 仅新增 `digital_employee_playback`，不动现有表；回滚 = drop 该表 | ✅ 低风险 |
| Redis 不可用时 SSE 断流 | `_build_tick_sync` fallback 直接计算（dev 无 Redis 兼容） | ✅ 已处理 |

---

## 9. 不在本计划范围（YAGNI）

- 3D 办公室 / 虚拟形象动画（用户明确"不是 3D，是工牌"）
- Agent 双向控制（本计划只做"展示"，不下发指令）
- 历史回放/时间轴拖动（未来可基于 `display_event` 扩展）


---

## 10. 本地验证指南

### 快速端到端验证（无需 Celery/Redis）

```bash
# 1. 启动后端（需要 .env 或 .env.test 中的 DATABASE_URL）
cd backend
export $(grep -v '^#' .env.test | xargs)
uvicorn app.main:app --port 8100

# 2. 跑模拟器（3 个员工，8 个任务，含 FAILED/并发/真实 metadata）
python scripts/simulate_agent.py --base http://localhost:8100 --speed 3

# 3. 验证 SSE 推送
curl -N -H "X-API-Key: <your-key>" http://localhost:8100/api/v1/digital-employees/office/stream

# 4. 启动前端
cd frontend && pnpm dev

# 5. 打开工牌墙
# 普通模式：http://localhost:3200/dashboard/ai/digital-employees/office
# 投屏模式：http://localhost:3200/dashboard/ai/digital-employees/office?mode=presentation
```

### 带 Celery beat 的完整模式（生产）

```bash
# 启动 worker + beat（需要 Redis）
celery -A app.tasks.celery_app worker --beat -Q default,reports,insights,scheduled,ai_summary -c 2

# SSE 端点自动读 Redis 缓存，不再各自 advance
```

### 验证清单

| 场景 | 预期 |
|------|------|
| 模拟器上报 1 个 5 秒任务 | 工牌进入"在岗"，进度条**缓慢**爬升（拉伸到 ~1h），不跳变 |
| 连续上报 3 个任务 | 排队计数出现，pace 升高、进度加快消化 |
| 任务播完 | 进入"收尾/PAUSING"，停顿后回"待命" |
| FAILED 任务 | 工牌红色脉动 + chatter toast "😵 卡住了" |
| 并发任务 | 忙碌 shimmer + 排队计数 + pace > 1 |
| 30 分钟无心跳 | 工牌变"离线"、压暗 |
| 浏览器刷新 | 重新连接 SSE，游标已持久化、进度不回退 |
| 投屏模式 | 全屏深色、放大工牌、实时时钟、ESC 退出 |
| chatter ticker | 底部横向滚动最近动态 |
| 多客户端同时看 | Celery beat 单一推进，无竞态 |

---

## 11. 文件清单

### 后端

| 路径 | 职责 |
|------|------|
| `app/services/digital/playback_engine.py` | 伸展引擎纯逻辑（advance/stretch/pace/busy） |
| `app/services/digital/office_service.py` | DB 编排 + 富化 + chatter 事件检测 |
| `app/models/digital_employee_playback.py` | playback 表模型 |
| `app/api/v1/endpoints/digital_office.py` | SSE 端点（Redis 缓存优先 + fallback） |
| `app/celery_tasks/office_tick.py` | Celery beat 独立推进器 |
| `app/tasks/celery_app.py` | Celery 配置（含 beat_schedule） |
| `app/schemas/digital_employee.py` | HeartbeatRequest（含 metadata_json） |
| `scripts/simulate_agent.py` | 端到端模拟器（3 员工 8 任务） |
| `tests/services/digital/test_playback_engine.py` | 引擎单测（11） |
| `tests/services/digital/test_office_service.py` | service 单测（5 纯逻辑 + 7 DB 集成） |
| `tests/api/test_digital_office_stream.py` | SSE 端点测试（10） |

### 前端

| 路径 | 职责 |
|------|------|
| `lib/digital-employee/office-stream-types.ts` | SSE payload 类型 + ChatterEvent |
| `lib/digital-employee/use-office-stream.ts` | EventSource hook（重连退避 + chatter 监听） |
| `components/digital-employee/office/office-badge.tsx` | 工牌组件（拟人化动效） |
| `components/digital-employee/office/office-chatter.tsx` | chatter ticker + Spotlight Toast |
| `app/dashboard/ai/digital-employees/office/page.tsx` | 工牌墙页面（排序 + 概览 + 投屏模式） |
| `app/globals.css` | office 动效 keyframes + reduced-motion |

### 迁移

| 路径 | 说明 |
|------|------|
| `alembic/versions/790a004efd39_add_digital_employee_playback.py` | 新增 playback 表 |
