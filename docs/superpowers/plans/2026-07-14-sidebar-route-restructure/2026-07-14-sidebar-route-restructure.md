# Dashboard 路由目录按 9 职能组重排 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `frontend/app/dashboard/*` 下的路由目录从旧的"技术归属"结构（data-reporting / data-analysis / data-management / business-dev / special / system-management / digital-employees / changelog / ai-insights / ai-chat）重排为与 sidebar 新分类一致的 9 个职能组（reports / operations / finance / advertising / supply-chain / ai / crm / tools / system），URL 随之改变，并同步所有字符串引用、import 路径与 `proxy.ts` 鉴权规则。

**架构：** App Router 中"目录 = 路由"，因此重排 = 物理移动目录（`git mv` 保留历史）+ 全局替换文件内旧路径字符串（含 `@/app/dashboard/` import 路径与 `/dashboard/` href/redirect）。`sidebar-config.ts` 的分组结构已在上一轮改完（仅 URL 仍是旧路径），本次重排会顺带把其中的 URL 也换成新路径，使分组与真实路由一致。组件目录（`@/components/dashboard/*`）不是路由，保持不变。

**技术栈：** Next.js 14 App Router、TypeScript、pnpm（lint/tsc/test）、Playwright + Vitest（验证）。

---

## 文件结构

### 将被移动的路由目录（全部在 `frontend/app/dashboard/` 下）

| 旧目录 | 新目录 |
|---|---|
| `data-reporting/` | `reports/` |
| `data-analysis/financial-data` | `reports/financial-data` |
| `data-analysis/scheduled-reports` | `reports/scheduled-reports` |
| `data-management/report-reconciliation` | `reports/report-reconciliation` |
| `data-management/auto-upload` | `reports/auto-upload` |
| `data-analysis/daily-analysis` | `operations/daily-analysis` |
| `data-analysis/return-analysis` | `operations/return-analysis` |
| `data-analysis/project-goals` | `operations/project-goals` |
| `data-analysis/research-analysis` | `operations/research-analysis` |
| `data-management/platform-inspection` | `operations/platform-inspection` |
| `data-management/platform-revenue` | `finance/platform-revenue` |
| `data-management/exchange-rate` | `finance/exchange-rate` |
| `data-management/vat-invoice` | `finance/vat-invoice` |
| `system-management/commission-management` | `finance/commission-management` |
| `data-analysis/ad-analysis` | `advertising/ad-analysis` |
| `data-analysis/ad-data` | `advertising/ad-data` |
| `data-analysis/weekly-product-analysis` | `supply-chain/weekly-product-analysis` |
| `data-analysis/portfolio-overview` | `supply-chain/portfolio-overview` |
| `data-analysis/inventory-analysis` | `supply-chain/inventory-analysis` |
| `data-analysis/inventory-replenishment` | `supply-chain/inventory-replenishment` |
| `data-analysis/seasonal-replenishment` | `supply-chain/seasonal-replenishment` |
| `data-management/sku-info` | `supply-chain/sku-info` |
| `data-management/shipment-management` | `supply-chain/shipment-management` |
| `data-management/order-info` | `supply-chain/order-info` |
| `ai-insights/` | `ai/insights/` |
| `ai-chat/` | `ai/chat/` |
| `digital-employees/` | `ai/digital-employees/` |
| `business-dev/` | `crm/business-dev/` |
| `special/` | `tools/` |
| `changelog/` | `system/changelog/` |
| `system-management/project-info` | `system/project-info` |
| `system-management/data-management` | `system/data-management` |
| `system-management/account-management` | `system/account-management` |
| `system-management/operator-management` | `system/operator-management` |
| `system-management/logs` | `system/logs` |
| `system-management/backup-management` | `system/backup-management` |

> 不变动的目录：`operations/`（仅接收新子项）、`ai/`（仅接收新子项）、`crm/`（仅接收 `business-dev/` 子目录）、`profile/`、`change-password/`、`feature-updates/`、`page.tsx`、`layout.tsx`、`loading.tsx`、`not-found.tsx`、`layout.test.tsx`。

### 将被内容替换（非移动）的文件

- `frontend/lib/sidebar-config.ts` — 各 `url` / `matchPrefixes` 改为新路径（分组结构已就位，本次只换 URL）
- `frontend/proxy.ts` — 两处 `startsWith` 鉴权规则改写（见任务 3）
- 所有引用这些路由的页面 / 组件 / 测试（`href`、`router.push`、`window.open`、`redirect`、`import type ... from '@/app/dashboard/...'`），由任务 3 的脚本统一替换
- `frontend/config/changelog.ts` 中历史文案里的旧路径字符串（脚本一并更新，保持准确）

### 不被改动

- `frontend/components/dashboard/*`、`frontend/components/ai-ad-analysis/*`、`frontend/components/dashboard/ad-analysis/*` 等组件目录（不是路由）
- `backend/`（纯前端改动，不触发 VPS 部署）

---

## 完整路径映射表（任务 3 脚本的唯一真相源）

旧路径（两种前缀 `/dashboard/` 与 `@/app/dashboard/`）→ 新路径：

```
data-reporting/                              → reports/
data-analysis/ad-analysis                    → advertising/ad-analysis
data-analysis/ad-data                        → advertising/ad-data
data-analysis/financial-data                 → reports/financial-data
data-analysis/scheduled-reports              → reports/scheduled-reports
data-analysis/daily-analysis                 → operations/daily-analysis
data-analysis/return-analysis                → operations/return-analysis
data-analysis/project-goals                  → operations/project-goals
data-analysis/research-analysis              → operations/research-analysis
data-analysis/weekly-product-analysis        → supply-chain/weekly-product-analysis
data-analysis/portfolio-overview             → supply-chain/portfolio-overview
data-analysis/inventory-analysis             → supply-chain/inventory-analysis
data-analysis/inventory-replenishment        → supply-chain/inventory-replenishment
data-analysis/seasonal-replenishment         → supply-chain/seasonal-replenishment
data-management/report-reconciliation        → reports/report-reconciliation
data-management/auto-upload                  → reports/auto-upload
data-management/platform-inspection          → operations/platform-inspection
data-management/platform-revenue             → finance/platform-revenue
data-management/exchange-rate                → finance/exchange-rate
data-management/vat-invoice                  → finance/vat-invoice
data-management/sku-info                     → supply-chain/sku-info
data-management/shipment-management          → supply-chain/shipment-management
data-management/order-info                   → supply-chain/order-info
system-management/commission-management      → finance/commission-management
system-management/project-info               → system/project-info
system-management/data-management            → system/data-management
system-management/account-management         → system/account-management
system-management/operator-management        → system/operator-management
system-management/logs                       → system/logs
system-management/backup-management          → system/backup-management
business-dev/                                → crm/business-dev/
digital-employees                            → ai/digital-employees
special/                                     → tools/
# 显式（带前缀，避免误伤其他 changelog/ai 文本）
/dashboard/system-management                 → /dashboard/system          # proxy.ts startsWith
/dashboard/changelog                         → /dashboard/system/changelog
@/app/dashboard/changelog                    → @/app/dashboard/system/changelog
/dashboard/ai-insights                       → /dashboard/ai/insights
@/app/dashboard/ai-insights                  → @/app/dashboard/ai/insights
/dashboard/ai-chat                           → /dashboard/ai/chat
@/app/dashboard/ai-chat                      → @/app/dashboard/ai/chat
```

> 设计要点：**不用**任何"整段前缀一把梭"的替换（如 `data-analysis → X`），因为 `data-analysis` 的子项要分流到 4 个不同组。每条映射都精确到具体子路径，避免错配。

---

## 任务 0：预检与环境准备

**文件：**
- 检查：`frontend/app/dashboard/` 当前目录、`git status`

- [ ] **步骤 1：确认工作树状态**

```bash
git status --short
```

预期：仅有上一轮已编辑但未提交的 `frontend/lib/sidebar-config.ts`（分组改造）。不应有其他未提交改动。若有别的改动，先 stash 或提交，避免和本次重排混在一起。

- [ ] **步骤 2：确认 9 个新顶层目录当前不存在冲突**

```bash
ls frontend/app/dashboard/ | grep -E '^(reports|operations|finance|advertising|supply-chain|tools|system)$' || echo "无冲突，可继续"
```

预期：输出 `无冲突，可继续`（这些目录尚未存在，将由 git mv 创建）。`ai`、`crm` 已存在，会接收新子目录，属预期。

---

## 任务 1：提交已完成的 sidebar 分组改造（C1）

**文件：**
- 提交：`frontend/lib/sidebar-config.ts`（分组结构已就位，URL 仍为旧路径——这是中间态，下一提交会换 URL）

- [ ] **步骤 1：提交分组改造**

```bash
git add frontend/lib/sidebar-config.ts
git commit -m "refactor(sidebar): 按业务职能重排为 9 组并移除角色墙"
```

预期：`[main xxx] refactor(sidebar): ...` 提交成功。此时旧路由目录仍在、sidebar URL 仍指向旧路径，站点可正常构建运行（中间态合法）。

---

## 任务 2：git mv 重排路由目录

**文件：**
- 移动：上表"将被移动的路由目录"全部 33 项

- [ ] **步骤 1：reports 组（来自 data-reporting + 4 个散落项）**

```bash
cd frontend/app/dashboard
git mv data-reporting reports
git mv data-analysis/financial-data reports/financial-data
git mv data-analysis/scheduled-reports reports/scheduled-reports
git mv data-management/report-reconciliation reports/report-reconciliation
git mv data-management/auto-upload reports/auto-upload
```

- [ ] **步骤 2：operations 组**

```bash
git mv data-analysis/daily-analysis operations/daily-analysis
git mv data-analysis/return-analysis operations/return-analysis
git mv data-analysis/project-goals operations/project-goals
git mv data-analysis/research-analysis operations/research-analysis
git mv data-management/platform-inspection operations/platform-inspection
```

- [ ] **步骤 3：finance 组**

```bash
git mv data-management/platform-revenue finance/platform-revenue
git mv data-management/exchange-rate finance/exchange-rate
git mv data-management/vat-invoice finance/vat-invoice
git mv system-management/commission-management finance/commission-management
```

- [ ] **步骤 4：advertising 组**

```bash
git mv data-analysis/ad-analysis advertising/ad-analysis
git mv data-analysis/ad-data advertising/ad-data
```

- [ ] **步骤 5：supply-chain 组**

```bash
git mv data-analysis/weekly-product-analysis supply-chain/weekly-product-analysis
git mv data-analysis/portfolio-overview supply-chain/portfolio-overview
git mv data-analysis/inventory-analysis supply-chain/inventory-analysis
git mv data-analysis/inventory-replenishment supply-chain/inventory-replenishment
git mv data-analysis/seasonal-replenishment supply-chain/seasonal-replenishment
git mv data-management/sku-info supply-chain/sku-info
git mv data-management/shipment-management supply-chain/shipment-management
git mv data-management/order-info supply-chain/order-info
```

- [ ] **步骤 6：ai 组（拍平 + 收编数字员工）**

```bash
git mv ai-insights ai/insights
git mv ai-chat ai/chat
git mv digital-employees ai/digital-employees
```

- [ ] **步骤 7：crm 组（收编招商）**

```bash
git mv business-dev crm/business-dev
```

- [ ] **步骤 8：tools 组**

```bash
git mv special tools
```

- [ ] **步骤 9：system 组（收编更新日志 + system-management）**

```bash
git mv changelog system/changelog
git mv system-management/project-info system/project-info
git mv system-management/data-management system/data-management
git mv system-management/account-management system/account-management
git mv system-management/operator-management system/operator-management
git mv system-management/logs system/logs
git mv system-management/backup-management system/backup-management
```

- [ ] **步骤 10：确认移动结果，旧目录应只剩空壳**

```bash
cd frontend
echo "=== data-analysis 应只剩空目录 ==="
ls app/dashboard/data-analysis 2>/dev/null || echo "已清空"
echo "=== data-management 应只剩空目录 ==="
ls app/dashboard/data-management 2>/dev/null || echo "已清空"
echo "=== system-management 应只剩空目录 ==="
ls app/dashboard/system-management 2>/dev/null || echo "已清空"
echo "=== 新目录存在性 ==="
ls -d app/dashboard/reports app/dashboard/operations app/dashboard/finance app/dashboard/advertising app/dashboard/supply-chain app/dashboard/tools app/dashboard/system
```

预期：`data-analysis` / `data-management` / `system-management` 均输出"已清空"（空目录）；新 7 个目录 `ls -d` 全部列出无报错。

> 注意：此时所有文件**内容**仍是旧路径字符串（如 `reports/monthly-report/page.tsx` 内部还写着 `/dashboard/data-reporting/monthly-report`）。这是预期的——任务 3 统一修正内容。

---

## 任务 3：全局字符串替换（路由 / import / proxy）

**文件：**
- 脚本改写：`frontend/**/*.{ts,tsx,js,jsx,mdx}`（含 `sidebar-config.ts`、`proxy.ts`、各 `page.tsx`、组件、`tests/`、配置）

- [ ] **步骤 1：写替换脚本到 /tmp（不含仓库，避免污染）**

创建 `/tmp/rename_dashboard_routes.py`，内容如下：

```python
import os

FRONTEND = 'frontend'
EXT = ('.ts', '.tsx', '.js', '.jsx', '.mdx')

# 相对（无前缀）映射，应用到两种前缀
REL = {
    'data-reporting/': 'reports/',
    'data-analysis/ad-analysis': 'advertising/ad-analysis',
    'data-analysis/ad-data': 'advertising/ad-data',
    'data-analysis/financial-data': 'reports/financial-data',
    'data-analysis/scheduled-reports': 'reports/scheduled-reports',
    'data-analysis/daily-analysis': 'operations/daily-analysis',
    'data-analysis/return-analysis': 'operations/return-analysis',
    'data-analysis/project-goals': 'operations/project-goals',
    'data-analysis/research-analysis': 'operations/research-analysis',
    'data-analysis/weekly-product-analysis': 'supply-chain/weekly-product-analysis',
    'data-analysis/portfolio-overview': 'supply-chain/portfolio-overview',
    'data-analysis/inventory-analysis': 'supply-chain/inventory-analysis',
    'data-analysis/inventory-replenishment': 'supply-chain/inventory-replenishment',
    'data-analysis/seasonal-replenishment': 'supply-chain/seasonal-replenishment',
    'data-management/report-reconciliation': 'reports/report-reconciliation',
    'data-management/auto-upload': 'reports/auto-upload',
    'data-management/platform-inspection': 'operations/platform-inspection',
    'data-management/platform-revenue': 'finance/platform-revenue',
    'data-management/exchange-rate': 'finance/exchange-rate',
    'data-management/vat-invoice': 'finance/vat-invoice',
    'data-management/sku-info': 'supply-chain/sku-info',
    'data-management/shipment-management': 'supply-chain/shipment-management',
    'data-management/order-info': 'supply-chain/order-info',
    'system-management/commission-management': 'finance/commission-management',
    'system-management/project-info': 'system/project-info',
    'system-management/data-management': 'system/data-management',
    'system-management/account-management': 'system/account-management',
    'system-management/operator-management': 'system/operator-management',
    'system-management/logs': 'system/logs',
    'system-management/backup-management': 'system/backup-management',
    'business-dev/': 'crm/business-dev/',
    'digital-employees': 'ai/digital-employees',
    'special/': 'tools/',
}

EXTRA = {
    '/dashboard/system-management': '/dashboard/system',  # proxy.ts startsWith 鉴权
    '/dashboard/changelog': '/dashboard/system/changelog',
    '@/app/dashboard/changelog': '@/app/dashboard/system/changelog',
    '/dashboard/ai-insights': '/dashboard/ai/insights',
    '@/app/dashboard/ai-insights': '@/app/dashboard/ai/insights',
    '/dashboard/ai-chat': '/dashboard/ai/chat',
    '@/app/dashboard/ai-chat': '@/app/dashboard/ai/chat',
}

pairs = []
for old, new in REL.items():
    pairs.append(('/dashboard/' + old, '/dashboard/' + new))
    pairs.append(('@/app/dashboard/' + old, '@/app/dashboard/' + new))
for old, new in EXTRA.items():
    pairs.append((old, new))

changed = []
for root, dirs, files in os.walk(FRONTEND):
    for f in files:
        if not f.endswith(EXT):
            continue
        p = os.path.join(root, f)
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                text = fh.read()
        except (UnicodeDecodeError, OSError):
            continue
        newtext = text
        for old, new in pairs:
            if old in newtext:
                newtext = newtext.replace(old, new)
        if newtext != text:
            with open(p, 'w', encoding='utf-8') as fh:
                fh.write(newtext)
            changed.append(p)

print('CHANGED FILES (%d):' % len(changed))
for c in sorted(changed):
    print('  ' + c)
```

- [ ] **步骤 2：运行脚本（在仓库根目录执行）**

```bash
python3 /tmp/rename_dashboard_routes.py
```

预期：打印 `CHANGED FILES (N):` 并列出所有被改文件，至少应包含：
- `frontend/lib/sidebar-config.ts`
- `frontend/proxy.ts`
- `frontend/app/dashboard/...` 相关 `page.tsx`
- `frontend/components/dashboard/sku-info/image-upload-sheet.tsx`、`image-tab.tsx`
- `frontend/components/dashboard/ad-analysis/config.ts`、`drill.ts`
- `frontend/app/dashboard/data-analysis/financial-data/page.tsx`（import 修正）
- `frontend/tests/...`、`frontend/lib/motion/routes.ts` 等

- [ ] **步骤 3：人工核对 proxy.ts 两处鉴权规则**

打开 `frontend/proxy.ts`，确认：
- 第 ~224 行：`pathname.startsWith('/dashboard/system-management')` → 现为 `pathname.startsWith('/dashboard/system')`
- 第 ~232 行：`pathname.startsWith('/dashboard/data-management/order-info')` → 现为 `pathname.startsWith('/dashboard/supply-chain/order-info')`

语义保持：原"限制 system-management 与 order-info"的鉴权现在对应"限制 /dashboard/system 与 /dashboard/supply-chain/order-info"。

- [ ] **步骤 4：核对 sidebar-config.ts 中 CRM 招商项的 URL**

确认 `crm` 组内：
- `招商面板` → `/dashboard/crm/business-dev/overview`
- `供应商管理` → `/dashboard/crm/business-dev/suppliers`
- `招商报表` → `/dashboard/crm/business-dev/reports`

---

## 任务 4：清理空目录 + 移除临时脚本

**文件：**
- 删除：`frontend/app/dashboard/data-analysis`、`data-management`、`system-management`（空壳）、`/tmp/rename_dashboard_routes.py`

- [ ] **步骤 1：删除已清空的旧顶层目录**

```bash
cd frontend/app/dashboard
rmdir data-analysis data-management system-management 2>/dev/null
cd ../../..
ls frontend/app/dashboard | grep -E '^(data-analysis|data-management|system-management)$' || echo "空壳已清除"
```

预期：输出 `空壳已清除`。

- [ ] **步骤 2：删除临时脚本**

```bash
rm -f /tmp/rename_dashboard_routes.py
```

---

## 任务 5：验证

**文件：**
- 检查：`frontend/` 全量

- [ ] **步骤 1：残留旧路径扫描（应为空）**

```bash
cd frontend
grep -rn -E "/dashboard/(data-reporting|data-analysis|data-management|system-management|business-dev|digital-employees|special|changelog|ai-insights|ai-chat)" --include=*.ts --include=*.tsx . \
  && echo "!!! 仍有残留" || echo "OK: 无 /dashboard/ 旧路径残留"
grep -rn -E "@/app/dashboard/(data-reporting|data-analysis|data-management|system-management|business-dev|digital-employees|special|changelog|ai-insights|ai-chat)" --include=*.ts --include=*.tsx . \
  && echo "!!! 仍有残留" || echo "OK: 无 @/app/dashboard/ 旧路径残留"
```

预期：两次均输出 `OK: 无 ... 残留`。

- [ ] **步骤 2：TypeScript 类型检查**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -i "sidebar-config\|proxy\|dashboard" | head -20
echo "--- tsc 路由相关报错应为空（其余预存测试类型错误与本任务无关）---"
```

预期：无任何包含 `sidebar-config` / `proxy` / `dashboard` 的报错（仓库本身存在无关的预存测试类型错误，不阻塞本次）。

- [ ] **步骤 3：ESLint**

```bash
pnpm exec eslint lib/sidebar-config.ts proxy.ts 2>&1 | head -30
echo "--- eslint 应无输出 ---"
```

预期：无告警。

- [ ] **步骤 4：生产构建（权威校验，确保 App Router 能解析全部新路由）**

```bash
pnpm build 2>&1 | tail -40
```

预期：构建成功，`Compiled successfully` 或 `Route (app)` 段列出全部 9 组新路由（如 `/dashboard/reports/monthly-report`、`/dashboard/supply-chain/order-info` 等），无 `Module not found` / `Failed to resolve import` 报错。

- [ ] **步骤 5：运行受影响的单元/路由测试（Vitest，无需浏览器）**

```bash
pnpm exec vitest run lib/motion/routes.test.ts components/motion/page-transition.test.tsx app/dashboard/layout.test.tsx 2>&1 | tail -30
```

预期：全部 PASS（这些测试断言 `/dashboard/ai-chat`、`/dashboard/data-analysis/ad-analysis/overview` 等路由识别；替换后断言值应与测试文件内已同步更新的字面量一致，故通过）。

- [ ] **步骤 6：本地 dev 起服务手动冒烟（可选但推荐）**

```bash
pnpm dev
```

人工访问 `/dashboard`、`/dashboard/reports/monthly-report`、`/dashboard/supply-chain/order-info`、`/dashboard/crm/business-dev/overview`、`/dashboard/ai/chat`，确认 200 且 sidebar 高亮正确。

---

## 任务 6：提交重排（C2）

**文件：**
- 提交：任务 2–4 的全部改动（目录移动 + 内容替换 + 空目录清理）

- [ ] **步骤 1：暂存并提交**

```bash
git add frontend/app/dashboard frontend/lib/sidebar-config.ts frontend/proxy.ts frontend/components frontend/config frontend/tests frontend/lib
git status --short | head -60
git commit -m "refactor(routes): 按 9 职能组重排 dashboard 路由目录并同步全部引用"
```

预期：`git status` 显示大量 `R `（renamed）与 `M `（modified）项；提交成功。提交信息遵循 Conventional Commits 中文。

- [ ] **步骤 2：确认分组与路由一致**

```bash
git show --stat HEAD | head -5
```

预期：本次提交包含目录 rename 与各引用文件修改，无遗漏。

---

## 任务 7：推送与自测建议

- [ ] **步骤 1：推送**

```bash
git push origin main
```

预期：推送成功。按 AGENTS.md 规则，本次仅改动 `frontend/`，pre-push hook 不触发 VPS 部署；前端改动由 Vercel 自动部署。

- [ ] **步骤 2：自测清单（交用户手动验证）**

- [ ] Vercel 部署完成后，逐一访问 9 组代表路由，确认可打开
- [ ] sidebar hover 面板分组与高亮正确（尤其 CRM 下的招商三项、AI 下的数字员工/insights/chat）
- [ ] 原 `system-management` 鉴权页（如 `/dashboard/system/account-management`）仍按预期受权限保护（proxy 规则已同步）
- [ ] 单页权限重构（用户独立任务）上线前，旧 admin 墙已移除，临时全员可见——留意此窗口

---

## 自检（编写后审查）

1. **规格覆盖度**：9 个职能组的全部 33 个路由目录均在"将被移动的路由目录"表中；`proxy.ts` 两处鉴权、2 个 `@/app/dashboard` 类型导入、1 个 financial-data-client import、2 处 `redirect()` 均被映射表/脚本覆盖；sidebar URL 由脚本统一换新。✅
2. **占位符扫描**：无 TODO / 待定 / "类似任务 N"。每个步骤含实际命令与预期输出。✅
3. **类型一致性**：脚本使用单一 `REL`/`EXTRA` 映射源，两种前缀由同一条规则派生，不存在任务间命名不一致。✅
4. **风险点**：`system-management` 在 EXTRA 中显式处理为 `/dashboard/system`，避免与 `system-management/<子项>` 的逐路径映射冲突；`changelog` / `ai-insights` / `ai-chat` 使用带前缀的显式映射，避免误伤 `config/changelog.ts` 文件名或注释中的 `changelog` 字样。✅
