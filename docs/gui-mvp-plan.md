# believeboy-gui MVP 方案（macOS 桌面客户端）

> **状态**：v0.1（2026-08-14 起草）
> **目标**：复用现有 FastAPI 后端，新增一个 Rust + GPUI 的 macOS 桌面客户端
> **推进策略**：按 frontend sidebar 顺序逐个搬运

## 0. 背景与目标

`believeboyDashboard` 当前形态：

- **前端**：Next.js，部署在 Vercel（自动）
- **后端**：FastAPI，部署在 VPS `145.79.143.98:8100`，systemd + Caddy 反代
- **用户场景**：亚马逊跨境电商运营团队，盯销售、库存、退货、广告、CRM

用户的痛点（推断自现有 dashboard 的形态）：
- Web 端打开要等加载、地址栏来回切；运营同时盯多个项目时切换成本高
- macOS 通知 / 菜单栏 / 全局快捷键等原生能力用不上
- 没有"打开即用"的开机自启 + 系统托盘常驻形态

目标：**做一个 macOS 桌面 App，作为现有 Web 端的并列客户端**。后端不动，前端继续存在，桌面端是新形态。

## 1. 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| 语言 | Rust | 性能 + 类型安全 + 跟后端 FastAPI 的 Pydantic 类型可互参 |
| GUI 框架 | GPUI | Zed 出品，原生 Metal 渲染、ECS 心智模型、未来可复用 Zed 生态 |
| HTTP | reqwest + rustls | tokio 生态标配 |
| WebSocket | tokio-tungstenite | 实时数据刷新（远期） |
| 序列化 | serde + serde_json | 与 Pydantic 模型 1:1 |
| 鉴权 | JWT + Keychain | macOS Keychain 存 refresh token |
| 本地存储 | redb（远期） | MVP 不接入 |
| 打包 | cargo + macOS .app bundle | 后续可加 sparkle 自动更新 |

**为什么不用 Tauri / Dioxus / Electron**：
- 都已经讨论过，目标是"原生级 macOS 体验 + 极致性能"
- 团队愿意吃 Rust 学习曲线
- GPUI 在 Zed 上已经验证可行

## 2. 仓库布局

```
believeboyDashboard/
├── backend/          # 已有，不动
├── frontend/         # 已有，不动
├── docs/             # 已有
└── gui/              # ★ 新增：桌面客户端
    ├── Cargo.toml
    ├── rust-toolchain.toml
    ├── README.md
    └── crates/
        ├── gui-domain/        # 纯类型层，serde 模型
        ├── gui-api-client/    # reqwest 封装
        └── gui-app/           # GPUI 应用
```

依赖方向：`gui-app` → `gui-api-client` → `gui-domain`（单向）。

## 3. 推进顺序（与 sidebar 一一对应）

| 阶段 | 范围 | 后端依赖 | 难度 | 估时 |
|---|---|---|---|---|
| **0.1** | workspace 骨架 + GPUI 跑通 | 无 | 低 | 0.5d |
| **0.2** | 鉴权（login + Keychain 存 token） | `/api/v1/auth/login` | 中 | 1d |
| **0.3** | 收编：把 8 大分类的 sidebar 数据权威同步到 GUI | 8 大分类对应端点盘点 | 中 | 1d |
| **0.4** | `gui-domain` 补全（按 sidebar 模块） | 同上 | 中 | 1d |
| **0.5** | `gui-api-client` 补全（同上） | 同上 | 中 | 1-2d |
| **1.0** | **Dashboard 首页 MVP（只读）** | daily-analysis + projects | 中 | 2-3d |
| **2.0** | 运营 → 站点导航 | 静态页面 | 低 | 0.5d |
| 2.1 | 运营 → 店铺导航 | 静态页面 | 低 | 0.5d |
| 2.2 | 运营 → 销售数据 | daily-analysis（细化） | 中 | 2d |
| 2.3 | 运营 → 退货分析 | return-analysis | 中 | 1.5d |
| 2.4 | 运营 → 项目目标 | project-goals | 中 | 1.5d |
| 2.5 | 运营 → 调研分析 | research-analysis | 中 | 1.5d |
| 2.6 | 运营 → 平台巡检 | platform-inspection | 中 | 1.5d |
| 2.7 | 运营 → 库存分析 | inventory-analysis | 中 | 1.5d |
| 2.8 | 运营 → 按周产品分析 | weekly-product-analysis | 中 | 1.5d |
| 2.9 | 运营 → 组合分析 | portfolio-overview | 中 | 1.5d |
| 2.10 | 运营 → SKU 信息 | sku-info | 中 | 1d |
| 2.11 | 运营 → 补货分析 | inventory-replenishment | 中 | 1.5d |
| 2.12 | 运营 → 库存分类账 | inventory-ledger | 高 | 2d |
| 2.13 | 运营 → 季节性补货 | seasonal-replenishment | 中 | 1.5d |
| 2.14 | 运营 → 发货管理 | shipment-management | 中 | 1.5d |
| **3.0** | 报表中心（财务月报、产品分析、新品核算、店铺测算、定时报告、报表自动化、订单信息） | 7 个子项 | 高 | 5-7d |
| **4.0** | 财务资金（平台回款、汇率、VAT 发票、佣金管理） | 4 个子项 | 中 | 3d |
| **5.0** | 广告（广告分析、广告数据） | 2 个子项 | 中 | 2d |
| **6.0** | AI 智能（7 个子项） | 7 个子项 | 高 | 5-7d |
| **7.0** | CRM 客户与合作伙伴（7 个子项） | 7 个子项 | 高 | 5-7d |
| **8.0** | 工具箱（2 个子项） | 2 个子项 | 低 | 1d |
| **9.0** | 系统管理（8 个子项） | 8 个子项 | 中 | 3d |

总计：约 60-80 工作日（3-4 个月）。

## 4. Phase 1：Dashboard 首页 MVP 详细设计

### 4.1 范围

完整复刻 frontend `app/dashboard/page.tsx` 的"只读"形态：

- 项目选择器（顶部下拉）
- KPI 数字带（V2Stats）
- 6 个图表（recharts → GPUI 自绘或 plotters）
- 「Top 项目」列表

**MVP 简化（v1.0）**：
- 6 个图表**不重画**——先用 6 个数字大卡片占位，标注"图表 v1.1 接入"
- 重点打通：项目切换 → 重新拉数据 → 数字带 + 列表渲染

### 4.2 数据流

```
[用户切换项目] 
    ↓
[Dashboard View 触发 loadData()]
    ↓
[gui-api-client::Client]
    ↓
GET /api/v1/projects/managed          → ManagedProject 列表
GET /api/v1/daily-analysis/all         → DailyAnalysisResponse
GET /api/v1/daily-analysis/all-countries → DailyAnalysisAllCountriesResponse
    ↓
[反序列化到 gui-domain 类型]
    ↓
[Dashboard View 状态更新]
    ↓
[GPUI 重新渲染]
```

### 4.3 状态机

```rust
enum DashboardState {
    Loading,
    Loaded {
        current_rows: Vec<DailyAnalysisRow>,
        comparison_rows: Vec<DailyAnalysisRow>,
        project_breakdown: HashMap<i64, ProjectBreakdownEntry>,
        country_breakdown: HashMap<String, CountryBreakdownEntry>,
        countries_loading: bool,
    },
    Empty,    // 当前无项目
    Error(String),
}
```

### 4.4 GPUI 视图骨架

```rust
// crates/gui-app/src/views/dashboard.rs
pub struct DashboardView {
    state: Model<DashboardState>,
    client: Client,
    projects: Vec<ManagedProject>,
    selected_project_id: ProjectId,
}

impl DashboardView {
    pub fn new(cx: &mut AppContext) -> Self { ... }
    fn reload(&mut self, cx: &mut ViewContext<Self>) { ... }
}

impl Render for DashboardView {
    fn render(&mut self, cx: &mut ViewContext<Self>) -> impl IntoElement {
        // 顶部项目选择器
        // KPI 数字带
        // 6 个图表占位卡
        // Top 项目列表
    }
}
```

### 4.5 关键风险

| 风险 | 缓解 |
|---|---|
| GPUI 图表库缺 | 数字大卡片 MVP 先行；图表用 `plotters` 或 Zed 内置组件；远期自绘 |
| FastAPI 端点与 GUI 类型不一致 | 阶段 0.5 一次性联调对齐；Pydantic ↔ Rust 类型加 integration test |
| GPUI 0.1.x API 不稳定 | `Cargo.toml` 锁版本；关注 zed-industries/zed 主仓更新 |
| 鉴权 token 过期 | 0.2 阶段就接 refresh token，401 自动重试 |
| macOS Keychain 权限弹窗 | 0.2 阶段首次启动时引导 |

## 5. Issue 拆分（建议结构）

主 issue：**「相信 boy GUI 桌面客户端 — Phase 1 (Dashboard MVP)」**

子 issue（按子任务建，便于分配和追踪）：

1. **GUI-1** workspace 骨架（0.1）← 这次已起好
2. **GUI-2** 鉴权（0.2）
3. **GUI-3** sidebar 数据权威收编到 GUI（0.3）
4. **GUI-4** `gui-domain` Dashboard 模块（0.4-1）
5. **GUI-5** `gui-api-client` Dashboard 方法（0.5-1）
6. **GUI-6** Dashboard View 状态机
7. **GUI-7** Dashboard 数字带（V2Stats）
8. **GUI-8** Dashboard 图表占位卡
9. **GUI-9** Dashboard Top 项目列表
10. **GUI-10** macOS .app 打包 + 签名 + 公证
11. **GUI-11** 端到端冒烟（启动 → 登录 → 看到数字带）

每个子 issue 必须有：
- Done when：可验证的验收条件
- Evidence：截图 / 命令输出 / 测试报告
- 依赖：blockedBy 链

## 6. 不在 MVP 范围

- 写操作（dashboard 全是只读；CRM / 报表中心才有写）
- 实时数据推送（WebSocket 远期）
- 离线模式（redb 远期）
- Windows / Linux（先 macOS only）
- 自动更新（sparkle 远期）
- App Store 发布（先 DMG 直传）

## 7. 验收标准（Phase 1 完成定义）

- [ ] 启动 App 弹出登录窗口
- [ ] 用真实账号登录成功，token 存到 Keychain
- [ ] 切换项目能正确重新拉数据
- [ ] 数字带显示 6 个核心 KPI（销售额、订单量、广告花费、ACoS、转化率、毛利润等）
- [ ] 6 个图表位置放占位卡，标注"v1.1 接入图表"
- [ ] Top 项目列表显示 N 个项目（按销售额排序）
- [ ] 关掉 App 重新打开，token 自动续期、不需重新登录
- [ ] macOS 通知中心权限申请正常
- [ ] `cargo build --release` 产出 `.app` bundle
- [ ] 通过 `cargo clippy --all-targets --all-features -- -D warnings`
- [ ] 通过 `cargo test`（含 api-client 单元测试）

## 8. 后续阶段

- 2.0 起按 sidebar 顺序继续搬运
- 每个一级分类拆一个主 issue + 多个子 issue
- 每完成 3-5 个子项做一次回顾，调整后续节奏
