# 定时报告系统探索报告

## 📋 系统概览

这是一个完整的 **Next.js 14 + FastAPI** 定时报告基础设施，支持日、周、月三种频率的报告自动生成和邮件发送。系统具有：

- ✅ **订阅管理**：用户可创建、编辑、删除报告订阅
- ✅ **多频率支持**：daily（每日）、weekly（每周）、monthly（每月）
- ✅ **AI 摘要**：集成 AI 生成报告总结，支持超时保护和缓存
- ✅ **持久化审计**：完整的推送记录和分类账（ledger）
- ✅ **截图存储**：报告截图上传到 Cloudflare R2，支持缩略图
- ✅ **自动调度**：基于 APScheduler 的后台定时触发
- ✅ **容错设计**：失败重试、AI 超时回退、推送状态跟踪

---

## 🗄️ 后端数据模型

### 1. **ScheduledReportSubscription** 
**文件**: `backend/app/models/scheduled_report.py:51`

用户的报告订阅配置：

```python
class ScheduledReportSubscription(Base):
    id: int                          # 主键
    user_id: int | None             # 用户 ID（nullable）
    email: str                       # 接收邮箱
    project_ids: str                # "1,2,3" 或 "*"（所有项目）
    country: str                     # "US" 或 "US,DE,UK"（多国）
    frequency: str                   # "daily", "weekly", "monthly"
    ai_model: str | None            # 指定 AI 摘要使用的模型
    dispatch_hour: int              # 发送时间（小时，0-23，北京时间）
    dispatch_minute: int            # 发送时间（分钟，0-59）
    dispatch_weekday: int | None    # 周报发送日（0=周一..6=周日）
    dispatch_day: int | None        # 月报发送日（2-28）
    enabled: bool                   # 是否启用
    created_at: datetime
    updated_at: datetime
```

**关键特性**：
- 支持通过 `project_id_list` 和 `country_list` 属性解析字符串
- 配置字段按频率而异（周报需要 `dispatch_weekday`，月报需要 `dispatch_day`）
- 北京时间（Asia/Shanghai）作为标准时区

---

### 2. **ScheduledReportDeliveryLog**
**文件**: `backend/app/models/scheduled_report.py:105`

单次报告推送的执行日志：

```python
class ScheduledReportDeliveryLog(Base):
    id: int
    subscription_id: int            # 关联的订阅
    frequency: str                  # 报告频率
    report_date: str                # "2024-06-01"（报告日期）
    report_month: str | None        # "2024-06"（月报专用）
    email: str
    status: str                     # PENDING / SENT / FAILED
    stage: str                      # 处理阶段（见下文）
    error_message: str | None
    sent_at: datetime | None
    screenshot_r2_key: str | None   # R2 对象键
    screenshot_r2_url: str | None   # 公开 URL
    screenshot_r2_thumb_key: str | None
    screenshot_r2_thumb_url: str | None
    ai_summary: str | None          # Markdown 格式摘要
    created_at: datetime
```

**推送阶段 (DeliveryStage)**：
- `pending` → `preparing` → `fetching_data` → `generating_summary` → `rendering_html` → `capturing_screenshot` → `sending` → `done`/`failed`

---

### 3. **ScheduledReportLedgerEntry**
**文件**: `backend/app/models/scheduled_report.py:138`

定时报告的分类账，用于审计和补发：

```python
class ScheduledReportLedgerEntry(Base):
    id: int
    ledger_key: str                 # "{subscription_id}:{expected_date}"，唯一索引
    subscription_id: int
    frequency: str
    expected_date: str              # "2024-06-01"
    expected_at: datetime           # 预期发送时间（Beijing）
    email: str
    project_ids: str
    country: str
    status: str                     # SENT / FAILED / MISSING
    latest_delivery_log_id: int | None
    error_message: str | None
    sent_at: datetime | None
    last_checked_at: datetime
    created_at: datetime
    updated_at: datetime
```

**核心用途**：
- 记录每个订阅应该发送的所有报告出现时间
- 用于生成管理后台的审计视图（哪个报告缺失/失败）
- 支持按需补发功能

---

## 🔌 API 端点

**文件**: `backend/app/api/v1/endpoints/scheduled_reports.py`

### 订阅管理

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/scheduled-reports/subscriptions` | 列出用户的订阅 |
| POST | `/scheduled-reports/subscriptions` | 创建新订阅 |
| PUT | `/scheduled-reports/subscriptions/{id}` | 编辑订阅 |
| DELETE | `/scheduled-reports/subscriptions/{id}` | 删除订阅 |

### 推送日志

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/scheduled-reports/delivery-logs` | 列出推送历史（分页） |
| POST | `/scheduled-reports/test-email` | 发送测试报告邮件（含真实数据） |

### 分类账和补发

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/scheduled-reports/ledger` | 查询分类账（含筛选、排序、统计） |
| POST | `/scheduled-reports/ledger/{key}/resend` | 补发单个报告（管理员专用） |

### 手动触发

| 方法 | 端点 | 功能 |
|------|------|------|
| POST | `/scheduled-reports/trigger` | 手动触发报告生成（管理员专用，支持指定频率） |

---

## 🔄 核心服务层

### 1. **dispatcher.py**
**文件**: `backend/app/services/scheduled_report/dispatcher.py`

**核心流程**：

```
dispatch_reports(frequency)
  ├─ 获取指定频率的所有启用订阅
  ├─ 使用 ThreadPoolExecutor（8 个工作线程）并发处理
  ├─ 对每个订阅调用 _dispatch_one()
  │   ├─ 创建 DeliveryLog 记录
  │   ├─ 阶段更新（pending → preparing → ... → sending）
  │   ├─ 获取数据和生成 AI 摘要（带超时保护）
  │   ├─ 发送邮件
  │   └─ 标记成功/失败
  └─ 返回统计信息 {sent, failed}
```

**AI 并发控制**：
- `AI_CONCURRENCY_LIMIT = 4`：同时最多 4 个 AI 调用
- `AI_SUMMARY_TIMEOUT_SEC = 90`：AI 调用超时 90 秒
- 使用 `threading.Semaphore` 控制并发
- **缓存机制**：同一轮调度中，相同 (project_ids, country, date) 的报告只生成一次 AI 摘要，其他订阅直接使用缓存

**超时处理**：
- 基于信号 (SIGALRM) 的 Unix 实现
- Windows 上无超时保护，直接调用
- 超时时使用纯文本回退摘要，不中断整个调度

---

### 2. **subscription_service.py**
**文件**: `backend/app/services/scheduled_report/subscription_service.py`

**关键函数**：

| 函数 | 用途 |
|------|------|
| `get_subscriptions_by_user(db, user_id, frequency, enabled_only)` | 查询用户订阅 |
| `get_active_subscriptions(db, frequency)` | 查询启用的订阅 |
| `create_subscription(db, user_id, data)` | 创建订阅 |
| `update_subscription(db, subscription_id, data)` | 更新订阅 |
| `delete_subscription(db, subscription_id)` | 删除订阅 |
| `create_delivery_log(db, sub_id, frequency, report_date, email)` | 创建推送日志 |
| `create_delivery_log_with_stage(db, sub_id, ..., initial_stage)` | 创建日志并指定初始阶段 |
| `mark_delivery_success(db, log_id)` | 标记推送成功 |
| `mark_delivery_failed(db, log_id, error_message)` | 标记推送失败 |
| `update_delivery_log_screenshot(db, log_id, ...)` | 更新截图 R2 信息 |
| `update_delivery_log_ai_summary(db, log_id, summary)` | 更新 AI 摘要 |

---

### 3. **ledger_service.py**
**文件**: `backend/app/services/scheduled_report/ledger_service.py`

**核心概念**：

分类账记录系统的"预期推送"，与实际的"推送日志"做对账：

```
refresh_ledger(db, start_date, end_date, frequency, status, ...)
  ├─ 遍历日期范围内的每一天
  ├─ 对于每个启用的订阅，计算该天是否应该发送报告
  ├─ 生成预期出现 (ExpectedOccurrence)
  ├─ Upsert 分类账条目（如果存在则更新）
  ├─ 关联最新的推送日志，分类状态 (SENT / FAILED / MISSING)
  └─ 返回带统计摘要的列表响应
```

**补发流程**：

```
resend_ledger_entry_async(db, ledger_key, ignore_status=False)
  ├─ 查询分类账条目
  ├─ 检查状态是否允许补发（默认只能补发 FAILED，force=True 可补发任何状态）
  ├─ 调用 _dispatch_one() 重新生成和发送报告
  └─ 返回新的 DeliveryLog ID 和状态
```

---

## 📧 邮件和报告生成

### 报告生成器

| 文件 | 用途 |
|------|------|
| `report_builder_daily.py` | 日报数据聚合和 HTML 生成 |
| `report_builder_weekly.py` | 周报数据聚合和 HTML 生成 |
| `email_sender_daily.py` | 日报邮件发送（Resend） |
| `email_sender_weekly.py` | 周报邮件发送（Resend） |

### AI 摘要

| 文件 | 用途 |
|------|------|
| `ai_enhancer_daily.py` | 日报 AI 摘要生成 |
| `ai_enhancer_weekly.py` | 周报 AI 摘要 + 属性分析 + 异常检测 |

### 截图

| 文件 | 用途 |
|------|------|
| `screenshot.py` | 使用 Playwright 截取报告 HTML，上传到 R2，生成缩略图 |

---

## ⏰ 自动调度机制

**文件**: `backend/app/core/scheduler.py`

### 触发方式

系统使用 **APScheduler** 的 **minutely scan** 模式：

```
APScheduler (Background Thread)
  └─ 每分钟执行一次 _run_minutely_scan()
      ├─ 获取当前北京时间：hour, minute, weekday, day
      ├─ 查询数据库：enabled=True AND dispatch_hour=current_hour AND dispatch_minute=current_minute
      ├─ 按 frequency 分组（daily / weekly / monthly）
      ├─ 对于 weekly：额外检查 dispatch_weekday 匹配
      ├─ 对于 monthly：额外检查 dispatch_day 匹配
      └─ 调用 _dispatch_subscriptions(frequency, filtered_subscriptions)
```

### 初始化

```python
# 在 FastAPI 启动时调用
init_scheduler()
  ├─ 创建 BackgroundScheduler（timezone=Asia/Shanghai）
  ├─ 加载 insight schedules
  ├─ 注册 minutely scan job
  └─ 启动后台线程
```

### 关闭

```python
shutdown_scheduler()
  ├─ 关闭 insight schedules
  └─ 停止 APScheduler
```

**为什么用 minutely scan 而不是 cron job？**
- Cron 表达式对时间约束不够灵活（无法处理"当前小时 AND 当前分钟"的多个独立订阅）
- Minutely scan 允许动态筛选数据库中的订阅，在运行时决定是否触发
- 每个订阅的调度参数完全独立，支持用户自定义发送时间

---

## 🎨 前端实现

**文件**: `frontend/app/dashboard/system-management/scheduled-reports/scheduled-reports-client.tsx`

### 页面结构

**组件分层**：

1. **ScheduledReportsPage** (page.tsx)
   - 顶级路由组件
   - 调用 `<ScheduledReportsClient />`

2. **ScheduledReportsClient** (scheduled-reports-client.tsx)
   - 核心客户端组件（697 行）
   - 管理以下三个标签页：
     - **Subscriptions**：订阅管理（列表、创建、编辑、删除）
     - **Delivery Logs**：推送历史（状态筛选、分页）
     - **Ledger**：分类账（日期范围筛选、状态筛选、补发）

3. **SubscriptionForm** (内嵌)
   - 订阅创建/编辑表单
   - 支持：邮箱、频率、时间、项目、国家、AI 模型
   - 包含验证逻辑（如周一 16:00 限制）
   - 测试邮件功能

### 关键功能

#### 订阅管理
- 创建：`POST /scheduled-reports/subscriptions`
- 编辑：`PUT /scheduled-reports/subscriptions/{id}`
- 删除：`DELETE /scheduled-reports/subscriptions/{id}`
- 列表：`GET /scheduled-reports/subscriptions`

#### 推送历史
- 列表：`GET /scheduled-reports/delivery-logs?limit=50&offset=0&status_filter=...`
- 预览截图（Dialog）

#### 分类账
- 查询：`GET /scheduled-reports/ledger?start_date=2024-06-01&end_date=2024-06-30&frequency=...&status_filter=...&limit=100&offset=0`
- 统计摘要：`{expected, sent, failed, missing, resendable}`
- 补发：`POST /scheduled-reports/ledger/{key}/resend?force=false`
- 预览截图、AI 摘要、错误信息

### 前端类型定义

```typescript
type Frequency = "daily" | "weekly" | "monthly"
type LedgerStatus = "sent" | "failed" | "missing"
type ResendStage = "pending" | "preparing" | ... | "done" | "failed"

interface Subscription {
  id: number
  email: string
  project_ids: string
  country: string
  frequency: Frequency
  dispatch_hour: number
  dispatch_minute: number
  dispatch_weekday?: number
  dispatch_day?: number
  ai_model?: string
  enabled: boolean
  created_at: string
  updated_at: string
}

interface LedgerItem {
  ledger_key: string
  expected_date: string
  expected_at: string
  frequency: Frequency
  email: string
  status: LedgerStatus
  can_resend: boolean
  screenshot_r2_url?: string
  ai_summary?: string
  error_message?: string
}
```

---

## 📊 数据流图

### 创建订阅

```
User (Frontend)
  │ POST /subscriptions {email, frequency, dispatch_hour, ...}
  ↓
SubscriptionCreate (Pydantic Schema)
  ├─ 字段验证（邮箱、频率、时间范围）
  └─ 业务验证（周报周一限制）
  ↓
create_subscription() (Service)
  ├─ 创建 ScheduledReportSubscription 记录
  └─ 返回保存后的订阅
  ↓
SubscriptionItem (Response Schema)
  ↓
Frontend: 更新列表、显示成功提示
```

### 定时推送流程

```
APScheduler (minutely scan)
  │ 每分钟检查：enabled=True AND dispatch_hour=now AND dispatch_minute=now
  ↓
dispatch_reports(frequency="daily")
  ├─ 获取所有启用的日报订阅
  ├─ ThreadPoolExecutor (8 workers)
  │   ├─ Task 1: _dispatch_one(sub_1)
  │   ├─ Task 2: _dispatch_one(sub_2)
  │   └─ ...
  │
  └─ 每个任务内部：
      ├─ create_delivery_log(status=PENDING, stage=PENDING)
      ├─ 阶段更新：PENDING → PREPARING → FETCHING_DATA → ...
      ├─ 获取项目数据（从数据库查询销售、费用等）
      ├─ AI 摘要生成（带 Semaphore 限流）
      ├─ HTML 渲染 + Playwright 截图
      ├─ 截图上传到 R2
      ├─ 发送邮件（Resend）
      └─ 标记成功/失败 + 更新 stage=DONE/FAILED
```

### 补发流程

```
Admin (Frontend) 点击补发按钮
  │ POST /ledger/{key}/resend?force=false
  ↓
API: 检查权限 (is_admin=True)
  ↓
resend_ledger_entry_async(db, ledger_key, ignore_status=force)
  ├─ 查询 ScheduledReportLedgerEntry
  ├─ 检查状态（force=True 跳过检查）
  └─ 调用 _dispatch_one() 重新生成和发送
  ↓
返回新的 DeliveryLog ID 和状态
  ↓
Frontend: 刷新列表或显示新的推送日志
```

---

## 🛠️ 配置和参数

### 环境变量（如果有）

当前代码中未发现显式的环境变量配置。关键硬编码参数：

| 参数 | 值 | 位置 |
|------|-----|------|
| `AI_CONCURRENCY_LIMIT` | 4 | dispatcher.py:54 |
| `AI_SUMMARY_TIMEOUT_SEC` | 90 | dispatcher.py:57 |
| `_STAGE_MIN_SEC` | 1.5 | dispatcher.py:87 |
| 时区 | `Asia/Shanghai` | scheduler.py:155, ledger_service.py:23 |

### 字段验证规则

在 `backend/app/schemas/scheduled_report.py` 中定义：

```python
# 周报配置
if frequency == "weekly":
  dispatch_weekday: 0-6（0=周一, 默认 0）
  周一时 dispatch_hour >= 16（最早 16:00）

# 月报配置
if frequency == "monthly":
  dispatch_day: 2-28（默认 2）
```

---

## 🔍 关键代码位置速览

| 功能 | 文件 | 行数 |
|------|------|------|
| 模型定义 | backend/app/models/scheduled_report.py | 21-175 |
| Schema | backend/app/schemas/scheduled_report.py | 1-185 |
| API 端点 | backend/app/api/v1/endpoints/scheduled_reports.py | 1-250+ |
| 订阅 CRUD | backend/app/services/scheduled_report/subscription_service.py | 1-243 |
| 调度器 | backend/app/services/scheduled_report/dispatcher.py | 1-350+ |
| 分类账 | backend/app/services/scheduled_report/ledger_service.py | 1-200+ |
| 后台调度 | backend/app/core/scheduler.py | 1-199 |
| 前端页面 | frontend/app/dashboard/system-management/scheduled-reports/ | |
| - 路由 | frontend/app/dashboard/system-management/scheduled-reports/page.tsx | |
| - 客户端 | frontend/app/dashboard/system-management/scheduled-reports/scheduled-reports-client.tsx | 697 行 |

---

## 🚀 最佳实践和设计亮点

### 1. **AI 并发控制**
- 使用 Semaphore 限制同时 AI 调用数
- 同一轮调度内相同配置的报告共用 AI 摘要缓存，大幅减少 API 调用
- 信号基超时保护，防止 AI 调用阻塞整个批次

### 2. **阶段化推送**
- DeliveryLog 的 `stage` 字段记录每一步状态
- 用户和管理员可在前端看到实时进度
- 最小显示时间 (_STAGE_MIN_SEC) 确保快速阶段不会闪烁

### 3. **持久化审计**
- DeliveryLog：每次实际推送尝试的记录
- LedgerEntry：系统期望应该发送的记录
- 两表对账可快速识别：漏发、重复、失败等异常

### 4. **灵活的时间配置**
- 每个订阅可独立设置发送时间（hour:minute）
- 周报和月报支持额外的频率约束（weekday / day）
- 一致使用北京时间，减少时区混乱

### 5. **前端即时反馈**
- 测试邮件功能：发送含真实数据的邮件，预览报告效果
- 分类账统计：一目了然的 expected / sent / failed / missing 计数
- 补发功能：管理员可手动补发失败或缺失的报告

---

## ⚠️ 已知限制和改进空间

### 当前限制
1. **Windows 上无 AI 超时**：信号基超时只在 Unix 上有效
2. **APScheduler 单进程**：不支持多进程部署的分布式调度
3. **缓存在内存中**：每次调度重新创建缓存，不跨进程或跨启动
4. **邮件提供商依赖**：当前使用 Resend，如更换需修改发送器

### 潜在改进
1. 可考虑使用 Redis 实现分布式缓存（AI 摘要）
2. 支持 Celery 或其他消息队列用于异步任务
3. 添加 webhook 通知（代替或补充邮件）
4. 支持按条件动态过滤项目（如销售额阈值）
5. 批量报告导出功能

---

## 📝 总结

这个定时报告系统展现了生产级别的设计理念：

✅ **模块化**：清晰的分层（模型 → Schema → API → Service → 调度）
✅ **可观测**：完整的日志、阶段追踪、分类账审计
✅ **高效**：AI 并发限流和缓存机制，减少重复计算
✅ **可靠**：超时保护、失败重试、fallback 摘要
✅ **易维护**：标准 ORM（SQLAlchemy）、Pydantic 验证、类型注解

系统已准备好支持大规模用户的定时报告需求，同时保留了充足的定制空间。
