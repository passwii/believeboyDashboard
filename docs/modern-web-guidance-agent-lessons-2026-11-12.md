# 从 Modern Web Guidance 学 Agent 工程：前端打磨的可借鉴清单

> 评估日期：2026-11-12
> 评估对象：`GoogleChrome/modern-web-guidance` v1.0.0（release commit `4dd9683`，209 篇 guide）
> 评估口径：**把它当作一个「Agent 知识产品」拆解**，不是逐篇评估 Web 指南的技术正确性
> 前置事实：安装方式、`legacy-scan` 结果与 14 条命中已在 [`modern-web-guidance-evaluation-2026-11-11.md`](./modern-web-guidance-evaluation-2026-11-11.md)（PR #840，已合入 `main`）
> 代码引用基于 `origin/main`（2026-11-12，PR #850 打开时）；行号若随 `main` 漂移，以符号名与章节为准

## 0. 一句话结论

Modern Web Guidance 真正值得借鉴的不是 209 篇指南，而是它解决了 Agent 工作的两个老问题：

1. **什么时候该查、查什么**（routing）——90 行常驻路由，把「触发条件」和「不要触发」写得比知识本身还清楚；
2. **查完有没有真的用上**（verification + eval）——要求逐条引用原文自证，并用 guided / unguided 的 uplift 证明指南改变了模型输出。

我们现在的 Agent 开发恰好是反面：**知识很全、流程很细、机械检查也有，但缺路由层和效果度量**。1127 行设计文档没有「任务 → 该读哪几段」的索引；规则大多停在「人读得懂」，机器查不到；没有任何机制验证 Agent 是否照做。

三条最高 ROI 的动作（按投入产出排序）：

| 优先级 | 动作 | 成本 | 收益 |
| --- | --- | --- | --- |
| P0 | 给 design-spec 加「Agent 路由表 + 规则 ID」，PR 模板加「设计依据（引用原文）」 | 0.5–1 天，T0 | 让 Agent 查得准、审得动 |
| P1 | 把 `check:motion` 的模式扩展成 `check:design`：diff 范围、两层（gate / report-only） | 2–3 天，T1/T2 | 把 V4 红线从口号变成可回归 |
| P2 | 5–10 个真实任务的 guided / unguided 小评测 | 1–2 周 | 第一次有「Agent 是否真的变好」的证据 |

## 1. 它到底是什么（事实层）

| 事实 | 数据 | 对我们的含义 |
| --- | --- | --- |
| 仓库形态 | 公开仓库只有 1 个 `Release v1.0.0` 机器人提交；源码在另一个 repo；npm CLI 自包含、零依赖 | 它把「知识内容」和「运行时」分离，发布物是策展后的制品 |
| 常驻上下文 | `SKILL.md` 90 行 | 常驻的是路由，不是知识 |
| 语料 | 209 篇 guide、17 个类目；119 篇明确写 `MANDATORY`，130 篇带 Baseline 数据，157 篇带 fallback 说明 | 强制语气集中在少数高风险模式，不是全篇口号 |
| 确定性规则 | 33 个 guide 带 legacy 规则，约 16% 语料 | 静态扫描只是入口，不是覆盖全部 |
| 检索 | 离线 embedding + BM25；`search` 只返回 `{id, description}` | 先判断相关性，再取全文，节省上下文 |
| 评测 | 每个 agent / model 有 guided vs unguided 通过率；项目方公布 Nov 8 Codex 54% → 82%（+28pp） | 用数据决定哪条指南值得留 |

> 评测数据由项目方发布，我们未独立复现其评测集；这里把它当作「方法论存在且可运行」的证据，不当作中立第三方结论。

## 2. 七个可借鉴的设计决策

### 2.1 常驻路由，不常驻知识

**它怎么做**

- `SKILL.md` 的 frontmatter description 就是一张触发表：`MANDATORY: Execute FIRST...`，随后列出 20+ 个触发主题；同时明确 `DO NOT trigger for: backend, infra/scripts, tooling/trivial`。
- 查询纪律写得很细：2–5 个词、动作 + UI 原语、不要框架名 / 业务名、复合任务拆开查、搜不到先改写一次再放弃。
- 全文 90 行，没有把任何一篇指南的内容抄进来。

**为什么有效**

- Agent 的常驻上下文是稀缺资源；把 token 花在「何时查」比花在「知识本身」的边际收益高。
- 负向边界（DO NOT）和正向触发同样重要：没有它，Agent 会对每个 CSS 改动都去查一遍，噪声和延迟都会上来。

**我们的对照**

- 仓库侧 `AGENTS.md` 131 行（不含 Multica 运行时注入的约 180 行），其中 33 行是 pi-lens LSP 误报的处置说明——每个 Agent 每轮都读，但只在碰 TypeScript 诊断时有用。
- 前端设计知识总量：`frontend/docs/design-spec.md` 162 行 + `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md` 214 行 + `docs/design-drafts/2026-11-01-operations-dashboard/design.md` 409 行 + `frontend/docs/motion-system.md` 342 行 = **1127 行**，没有任何「任务类型 → 必读 / 可跳过」的路由（后文为可读性使用短名指代）。
- 结果：Agent 要么不读（凭印象写 UI），要么全读（上下文被吃掉），两种都不稳定。

**可借鉴动作**

- 在 `frontend/docs/design-spec.md` 增加一节「Agent 路由表」：`任务类型 | 必读 | 可选 | 不要读`。
  - 例：改一个 V4 表格 → `design-spec §2` + `foundations §Table`；不要读 `design.md` 全文、不要读 V3 `table-spec.md`。
  - 例：只改后端 → 不读任何设计文档（对应 T0）。
- 在 `AGENTS.md` 的关键约定里，把「先读 design-spec §0.4 与 foundations」改成「按路由表读对应章节」，并给出 3–5 个最常见的入口。

### 2.2 渐进披露：稳定 ID、先摘要后全文、交叉引用

**它怎么做**

- `search` 只返回 `{id, description}`，Agent 先判断再 `retrieve`；`retrieve` 支持逗号分隔多个 ID。
- guide 内部引用另一篇时，直接给可执行命令：`retrieve "declarative-dialog-popover-control"`，不是让人猜文件名。
- 输出超过 9.5 KB 自动落盘并提示用文件读取工具读全文，避免截断。

**为什么有效**

- 稳定 ID 让「检索 → 引用 → 复核」形成闭环；文件路径会漂移，ID 不会。
- 交叉引用把「相关知识」变成可按需展开的图，而不是每次全量加载。

**我们的对照**

- design-spec 的红线是编号列表（§2 第 1–8 条），但没有稳定 ID；引用只能写「§2 第 1 条」，改动编号就会失效。
- 文档之间的引用是文件路径 + 章节号；跨文件引用（foundations → design.md → freeze.md）需要人工跳转。
- 大文档没有「摘要层」：`design.md` 409 行，Agent 无法先看 10 行摘要再决定读哪段。

**可借鉴动作**

- 给 §2 的 8 条红线分配稳定 ID：`V4-RULE-01` … `V4-RULE-08`，后续只增不改号。
- 每条红线补一行 `适用范围 / 反例 / 验收方式`，让它同时是「规则」和「可引用证据」。
- 文档头部加「本文速查」：5–8 条一句话结论 + 指向章节，供 Agent 先扫。

### 2.3 引用原文的自证步骤（反幻觉）

**它怎么做**

- Step 4 要求：凡是用到的 guide，必须逐条写 1–2 句，第一人称，≤75 词，说明「非显而易见的实现选择 / 降级 / 避免的坑」，并附**该条规则或 gotcha 的原文引用**。
- 明确禁止：context compaction 后凭记忆猜 ID 或引文；只 credit 本轮真正落地的改动。
- 查了但没用上，也要写一句「查了哪些、为什么没用」。

**为什么有效**

- 「我参考了指南」这种说法无法审计；一句原文引用把「是否真的读过、是否真的照做」变成可核对的事实。
- 对多 Agent 协作尤其重要：接手方只看评论 / PR，不看你上一轮的推理。

**我们的对照**

- `design-spec §0.4.4` 已有很好的**事前**七问（用户任务、页面基准、唯一主角、布局、token、状态、动效），但没有**事后**引用要求。
- 现有 PR 模板只有 CodeGraph 确认、变更说明与验证三块，没有「设计依据」。
- 结果：review 时只能看代码像不像，无法快速判断「这条圆角 / 颜色 / 留白是规范要求还是随手写的」。

**可借鉴动作**

- 在 `.github/pull_request_template.md` 的「变更说明」下加一个小节：

  ```text
  ## 设计依据（仅 UI 改动）
  - 规则：`V4-RULE-03`（原文：「不得为了单页效果改 components/ui/* …」）
  - 落点：`xxx.module.css:42`，只覆盖本页 `.warm-...` 作用域
  - 未采用：`field-sizing`（Safari 基线未达，保留 JS 高度 fallback）
  ```

- 这是 T0 文档改动，但会让后续每个 UI PR 自带证据链。

### 2.4 静态规则 + 人审判据，不做 CI 阻断

**它怎么做**

- `legacy-scan` 的每条 finding 都带 `verifierRubric.keepWhen / dropWhen`，Agent 必须逐条判断，而不是「扫到就改」。
- 报告明确说：扫描只覆盖约 16% 语料；误报要 drop；「不要为了 0 findings 去改安全代码或改扫描器」。
- 上篇实测 14 条中 3 条明确误报——这正是为什么它不建议接 CI 阻断。

**为什么有效**

- 静态规则的价值是「把候选集缩小」，不是「替人做决定」。把判断依据写进规则，Agent 才有稳定的裁决口径。
- 硬门禁只适合「低误报 + 可机械判定」的规则；否则团队会学会绕过或加白名单。

**我们的对照**

- 我们已经有两个成熟的硬门禁：`check-unstable-mocks`（591 行 + 自测）和 `check-motion-tokens`（714 行 + 自测），都遵循「判据机械化 + 正反例自测 + 不给白名单」的屋风。这是很好的基础。
- 但 **V4 设计红线没有对应的检查层**：`--term-*`、硬编码色、移动端 media query、随机圆角，全靠 review 记忆。
- 同时，现有代码已经存在「合法例外」：`frontend/components/dashboard-v2/warm-ledger/shell/theme.css` 里有 21 处 Terminal 工具类桥接（`[class~='border-term-*']` / `bg-term-*` / `text-term-*`），用于把 Terminal 控件拉回 Warm token——naive 的全仓 gate 会直接误报。
- V4 相关样式里还有 24 处 `max-width` media query（分布在 8 个 `*-warm.module.css`；其中页面级 `frontend/app/dashboard/**` 为 23 处 / 7 个文件，`frontend/components/dashboard/portfolio/portfolio-filters-warm.module.css` 另有 1 处），与「desktop-only、不新增手机适配」的规则并存；没有 provenance 标记，无法区分存量例外与新违规。

**可借鉴动作：两层检查**

| 层 | 判据 | 范围 | 输出 |
| --- | --- | --- | --- |
| Gate（exit 1） | 新增行出现 `--term-*` / `text-term-*` / `bg-term-*`，且文件属于枚举的 `V4_SCOPE`：`frontend/app/dashboard/**/*-warm.module.css` + `frontend/components/dashboard-v2/warm-ledger/**` | 只扫 diff 新增行 | 阻断，附 file:line + 修法 |
| Gate（exit 1） | 新增 V4 CSS Module 出现硬编码 hex / rgb（图表或第三方样式需显式注释豁免） | 只扫 diff 新增行 | 阻断 |
| Report-only | 紫色 / 彩虹渐变、glow、装饰性卡片、随机 radius、无来源数字 | diff 或全仓 | 计数 + 清单，不阻断 |

关键三点（都是从 MWG 学的）：

1. **diff 范围**，不扫全仓——否则存量 24 处 `max-width` media query 和 21 处 Terminal 桥接会立刻把门禁打红。
2. **先 report-only 建立基线**，再逐条升级为 gate；每条规则必须有正反例自测。
3. **不要用白名单绕过**（与 `check:mocks` 的既有约定一致）；例外写进规则的 `keepWhen`，不是脚本里的 path 列表。

当前 `origin/main` 上仍有 **44 个前端文件**在使用 `--term-*`（V3 存量合法）。因此 `check:design` 不能扫 `frontend/**` 全量，必须先把 `V4_SCOPE` 的路径前缀写成可枚举常量，并用自测钉住；否则上线第一天就会把 V3 页面全部打红。`V4_SCOPE` 以上述两类路径为起点，P1 定稿时还要把不带 `-warm` 后缀、但仍属 V4 的页面级 `page.tsx` / client 组件逐个补入，不能退化成 `frontend/**`。

### 2.5 用 uplift 评测，而不是凭感觉加规则

**它怎么做**

- 闭环：专家指南 → 真实任务 + golden solution + Playwright grader → 校准（golden 必须 100% 过，未改动基线必须 100% 失败）→ guided / unguided 跑 Agent → 比较通过率。
- 指标：opportunity = 100% − unguided；uplift = guided − unguided。
- 用 uplift 修剪内容：模型本来就会的删掉，模型常错的补强。

**为什么有效**

- 它把「写文档」变成了「做产品」：每条指南都要证明自己改变了输出。
- 校准环节防住了「grader 太松，guided 和 unguided 都满分」的假阳性。

**我们的对照**

- 仓库里没有 Agent 效果评测的记录或脚本（`rg 'agent eval|guided.*unguided|uplift'` 无命中）；前端单测很多，但它们测的是代码，不是「Agent 是否按规范写代码」。单测规模在仓库内已有两套口径（`AGENTS.md` 写 235 文件 / 1660 例，`test-ci.yml` 注释写 276 文件 / 2136 例），引用前以当前 `pnpm test` 实测为准。
- 结果：我们无法回答「加了这段 AGENTS.md / 设计规范后，Agent 的首轮质量有没有提升」。

**可借鉴动作（轻量版，不建 Playwright grader）**

- 选 5 个真实前端任务（2 个 V4 页面改动、1 个表格、1 个对话框、1 个表单），× 2 组（有 / 无设计路由 + 引用要求）。
- 人工评分 4 项：红线违反数、首轮可验收、返工轮次、交棒引用完整度。
- 记录 baseline 后再改规则；否则永远不知道收益来自哪。
- 规模扩大后再考虑 Playwright 断言（例如「新页面不得出现 `--term-*`」「对话框必须有可见关闭按钮」）。

### 2.6 一份语料、多种 harness；项目级策略显式 opt-in

**它怎么做**

- 同一份 `skills/` 内容，配 7 种宿主清单：`.codex-plugin`、`.claude-plugin`、`.cursor-plugin`、`.grok-plugin`、`gemini-extension.json`、`kimi.plugin.json`、`.agents/plugins/marketplace.json`。
- `.mwgrc` 是项目级策略文件：默认不放开 Origin Trial / volatile 特性，必须显式 `set-allow-*` 才检索得到。
- skill 里建议把浏览器支持策略写进 `AGENTS.md`（例如「不要 polyfill，允许 ≤20 行自定义降级」）。

**为什么有效**

- 内容只维护一份，宿主差异只在清单层；避免「每个工具一份提示词」的漂移。
- 高风险能力默认关闭，显式 opt-in——这比在文档里写「谨慎使用」可靠。

**我们的对照**

- 我们的 Agent 资产是分散的：`AGENTS.md` + `CLAUDE.md` 薄壳 + `.claude/skills/`（20 个）+ `.agent_context/skills` + `skills-lock.json`（8 个 GSAP skill）+ 全局 `~/.agents/skills`。来源多、版本无统一锁。
- 没有浏览器 / 运行时支持策略：V4 只写「desktop-only」，但没写目标浏览器；这会让 `field-sizing`、anchor positioning 这类决策每次靠临场判断。
- 没有「实验性能力默认关闭」的机制；V3 legacy 靠人记。

**可借鉴动作**

- 在 `AGENTS.md` 或 `frontend/docs/design-spec.md` 增加一行 **Browser Support Policy**：目标浏览器 + 是否允许 polyfill + 新特性降级上限（例如「只允许 ≤20 行、无新依赖的 fallback」）。
- 给「实验性 / 单引擎特性」加默认关闭规则：需要显式在 issue 或 design-spec 里批准，才能进 V4 页面。
- 不照搬 npx 分发；我们只需要把「哪份文件是权威」写清楚，并给 skills 来源加锁（已有 `skills-lock.json` 可扩展）。

### 2.7 把失败面写进指南本体

**它怎么做**

- 每篇 guide 都带 Browser Support / fallback / gotchas：例如 `KeyboardEvent.isComposing` 在 Safari 的 `compositionend` 乱序 bug，给出 `keyCode === 229` 和 `timeStamp` 两种降级。
- 区分「纯增强」（老浏览器忽略即可）和「关键行为」（必须写低开销 fallback）。
- 明确「Limited availability」「unsupported in Safari」这类事实，不让 Agent 自己猜。

**为什么有效**

- Agent 最容易漏的不是 happy path，而是兼容性和边界；把失败面写进同一篇文档，检索一次就能拿到。

**我们的对照**

- design-spec 有「刻意例外清单」，但没有「平台支持 / 降级」维度；V4 的现代 CSS 用法（`field-sizing`、`interpolate-size`、anchor positioning）没有统一记录。
- 上篇报告已经指出：Anchor Positioning 的支持数据曾经写错，说明这类事实必须可复核、可更新。

**可借鉴动作**

- 给 V4 的每个「现代 CSS / JS 能力」建一条 5 行小卡：`能力 | Baseline / 支持 | 我们的降级 | 批准日期`。
- 放在 `frontend/docs/design-spec.md` 附录或独立 `platform-support.md`，并在路由表里指向它。

## 3. 我们已有的资产（别丢）

- **单一权威源**：`AGENTS.md` 明确「权威指令源」，`CLAUDE.md` 降为薄壳；这已经比多数仓库干净。
- **CodeGraph 工作流**：定位代码先 `query` 再 `Read`，改公共符号前看 `callers / impact`；这是「先查再改」的雏形。
- **T0–T3 测试分档 + 失败集对账**：比 MWG 的 eval 更贴近工程现实，不能为了评测把测试体系推翻。
- **两个机械检查 + 自测**：`check-unstable-mocks` / `check-motion-tokens` 已经证明「文档规则 → 机器门禁」在本仓库可行。
- **V4 设计权威 + 例外清单**：版本边界、桌面范围、反 AI Slop 都写得很清楚；缺的是可检索、可引用、可回归。

结论：**不是重建一套 Agent 体系，而是在现有体系上加两层——路由层（查得准）和证据层（审得动）。**

## 4. 不该照搬的

| 不照搬 | 原因 |
| --- | --- |
| 全量 eval harness（golden + Playwright grader） | 构建成本高；我们连 10 个稳定任务集都还没有。先用人工小样本，别一上来就造基础设施。 |
| `legacy-scan` 接 CI 阻断 | 16% 覆盖 + 实测误报；会把团队训练成「绕过扫描」。只做周期体检或 diff 提示。 |
| npx / 多宿主插件分发 | 我们是单仓内部团队，直接文件 + 单一权威源更稳；多清单只会增加漂移面。 |
| 把 MWG 当设计权威 | 它管的是 Web 平台机制（IME、dialog、sticky、a11y），不懂 Warm Ledger 的视觉身份。它是「平台行为的第二意见」，不是 V4 规范。 |
| 公开仓库式的 release-artifact 流程 | 我们的文档和代码同仓演进，强行分离会让 review 和回滚变复杂。 |

## 5. 落地路线（给 `frontend/` 的具体动作）

### P0：路由 + 证据（0.5–1 天，T0）

1. `frontend/docs/design-spec.md`
   - 新增「Agent 路由表」：任务类型 → 必读章节 → 可跳过。
   - §2 八条红线加稳定 ID（`V4-RULE-01` … `V4-RULE-08`），每条补 `适用范围 / 反例 / 验收`。
   - 文首加「5 条速查」。
2. `.github/pull_request_template.md`
   - 新增「设计依据（仅 UI 改动）」：规则 ID + 原文引用 + 落点 + 未采用项。
3. `AGENTS.md`
   - 把「先读 design-spec §0.4 与 foundations」改为「按路由表读对应章节」。
   - 加一行 Browser Support Policy（需用户确认目标浏览器）。
   - **拆成独立 PR**：平台每次启动会向 workdir 的 `AGENTS.md` 追加约 184 行运行时块（含 `<!-- BEGIN MULTICA-RUNTIME ... -->`）；只提交正文改动，绝不把注入块带入仓库。

**验收**：文档 diff 可读；新增 PR 模板不改变运行行为（T0，不跑测试）；用 2 个真实任务试填，确认路由表能在 30 秒内指向正确章节。

### P1：把红线变成可回归（2–3 天，T1/T2）

1. 新增 `frontend/scripts/check-design.mjs` + `check-design.test.mjs`，接入 `pnpm test` 入口（先 report-only）。
2. 规则集（先 4 条）：
   - `V4-RULE-01`：diff 新增行出现 `--term-*` / `text-term-*` / `bg-term-*`。扫描范围限定为 `V4_SCOPE`（`frontend/app/dashboard/**/*-warm.module.css` + `frontend/components/dashboard-v2/warm-ledger/**`）；`frontend/components/dashboard-v2/warm-ledger/shell/theme.css` 仅豁免 `.warm-ledger__route-slot-row` / `.warm-ledger__mobile-strip` / `.warm-ledger__date-picker-content` 三个作用域内的既有桥接，不放宽整文件。
   - `V4-RULE-02`：新增 V4 CSS Module 出现硬编码 hex / rgb（图表文件需注释豁免）。
   - `V4-RULE-08`：新增 V4 页面 CSS 出现 `max-width` media query（先 report-only，存量 24 处 / 8 文件作为基线，其中页面级 23 处 / 7 文件）。
   - `V4-RULE-07`：新增随机 radius 字面量（非 token），report-only。
3. 每条规则带正例 / 反例自测；不设 path 白名单，例外写进 `keepWhen`。
4. 试点 MWG：在本机装 Codex 插件（前篇已验证路径），在 `AGENTS.md` 加「UI 改动前查 MWG」的路由；只在 V4 UI 任务触发，不接 CI。

**验收**：

- `pnpm check:design` 在当前分支 exit 0（report-only 模式允许有基线计数）；
- 构造 fixture 触发 4 条规则，自测全绿；
- `pnpm test` 与 `pnpm lint` 通过（T1/T2）；
- 用 `chat-input` 试点验证「查指南 → 改代码 → 引用原文」全链路。

### P2：小评测（1–2 周）

- 5 个任务 × 2 组；人工评分 4 项；记录 baseline。
- 决定 MWG 是「团队插件」还是「vendored skill」；决定 `check:design` 哪几条升级为 gate。
- 只有评测证明有效，才扩到更多任务和 Playwright 断言。

## 6. 试点证据链：`chat-input` 的 IME-safe Enter

这是「MWG 能带来真实 uplift」的最短证明，也是 P1 的验收样本。

**我们的代码**（`frontend/components/chat/chat-input.tsx:95-99`）：

```tsx
const handleKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmit()
  }
}
```

**问题**：中文 / 日文 / 韩文输入法在候选词确认时也发 `Enter`，此时 `isComposing === true`；当前代码会直接把半成品消息发出去。

**MWG 的规则**（`ime-safe-enter-submit`）：

- 必须先 `preventDefault`，再检查 `event.isComposing`；
- Safari 有 `compositionend` 早于确认 `Enter` 的 WebKit bug（165004），标准检查会失效；需要 `event.keyCode === 229` 兜底。该检查必须保持嵌套在 `e.key === 'Enter'` 条件内——指南明确说明，脱离 Enter 判断会让移动端软键盘的普通 229 输入被误判为提交；
- 单行 `<input>` 同样适用；`Cmd / Ctrl + Enter` 不需要检查。

**扫描面**：`legacy-scan` 在 `frontend` 命中 10 条 IME 规则；全仓 `key === 'Enter'` 处理共 16 处，`isComposing` 出现 0 次——这不是单文件 bug，是一类模式缺失。

**修法（React 适配）**：

```tsx
const native = e.nativeEvent
if (e.key === 'Enter' && !e.shiftKey) {
  e.preventDefault()
  if (native.isComposing || native.keyCode === 229) return
  handleSubmit()
}
```

**测试（T1/T2）**：`vitest run components/chat/chat-input.test.tsx`（新建或补 case）

- `isComposing: true` → `onSend` 不被调用；
- `isComposing: false` → 正常发送一次；
- `keyCode: 229` → 不发送（Safari 降级）；
- `Shift+Enter` → 不发送、保留换行。
- 人工验收：真实中文输入法在 Chrome 与 Safari 各确认一次候选词提交（真实 IME 的事件时序与合成事件不同，WebKit 165004 的乱序单测覆盖不到）。

再加 `pnpm lint`。

**为什么这是好试点**：改动局部（`chat-input` 目前只被 `ai-chat-window.tsx` 引用）、有明确规范来源、有可机械验证的行为、能直接对比 guided / unguided。

## 7. 需要你拍板的三件事

1. **目标浏览器基线**：只保证 Chrome / Edge 最新？还是 Safari 也要？这决定 `field-sizing`、anchor positioning 和 IME 降级策略。
2. **P0 是否现在做**：路由表 + 规则 ID + PR 模板是纯文档改动，我可以下一个 issue 直接提 PR；不需要等评测。
3. **评测范围**：先做 5 个任务的轻量人工评测，还是直接上 10 个 + Playwright 断言？

我的建议：先做 P0（半天到一天，立即降低后续每次 UI 改动的沟通成本），同时用 `chat-input` 做第一个试点；P1 的 `check:design` 等 P0 的规则 ID 稳定后再写，避免返工。
