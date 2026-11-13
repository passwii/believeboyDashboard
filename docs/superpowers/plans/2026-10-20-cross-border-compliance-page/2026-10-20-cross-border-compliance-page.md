# 跨境电商合规操作台 — 实施计划

> 生成日期：2026-10-20　作者：代码质量工程师 Tia（模式 A / PLAN）
> 配套设计：`docs/superpowers/specs/2026-10-17-cross-border-compliance-design.md`（已随本计划落库，见 BLF-1380）
> 原始 issue：BLF-1380　角色：前端工程师 Seth（唯一实现方）　把关人：代码质量工程师 Tia
> 本文件只做任务分解与验收口径，**不含代码**。
> 用户已拍板（2026-10-20，BLF-1380）：设计稿 + 本计划先落库（方案 B），再按下面三个 stage issue 分步推进（方案 A）。S1 的前置条件只有一个——本计划与设计稿已合进 `main`。

---

## 0. 需求确认（一句话）

把用户提供的 16 张出口合规课件整理成 Dashboard「工具箱」下的一个**纯前端静态参考页** `/dashboard/tools/cross-border-compliance`，含五步业务证据链、五种监管模式对照、企业准入办理、9810 首单材料本地勾选自查与报关字段速查，不新增 API / 数据库 / 迁移 / 权限。

---

## 1. 当前基线（已核实，不要重复调查）

| 项 | 状态 |
| --- | --- |
| `frontend/app/dashboard/tools/` | 只有 `brand-registration-example/`、`markdown-to-word/`、`page-render/`、`product-label/` + `loading.tsx`，**无 compliance** |
| `frontend/lib/sidebar-config.ts` | 「工具箱」组 4 项（第 392-395 行），无合规入口 |
| `frontend/lib/dashboard-route-meta.ts` | 4 条 `/tools/*` 标题映射，无合规条目 |
| 后端 | **零改动**（`backend/` 不碰，不产生迁移，`deploy-vps.yml` 不触发） |
| 可复用组件 | `frontend/components/terminal/term-panel.tsx`（`TermPanel`）、`term-controls.tsx`（`TERM_BUTTON` / `TERM_INPUT`）、`frontend/components/ui/checkbox.tsx`、`@/lib/utils` 的 `cn` |
| 参考页面 | `product-label/`（client + page.tsx 拆分 + `TermPanel` + Checkbox 用法）、`brand-registration-example/`（静态内容页 + 同目录单测） |
| 侧栏图标 | `IconMap` 已含 `ClipboardCheck` / `CheckSquare`，无需新 import lucide 图标 |

**约定**：页面文件全名小写连字符目录；`page.tsx` 只导出 `metadata` + 渲染 client；client 组件 `'use client'`；单测与被测文件同目录 `*.test.tsx`（Vitest + jsdom + `@testing-library/react`）。

---

## 2. 任务分解（= 3 个 stage issue，串行）

子任务粒度均为「单个开发者 1 个 PR 内可完成」。stage issue 的 description 由本计划的对应章节直接摘录，验收标准逐条可观测。

### S1 — 内容与页面：`cross-border-compliance` 页面主体

- **角色**：frontend（Seth）
- **依赖**：无（本 PR 内不接侧栏入口，用 URL 直达自测）
- **产出文件**：
  - `frontend/app/dashboard/tools/cross-border-compliance/page.tsx`（`metadata.title = '跨境电商合规'`，描述注明课件整理来源）
  - `frontend/app/dashboard/tools/cross-border-compliance/cross-border-compliance-client.tsx`（`'use client'`，页面组装 + 自查区状态）
  - `frontend/app/dashboard/tools/cross-border-compliance/compliance-data.ts`（**静态内容单一来源**：链路节点 / 模式 / 办理事项 / 首单材料分组 / 报关字段，全部为导出的常量数组，页面只 map 不内联硬编码）
  - `frontend/app/dashboard/tools/cross-border-compliance/cross-border-compliance.test.tsx`
- **必须覆盖的 5 个区块**（顺序即设计稿顺序）：
  1. 标题区 + 来源提示（「根据用户提供的课件整理」+「以主管海关、税务机关现行要求为准；不构成法律、税务或报关意见」）
  2. 五步出口业务证据链：采购 → 销售 → 报关 → 物流 → 收汇，每步列对应单证；桌面横向、窄屏纵向或横向可滚动，**不得造成页面整体横向溢出**
  3. 监管模式对照：0110 / 9610 / 9710 / 9810 / 1039，标注「课件场景参考」，**不做推荐、不做适用性判断、不给「哪个更优」**
  4. 企业准入办理：经营范围 → 海关备案 → 电子口岸 → DXPID → 外币账户 → 出口退（免）税备案，措辞不宣称所有企业须按固定顺序
  5. 9810 退税准备 + 首单核查清单（分组：企业与场地 / 采购 / 销售与收汇 / 出口履约 / 其他核查材料）+ 报关字段速查（境内发货人…币制）
- **自查交互（仅第 5 区首单材料）**：原生可访问 checkbox（复用 `@/components/ui/checkbox`）、已核对数/总数 + 完成比例即时更新、「重置」按钮恢复空状态、**状态只在组件本地 `useState`**：不 `localStorage`、不 `fetch`、不上传。
- **视觉**：沿用 V3 Terminal 令牌（`border-term-border` / `bg-term-panel` / `text-term-muted`）、零圆角、`TermPanel` 分区；明暗主题都要正确；动效仅轻量进入，尊重 `prefers-reduced-motion`；无轮播 / 弹窗 / 上传。
- **内容红线（最重要）**：只转录课件中**可辨认**的内容。任何无法准确转录的条目**省略**，并在 PR 正文的「交付缺漏清单」里逐条列出（设计稿 §5 与风险段明确要求）。禁止用外部搜索、推断或常识补写法规条件 / 税额 / 报关值 / 填报对错判断。
- **验收标准**（可观测）：
  - A1 `cd frontend && pnpm vitest run app/dashboard/tools/cross-border-compliance` 全绿
  - A2 单测断言：5 区块关键文案可见；模式 5 条齐全；材料按 5 分组渲染；勾选后进度文本变化；「重置」恢复 0/N；无 `fetch` 调用（`vi.stubGlobal('fetch', fetchMock)` 后 `expect(fetchMock).not.toHaveBeenCalled()`）
  - A3 `pnpm check:mocks` 通过（若 mock `useSession` / `useNotifications`，必须用 `frontend/test-utils/stable-mocks.ts` 的 `stableSession()` / `stableNotifications()`，禁止内联字面量）
  - A4 `pnpm lint` 通过；dev server 打开该 URL 目视明暗主题 + 375px 宽无横向溢出
- **测试档位**：**T2**（叶子页面，未触碰公共符号）。跨模块风险：无。

### S2 — 入口与元数据：侧栏 + 路由标题（公共配置，谨慎）

- **角色**：frontend（Seth）
- **依赖**：S1 已合并（入口指向真实路由，避免 404 中间态）
- **产出文件**：
  - `frontend/lib/sidebar-config.ts` —「工具箱」组第 5 项：`{ title: '跨境电商合规', url: '/dashboard/tools/cross-border-compliance', icon: IconMap.ClipboardCheck }`
  - `frontend/lib/dashboard-route-meta.ts` — `DASHBOARD_PAGE_TITLES` 新增 `{ match: '/tools/cross-border-compliance', title: '跨境电商合规' }`
  - `frontend/lib/sidebar-config.test.ts` — 按现有「品牌备案示例归入工具箱且 URL 唯一」样式新增用例
  - `frontend/lib/dashboard-route-meta.test.ts` — 新增标题断言用例
- **⚠️ 已知坑（务必逐条处理）**：
  1. `getDashboardPageTitle` 用 `pathname.includes(match)` + `find`（**数组顺序敏感**）。新增条目必须放在**不会被子路由抢先匹配**的位置——现有同前缀条目只有 `/tools/*` 四条且无父子关系，追加到 `/tools/product-label` 之后即可安全。新增用例断言 `getDashboardPageTitle('/dashboard/tools/cross-border-compliance') === '跨境电商合规'`。
  2. `sidebar-config.test.ts` 有「顶级分组 9 个且顺序固定」与「全分组 URL 无重复」两条**全局守卫**。本 PR 只在 `tools` 组内追加一项，**不得**改动组顺序或 `id`；`pnpm vitest run lib/sidebar-config.test.ts` 必须先单独确认这两条不挂。
  3. `sidebar-config.ts` 是**全局共享配置**（侧栏 + 头部 + 子导航都消费）→ 按 AGENTS.md 判档条件①「改动跨模块复用的公共符号」**升 T3**。
- **验收标准**：
  - B1 从「工具箱」能点进新页，顶部标题显示「跨境电商合规」而非默认 `Dashboard`
  - B2 `pnpm vitest run lib/sidebar-config.test.ts lib/dashboard-route-meta.test.ts` 全绿
  - B3 T3 全量验证通过（见 §4）
  - B4 未引入任何 backend / schema / 迁移改动（`git diff --name-only origin/main...HEAD` 全部落在 `frontend/`）

### S3 — 收口：端到端目视验证 + 失败集对账 + 文档同步

- **角色**：frontend（Seth）执行、Tia 复核
- **依赖**：S2 已合并
- **产出**：新增一个 Playwright spec（登录 → 侧栏入口 → 页面 → 勾选/重置 → 窄屏）+ 验证记录；只在需要时补回归修复。
- **验收标准**：
  - C1 **自动 E2E 为必需项**（AGENTS.md §E2E 不按 T 档一刀切：涉及登录 / 权限隔离 / NextAuth / 前后端代理时必须跑 Playwright，手动截图不能替代）。新增 `frontend/tests/dashboard/cross-border-compliance.spec.ts`，覆盖：登录后从「工具箱」进入 `/dashboard/tools/cross-border-compliance` → 页面标题与来源提示可见 → 勾选若干首单材料后进度文本变化 → 「重置」回 0/N → 375px 视角无整体横向溢出。按 `TESTING.md` / `backend/scripts/agent_testing/README.md` 准备测试数据库与前后端服务后跑 `cd frontend && pnpm test:ui -- tests/dashboard/cross-border-compliance.spec.ts`；目视与截图作为**补充留痕**（明暗主题切换、页内锚点跳转可目视）
  - C2 前端全量**不无条件重跑**（AGENTS.md §失败集对账）：S3 折进 S2 PR 时直接沿用 S2 已经跑过的那一次全量结果；只有 S3 自身产生新的代码改动，或 S2 全量存在需要确认的失败时，才跑目标集 / 定向重跑失败用例。按当次实测记录 `Test Files / Tests` 数字；若有失败，与 `origin/main` 同命令对账一次，确认是既有失败还是本次引入（**不得 `skip` / `xfail` 掩盖**）
  - C3 `pnpm check:mocks` + `pnpm lint` 通过
  - C4 设计稿「验收标准」7 条逐条对照 PR 正文打勾；交付缺漏清单（S1 的省略条目）显式列给用户
  - C5 Vercel preview / production 部署成功

> S3 若发现只需「补 E2E + 列缺漏」而无业务代码改动，可与 S2 同 PR 交付（S2 PR 包含该 spec 即满足）——由 Seth 判断，**不要为了凑 stage 造空 PR**。届时把 S3 的结论写进 S2 的 PR 描述与 issue 评论即可。但 C1 那条 Playwright spec **不能省**（它是自动门禁，不是手动项）。

---

## 3. 接口契约

**本阶段无新增接口契约**（无 API、无 DB、无迁移、无权限、无新依赖）。需要守住的隐式契约如下：

| 契约 | 定义 |
| --- | --- |
| 路由 | `/dashboard/tools/cross-border-compliance`（一级子路由，无动态段、无 query 必填项） |
| 侧栏条目 | `SidebarTopGroup(items[])`，`id: 'tools'`，`url` 唯一（受 `flattenAllItems()` URL 去重守卫约束） |
| 标题解析 | `getDashboardPageTitle(pathname: string): string` — 输入 `/dashboard/tools/cross-border-compliance` 必须返回「跨境电商合规」 |
| 自查状态 | 组件本地 `useState`，不落任何持久化 / 网络通道；刷新后不承诺保留 |

---

## 4. 测试档位与验证清单（依据 `AGENTS.md` §测试规则）

| stage | 档位 | 前端命令 | 后端 |
| --- | --- | --- | --- |
| S1 | **T2** | `pnpm vitest run app/dashboard/tools/cross-border-compliance` + `pnpm check:mocks` + `pnpm lint` | 不跑 |
| S2 | **T3**（改公共侧栏配置） | `pnpm check:mocks` → `pnpm test` 全量 + `pnpm lint` | 不跑 |
| S3 | 收尾 | 新增/跑 `pnpm test:ui` 目标 spec（必需）+ 失败集对账；折进 S2 PR 时**不重跑全量**（沿用 S2 那一次结果）。目视流程作补充 | 不跑 |

- 全量耗时参考：本仓库 2026-10-05/06 实测 235 文件 / 1660 例 / **~43s（空闲）～ ~2min（同机满载）**。判「卡住」不看绝对秒数，看是否在推进（AGENTS.md：60s 无 `Test Files` 汇总 + 单 worker 长时间 100% CPU = 无限渲染循环，`--testTimeout` 救不了）。
- **不做**：`pnpm build`（交 Vercel）、后端全量（零后端改动）、`pytest -n auto`（共享 `BLF_test` 会互相死锁）。
- 合并门禁：FRONTEND_TOUCHED=1 → **Vercel 部署检查必须成功**，由 Tia 在 review 阶段确认。
- **全量只跑一次**：T3 的全量作为 S2 PR 的验证证据；S3 收口不做第二次全量，只对账失败集，除非 S3 自己改了代码。

---

## 5. 交接与合并流程（每个 stage 都一样）

1. Seth 从最新 `origin/main` 开 `agent/seth/blf-<子issue>-*` 分支（**不要**在陈旧的 `add-cross-border-ecommerce-compliance-page` 上堆代码，它相对 main 是 `1 ahead / 17 behind`）。
2. commit 中文 Conventional Commits，正文带 `Closes BLF-<子issue编号>`；author 必须 `DamonRock <jr.way123@gmail.com>`（否则 Vercel 拒部署）。
3. 按档位跑验证 → `git push` → `gh pr create`（标题含 `BLF-<子issue>` 以便平台关联 PR）。
4. 在子 issue 评论写全 **PR URL + 编号 + head SHA + 关联 issue + 风险等级 + 真实测试数字**，并 mention [@代码质量工程师 Tia] 交棒。
5. Tia 按下方§5.1 把关流程 review → 通过后 `gh pr merge --squash --delete-branch`。**合并动作只属于 Tia，Seth 不自行 merge。**
6. S1 合并后 Tia 再 promote S2；S2 合并后视情况决定是否还要 S3。纯前端 → Vercel 自动部署，不触发 `deploy-vps.yml`。
7. 同一 PR @-back 超过 3 次 → 升级用户拍板。

### 5.1 把关流程本仓定义（就地定义，不依赖尚未合入的文档）

> 注：本仓库 PR 把关以机器门禁 + 把关人语义复核为准，详见 `AGENTS.md` §关键约定与 `docs/REFERENCE.md` §代码检查（Lint）。

每个 stage PR 依次跑五步：

1. **变更面识别**：`gh pr view <N> --json headRefOid,files,latestReviews,statusCheckRollup` 记录**当前 HEAD SHA**，得出 FRONTEND_TOUCHED / BACKEND_TOUCHED / HAS_MIGRATION 三个 bool（本计划三个 stage 预期均为 `true / false / false`）。
2. **作者证据核对**：读 PR 正文里的测试声明与 `statusCheckRollup`，确认验证命令、结果与变更面一致；声明缺失或与门禁结论矛盾时，要求作者补齐证据后再继续。
3. **机器门禁与抽验**：FRONTEND_TOUCHED=1 → **Vercel 部署检查必须成功**（失败或无法确认成功 → 不合并，@ 用户拍板）；BACKEND-only → 跳过并在报告点名。默认信任作者 PR 正文的真实测试数字；抽验条件：CI 覆盖不到的边界（窄屏 / Lighthouse / 本计划 §5.1 的 E2E）、声明与门禁结论矛盾、高风险 PR、审查反馈修复后需定向重跑的目标集。命中 **T3** 的 S2 按 `AGENTS.md` §测试规则验证，不因 PR 正文声明全绿而跳过。
4. **语义 review**：对照本计划 + 设计稿验收标准 7 条：需求覆盖 / 契约一致（路由与标题映射）/ 边界与错误处理 / 安全（本页无写操作，重点反而在**口径安全**：不得出现法律/税务结论性措辞，不得有「交付缺漏清单」缺失的省略条目静默补写）/ 无遗留调试（TODO、`console.log`、`debugger`）/ commit author 为 `DamonRock <jr.way123@gmail.com>`。
5. **决策与合并后**：APPROVE → `gh pr merge --squash --delete-branch`；REQUEST_CHANGES → @-back；BLOCK（高风险，例：缺漏清单为空但内容明显补写、或出现税额计算）→ @ 用户拍板不合并。合并后：FRONTEND_TOUCHED=1 → 确认 Vercel production 部署成功；三个 stage 均无 `backend/` 改动 → `deploy-vps.yml` 不触发，在报告里点名说明。

---

## 6. 风险标注（需人工确认 / 超出中端模型能力的部分）

| # | 风险 | 处置 |
| --- | --- | --- |
| R1 | **课件转录完整性**——16 张照片的 OCR 精度直接决定页面质量，中端模型容易「补全」看不清的条件（尤其 9810 资质条件与首单材料措辞）。这是**内容风险，不是代码风险** | S1 PR 必须在正文列「交付缺漏清单」（省略了哪些条目 + 为什么）。review 时逐条对照设计稿 §5；若缺漏过多，Tia 不合并，交用户补充原始材料或另行授权检索 |
| R2 | **法规口径**——课件可能过期，页面被当成法律依据 | 来源标签 + 限制性提示为硬性验收项（A1 区块 1、3）；禁止出现「适用 / 更优 / 一定能退」类结论。用户目视确认文案后由用户承担口径责任 |
| R3 | **侧栏全局守卫挂掉**（§2 S2 坑 2） | S2 单测阶段先只跑 `lib/sidebar-config.test.ts`；若「9 个分组顺序」被误改，属破坏性回归，立即回退 |
| R4 | **标题匹配顺序**（§2 S2 坑 1） | 用新增用例锁住具体 pathname，不只断言「包含」 |
| R5 | **无限渲染循环**：进度百分比若在 render 里 `setState`、或 `useEffect` 依赖数组不稳定，会挂住全量测试 | S1 自查统计一律用 `useMemo` 派生，禁止在渲染期写状态；全量测试卡住时按 AGENTS.md 二分规则定位 |
| R6 | **设计稿遗漏**：原 spec 只点名 `sidebar-config.ts`，漏了 `dashboard-route-meta.ts`（顶部标题会退化成默认 `Dashboard`） | 已在 S2 显式补齐，属于本计划对设计稿的**唯一扩张**，不改变功能范围 |
| R7 | 旧分支 `add-cross-border-ecommerce-compliance-page` 上那条 spec 提交 | 已由 BLF-1380 的 spec 落库 PR 以 `git cherry-pick -x fbc11b2e` 保留溯源；那条本地分支可保留不动或删除，不影响实施 |

---

## 7. 不做清单（避免范围蔓延）

外部法规 / EGO 搜索、模式推荐问答、退税金额计算、材料上传 / 导出 / 打印、官方政策自动更新、后端 API / 数据库 / 迁移 / 权限、新的外部 npm 依赖、课件照片原图直接铺在页面上、独立设计系统或新增视觉语言。
