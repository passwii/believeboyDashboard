# CRM 路线图 · P2–P4（下一阶段规划）

> **状态（2026-07-23）**：规划草案，待用户定优先级。P1a+P1b 已完成（客户/联系人/用户 + 线索/跟进/转化 + 权限 + 前端接通，商机已移除）。本文档为**未跟踪草稿**，待 main 合并落定后入分支提交。

## 0. 现状回顾

**已交付（真实可用）：**
- 漏斗：线索 Lead → 转化 convert → 客户 Customer(+联系人 Contact) + 跟进 Follow（无商机）。
- 客户/联系人/用户 CRUD + scope(mine/all/sea) + 公海(领取/转移/释放)。
- 线索 CRUD + 线索池 + 转化（跟进记录+微信搬到新客户）。
- 跟进：分类型(电话/微信/拜访/备注) + next_follow_at 下次提醒 + 回写客户 last_follow_at。
- 权限：销售只见自己+公海、指派仅管理员、非己写操作 403（is_admin 二分）。
- 字段：对象类型(工厂/贸易商/同行) + 意向服务(代运营/AI运营/运营服务) + 联系人微信。

**业务背景**：B2B 服务业，卖亚马逊代运营/AI运营/运营服务给工厂/贸易商/同行。小团队、一锤子买卖、无多部门。

## 1. 规划原则（贴合你的工作流）

1. **销售每日驱动优先**：销售天天用的（待跟进、分配）排最前，管理报表排后。
2. **公海是资产**：你强调公海二次跟进有价值——围绕公海做「防占着不跟」的运营。
3. **小团队够用即可**：不上企业级重功能（部门权限、审批流），is_admin 二分暂够。
4. **复用已有基建**：Celery beat（数字员工已用）、现有 CrmTable/Drawer/FollowTimeline 组件。

## 2. 候选功能（价值/成本评估）

| # | 功能 | 价值 | 成本 | 说明 |
|---|---|---|---|---|
| F1 | **待跟进视图 + 提醒** | 🔴高 | 中 | 「今天该跟谁」：今日/逾期待跟进列表（基于 next_follow_at），销售每日打开即用。CRM 对销售最直接的价值。 |
| F2 | **负责人选择器接通** | 🟠中高 | 低 | 现在表单/抽屉 `users={[]}` 空的，团队无法分配/转移。接通 listUsers 即可，容易。 |
| F3 | **联系人多联系人 UI** | 🟠中 | 中 | B2B 一公司多联系人（采购/老板/技术）。后端已 ready，前端无 UI。客户详情加联系人 tab。 |
| F4 | **公海自动回收** | 🟠中 | 中 | N 天未跟进自动掉公海，防销售占着不跟。用 Celery beat 定时。你重视公海。 |
| F5 | **CSV 导出** | 🟡中 | 低 | 销售主管导出线索/客户清单做分析/备份。容易实用。 |
| F6 | **CRM 数据看板** | 🟡中 | 中 | 漏斗转化、跟进活跃度、销售业绩。给主管看。 |
| F7 | **操作审计日志** | 🟢低 | 中 | 谁转移/转化/改了什么。小团队优先级低。 |
| F8 | **http 高级筛选** | 🟢低 | 中 | crm-advance-filter 组件在 http 模式不工作（后端仅 keyword）。 |
| F9 | **权限按角色/部门细化** | 🟢低 | 高 | 小团队 is_admin 二分够用，暂不需要。 |
| F10 | **E2E 测试(Playwright)** | 🟢低(工程) | 中 | 覆盖核心流程保稳定，非用户可见。 |

## 3. 推荐分期

### P2 · 销售日常提效（推荐首阶段，ROI 最高）
- **P2a 负责人选择器接通**（F2）：listUsers → 新建/编辑表单的负责人下拉 + 详情抽屉 + 批量转移对话框。解锁团队协作。
- **P2b 待跟进视图 + 提醒**（F1，核心）：
  - 后端：`GET /crm/follows/upcoming?window=today|overdue|week` 返回 next_follow_at 落在区间内的实体（线索+客户），或新增「待跟进」聚合端点。
  - 前端：CRM 首页/独立「待跟进」页，列出今日/逾期待跟进，点击直达详情记跟进；可选浏览器/站内提醒。
- **P2c 联系人多联系人 UI**（F3）：客户详情 Drawer 加「联系人」tab，增删改 + 设主联系人（后端 contact 端点已全）。

### P3 · 公海运营 + 导出
- **P3a 公海自动回收**（F4）：Celery beat 每日扫描 last_follow_at 超 N 天且有主的客户/线索 → owner=null 掉公海（N 可配置，记回收日志）。
- **P3b CSV 导出**（F5）：客户/线索列表按当前筛选导出 CSV（后端流式或前端生成）。
- **P3c CRM 数据看板**（F6）：线索漏斗(new→contacting→qualified→converted)、本月新增/转化、跟进活跃度、 per-sales 业绩。

### P4 · 硬化
- 操作审计日志（F7）· http 高级筛选（F8）· 权限细化（F9，按需）· E2E（F10）。

## 4. P2 设计要点（待你确认优先级后细化为实施计划）

### P2a 负责人选择器
- 前端：`useCrmUsers()` hook 调 `client.listUsers()`，注入 CrmLeadForm/CrmFormCreate/CrmOverviewDrawer/批量转移对话框（替换 `users={[]}`）。
- 缓存用户列表（React Query），避免重复请求。

### P2b 待跟进视图（核心）
- **数据模型**：next_follow_at 已在 crm_follows。待跟进 = 最近一条跟进的 next_follow_at 落在窗口内、且实体未转化/未弃置/未软删。
- **后端方案**（二选一，待评估）：
  - (a) 聚合端点 `GET /crm/follows/upcoming`：join 出每个实体最新跟进的 next_follow_at，按窗口过滤 + 排序。
  - (b) 给 customer/lead 加 `next_follow_at` 冗余列，create_follow 时回写（类似 last_follow_at），列表直接查。← 查询更简单，推荐。
- **前端**：CRM 增「待跟进」入口（sidebar 或首页 tab），分「今日」「逾期」「本周」，行内快速记跟进。
- **权限**：销售只见自己名下的待跟进；管理员见全部。

### P2c 联系人 UI
- 复用后端 contact 端点（list/create/update/delete + 主联系人唯一）。
- 客户详情 Drawer 加联系人 tab：列表（主联系人标记）+ 新增/编辑表单（含微信）+ 删除 + 设为主。
- http-crm-client 补 contact 4 方法 + CrmClient 接口补 contact 方法 + Contact 类型（含 wechat）。

## 5. 需你拍板的决策

1. **P2 三个里，哪个最急？** 我推荐顺序 P2b(待跟进) > P2a(负责人) > P2c(联系人)，因为待跟进是销售每日刚需。你的团队当下最缺哪个？
2. **待跟进提醒形式**：仅「待跟进列表页」够吗，还是要站内 toast / 浏览器通知 / 邮件提醒？
3. **公海自动回收（P3a）要不要做**？回收天数 N 默认多少（如 15/30 天）？
4. **数据看板（P3c）你需要哪些指标**？（漏斗/业绩/跟进活跃度）
5. **联系人（P2c）你们真用多联系人吗**？还是一个公司基本就一个对接人（那 P2c 可延后）。

## 6. 横切约定（沿用 P1a/P1b）

- 迁移：`YYYYMMDD_NNN`，revision 纯数字短 ID 递增（当前 head=218），建前 rebase main 取单链、随 feature 分支同批合 main。
- 测试：后端 pytest（.venv/bin/python）+ 前端 lint/build/test；TDD。
- 权限：新端点接入 permissions.py（resolve_scope/require_admin/require_owner_or_admin）。
- 工作流：默认 main 开发，最多 main+1 分支，绝不 rebase main，合并用 merge --no-ff。
