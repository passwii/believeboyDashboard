# 告警中心 + 通知中心 + 全局搜索 设计文档

> 日期：2026-07-29
> 状态：待审阅
> 范围：三期交付（P1 告警中心 → P2 通知中心 → P3 全局搜索）

## 1. 背景与动机

Dashboard 已有 9 大模块、79 个页面。后端告警系统（`AlertRule` / `AlertEvent` / `AlertPreference` 模型 + 13 个 API 端点 + 检测器 + 邮件分发）已完整，但存在三个缺口：

1. **告警无前端管理页**：只有首页一个 AlertWidget，无法配置规则、浏览事件历史
2. **告警无定时检测**：只能管理员手动 `POST /alerts/detect`，没有 Celery beat
3. **通知是纯前端的**：`NotificationsProvider` 基于 localStorage，不跨设备，顶栏无铃铛入口
4. **无全局导航**：79 个页面没有 Cmd+K 快速跳转

## 2. 架构总览

```
P1 告警中心          P2 通知中心           P3 全局搜索
─────────────       ─────────────        ─────────────
Celery beat         notifications 表      Cmd+K 命令面板
定时跑 detector     Notification API      最近访问(localStorage)
       │            铃铛 + 下拉面板        纯导航搜索
       ▼            30s 轮询未读数
  AlertEvent ──→ dispatcher 钩子 ──→ Notification 行
  (已有)          (改：写 in_app)        (新建)
```

三期共享一条数据管线，按依赖顺序交付。P2 依赖 P1（告警事件是通知的主要来源），P3 独立。

## 3. P1：告警中心

### 3.1 后端：Celery beat 定时检测

新增 Celery 任务 `alert_detect`，每 15 分钟跑一次全量规则检测 + 分发。

**文件**：`backend/app/celery_tasks/alert_detection.py`

```python
@celery_app.task(name="alert_detect")
def alert_detect():
    db = SessionLocal()
    try:
        events = detect_anomalies(db)
        db.commit()
        if events:
            dispatch_batch(db, events)
    finally:
        db.close()
```

**注册**：`backend/app/tasks/celery_app.py` 的 `beat_schedule` 加：

```python
"alert-detect": {
    "task": "alert_detect",
    "schedule": crontab(minute="*/15"),
},
```

路由到 `default` 队列（短任务，和 `office_tick` / `crm_sea_reclaim` 同级）。

**不改现有 API**——13 个端点原样复用。

### 3.2 前端：告警中心页面

**路径**：`/dashboard/system/alerts`

**Sidebar 位置**：系统管理组，图标 `Bell`，排在"日志查看"前面。

**页面结构**（单页三 Tab）：

- **统计卡片条**：复用 `GET /alerts/stats`，展示活跃告警数、严重/警告/信息分布、今日确认/解决数
- **Tab 1 - 告警事件**：
  - 筛选：状态（active / acknowledged / resolved）+ 严重度 + 项目
  - 表格列：时间 | 项目 | 指标 | 消息 | 偏差% | 状态
  - 行操作：确认（`POST /alerts/events/{id}/acknowledge`）、解决（`POST /alerts/events/{id}/resolve`）
  - 分页（复用 `AlertEventListResponse`）
- **Tab 2 - 告警规则**：
  - 表格列：名称 | 项目 | 指标 | 条件 | 阈值 | 启用状态
  - 行操作：编辑、删除、启用/停用 toggle
  - 新建规则按钮 → Dialog 表单
  - 表单字段：名称 / 项目 / 国家 / 指标（select，从 `GET /alerts/metrics` 拉选项）/ 触发类型 / 条件 / 阈值 / 窗口天数 / 严重度 / 通知通道
- **Tab 3 - 通知偏好**：
  - 表单：邮件开关 / 站内开关 / 最低严重度 / 免打扰时段
  - 保存调 `PATCH /alerts/preferences`

**组件拆分**：

```
frontend/app/dashboard/system/alerts/
  page.tsx                    # 页面壳：Tab 切换 + 统计卡片
  components/
    alert-stats-bar.tsx       # 统计卡片条
    alert-events-tab.tsx      # 事件表格 + 筛选 + 确认/解决
    alert-rules-tab.tsx       # 规则表格 + CRUD
    alert-rule-dialog.tsx     # 新建/编辑规则 Dialog
    alert-preferences-tab.tsx # 偏好表单
```

**API 调用**：用现有的 `buildBackendClientHeaders` + fetch 模式。

**不做**：事件详情抽屉、规则模板/预设、批量确认/解决、首页 AlertWidget 改动。

## 4. P2：通知中心

### 4.1 后端：数据模型

新模型 `Notification`，一个 Alembic 迁移。

**文件**：`backend/app/models/notification.py`

```python
class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("idx_notif_user_read", "user_id", "read"),
        Index("idx_notif_user_created", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    # V1: "alert" | "system"，预留扩展 "crm_follow_up" | "replenishment" 等
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 结构化载荷：{"alert_event_id": 42, "project_id": 3, "severity": "critical",
    #             "link": "/dashboard/system/alerts"}
    read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

主键 `Integer`（遵循仓库约定，对齐 `alert_rule.py` 风格）。

### 4.2 后端：API 端点

**文件**：`backend/app/api/v1/endpoints/notifications.py`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/notifications` | 分页列表（`?type=&read=&page=&page_size=`） |
| `GET` | `/notifications/unread-count` | 轻量计数（轮询专用，返回 `{"count": N}`） |
| `POST` | `/notifications/{id}/read` | 标记单条已读 |
| `POST` | `/notifications/read-all` | 全部已读 |
| `DELETE` | `/notifications/{id}` | 删除单条 |

用户识别：通过 `X-User-Id` header（和现有 alerts preferences 一致）。

**Schemas**：`backend/app/schemas/notification.py`

```python
class NotificationItem(BaseModel):
    id: int
    type: str
    title: str
    message: str | None
    data: dict | None
    read: bool
    read_at: datetime | None
    created_at: datetime
    model_config = {"from_attributes": True}

class NotificationListResponse(BaseModel):
    items: list[NotificationItem]
    total: int
    page: int
    page_size: int

class UnreadCountResponse(BaseModel):
    count: int
```

### 4.3 后端：Dispatcher 钩子

在 `backend/app/services/alert/dispatcher.py` 的 `dispatch_batch` 中，对 `in_app_enabled=True` 的用户，除发邮件外同时写 `Notification` 行：

```python
# dispatch_batch 内，filtered 确定后
if pref.in_app_enabled:
    for evt in filtered:
        db.add(Notification(
            user_id=user_id,
            type="alert",
            title=evt.message,
            data={
                "alert_event_id": evt.id,
                "project_id": evt.project_id,
                "severity": evt.severity,
                "link": "/dashboard/system/alerts",
            },
        ))
db.commit()
```

`AlertPreference.in_app_enabled` 字段已存在但从未被使用——这是补上这个缺口。

### 4.4 前端：铃铛 + 通知面板

**铃铛位置**：主内容区右上角固定浮动按钮（`fixed right-4 top-3 z-50`），和移动端汉堡按钮对称。不侵入 sidebar 架构。

**交互**：
- 铃铛上红色未读徽标（数字）
- 点击铃铛 → Popover 面板（360px 宽）
- 面板内容：通知列表（未读蓝点 + 浅蓝底，已读灰底）、全部已读按钮、加载更多
- 点击通知 → 跳转 `data.link`（如 `/dashboard/system/alerts`）

**轮询策略**：
- 组件挂载后每 30s `GET /notifications/unread-count`
- 面板打开时立即拉完整列表（`GET /notifications?page_size=20`）
- 标记已读 / 全部已读：乐观更新 UI，后台 fire-and-forget
- `document.hidden` 时暂停轮询

**组件拆分**：

```
frontend/components/notifications/
  notification-bell.tsx       # 浮动铃铛 + 未读徽标 + Popover
  notification-panel.tsx      # 面板：列表 + 全部已读 + 加载更多
  notification-item.tsx       # 单条通知（未读/已读样式 + 跳转）
  use-server-notifications.ts # hook：轮询 + 列表 + 已读操作
```

**和现有 toast 系统的关系**：
- `NotificationsProvider`（toast）保持不变——负责操作反馈（"保存成功"、"导出完成"）
- `useServerNotifications` 负责服务端事件通知（告警、系统消息）
- 两套系统职责不重叠，共存

**不做**：SSE/WebSocket、通知分组/标签页、桌面推送（Web Push）、独立通知偏好页面（复用告警偏好的 `in_app_enabled`）。

## 5. P3：全局搜索（Cmd+K）

### 5.1 纯前端，零后端

数据源：`SIDEBAR_TOP_GROUPS`（`frontend/lib/sidebar-config.ts`）——9 个分组、54 个导航项，每项有 `title`、`url`、`icon`、所属 `group.label`。

### 5.2 交互

- `Cmd+K`（Mac）/ `Ctrl+K`（Win）弹出 Dialog
- 自动聚焦输入框
- **无输入时**：显示最近访问（最多 5 条）+ 快捷入口（固定 3 个：告警中心、定时报告、销售数据）
- **有输入时**：按模块分组显示匹配结果
- 键盘：`↑`/`↓` 选择，`Enter` 跳转，`Esc` 关闭
- 无结果时显示"未找到匹配页面"

### 5.3 最近访问记录

- 存储：`localStorage` key `believeboy:recent-pages`，JSON 数组，最多 8 条
- 记录时机：dashboard layout 监听 `pathname` 变化，匹配到 `SIDEBAR_TOP_GROUPS` 中的页面则 unshift 进数组（去重、截断）
- 展示：对话框空输入时显示前 5 条

### 5.4 搜索算法

客户端子串匹配，标题 + 模块名双字段：

```typescript
function searchPages(query: string): SearchResult[] {
  const q = query.toLowerCase()
  return SIDEBAR_TOP_GROUPS.flatMap(group =>
    group.items
      .filter(item =>
        item.title.toLowerCase().includes(q) ||
        group.label.toLowerCase().includes(q)
      )
      .map(item => ({ ...item, groupLabel: group.label, groupIcon: group.icon }))
  )
}
```

54 个条目，性能零压力。

### 5.5 组件拆分

```
frontend/components/command-palette/
  command-palette.tsx         # Dialog 壳 + 输入框 + 键盘导航
  command-palette-trigger.tsx # 全局 Cmd+K 监听（挂 layout）
  recent-pages.ts             # localStorage 读写 + 记录 hook
  search-pages.ts             # 搜索逻辑（纯函数，可单测）
```

**挂载点**：`command-palette-trigger.tsx` 在 `dashboard/layout.tsx` 引入，全局生效。Dialog 用 shadcn `Dialog`。

**不做**：后端实体搜索、搜索历史/热门搜索、拼音匹配、动画花活。

## 6. 交付顺序与依赖

| 阶段 | 内容 | 依赖 | 预估 |
|------|------|------|------|
| P1 | Celery beat + 告警中心前端页面 | 无（后端 API 已就绪） | 2-3 天 |
| P2 | Notification 模型/迁移/API + dispatcher 钩子 + 铃铛 UI | P1（告警事件是通知来源） | 2-3 天 |
| P3 | Cmd+K 命令面板 + 最近访问 | 无（纯前端） | 1 天 |

P3 和 P1/P2 无依赖，可以并行开发。

## 7. 测试策略

- **P1**：Celery task 单测（mock `detect_anomalies` + `dispatch_batch`）；前端组件测试（Vitest + Testing Library）
- **P2**：Notification API 端点测试（pytest，含分页/筛选/已读）；dispatcher 钩子测试（验证 `in_app_enabled` 用户收到 Notification 行）；前端轮询 hook 测试
- **P3**：`search-pages.ts` 纯函数单测；`recent-pages.ts` localStorage 读写单测

## 8. 迁移与部署

- P2 需要一个新的 Alembic 迁移（`notifications` 表），遵循仓库命名约定：`YYYYMMDD_NNN_description.py`，纯数字短 revision id
- P1 的 Celery beat 改动需要重启 Celery worker + beat（`systemctl restart believeboy-celery*`）
- 前端改动推 Vercel 自动部署
- 后端改动走 `git deploy`（自动 SSH → pull → migrate → restart）
