# Agent 凭据生命周期设计（BLF-468 · 重新激活 / 删除 / 术语重命名）

> **状态**：设计讨论稿（待用户确认）
> **范围**：`dashboard/system/agent-management` 凭据管理 Tab + `agent_api_keys` 生命周期
> **关联**：`docs/agent-api-design.md`（Agent API 设计稿 §11 术语）、`docs/superpowers/specs/2026-08-06-agent-management-hub-design.md`（BLF-448 Hub 页）
> **配套**：交互式设计稿 mockup `docs/superpowers/specs/2026-08-07-agent-key-lifecycle/mockup.html`

---

## 1. 现状盘点（代码事实）

| 层 | 现状 | 文件 |
|---|---|---|
| 模型 | `agent_api_keys`：`is_revoked`（布尔软标志）+ `expires_at`（可空，前端创建时恒为 null）+ `deleted_at`（**不存在**） | `backend/app/models/agent_api_key.py` |
| 端点 | `POST .../internal/api-keys`（创建）、`GET .../internal/api-keys`（列表）、`POST .../internal/api-keys/{id}/revoke`（软吊销，幂等） | `backend/app/api/v1/endpoints/internal/api_keys.py` |
| 服务 | `revoke_api_key` 仅置 `is_revoked=True`；无激活、无删除 | `backend/app/services/agent/key_service.py` |
| 鉴权 | `resolve_key` / `resolve_key_for_agent`：revoked / expired / not_found / agent_mismatch 四类判定 | 同上 |
| 前端 | 凭据表只有「吊销」按钮（仅未吊销时显示）；已吊销行**无任何操作**；状态徽章只有「已吊销 / 可用」 | `frontend/app/dashboard/system/agent-management/agent-management-client.tsx` |

**关键事实**：
1. 「吊销」在实现层面是**可逆的软标志**（数据行保留，鉴权时拒绝），并非物理删除。
2. 页面创建 Dialog 硬编码 `expires_at: null` → 当前不存在过期 Key，「已过期」状态是理论态（后端已支持，前端未展示）。
3. `agent_id` 是绑定在 Key 行上的业务标识（1 Agent : N Key，用于轮换），不是独立实体表。

---

## 2. 三个设计点评估

### 2.1 点 1：已吊销 Key 能否重新激活？→ **合理，且建议支持**

- **业界一致做法**：Stripe / OpenAI / Anthropic 的 API Key 均支持「deactivate 后可 re-enable」。吊销（revoke）在主流实现里是**可恢复的停用**，不是终点。
- **本项目实现层面零成本**：`is_revoked` 软标志反置即可恢复，仅缺一个端点和 UI 入口。
- **安全区分（设计红线）**：
  - 误吊销 / 临时停用（维护窗口、临时降权）→ 重新激活是正确的；
  - **疑似泄露** → 最佳实践是**轮换**（新建 Key 并删除旧 Key），而非重新激活旧 Key。UI 在激活确认文案中引导一句「若因泄露停用，建议新建凭据并删除旧 Key」。

**结论**：支持「激活」，但语义上把「吊销」改为「停用」（可逆），并用引导文案区分「临时停用」与「泄露轮换」两种场景。

### 2.2 点 2：需要删除按钮？→ **合理，且必须**

- 烟雾测试 Key / 已废弃 ID 长期堆积（当前页无任何清理手段），列表噪音大且存在误用风险（旧 Key 仍可认证）。
- **业界一致做法**：Stripe / OpenAI / GitHub 均支持删除 API Key。
- **实现决策**：
  - **软删除**（`deleted_at` tombstone），不物理删行——审计日志 `operation_audit_logs.target_id` 引用 Key 行 id，硬删会切断审计轨迹；
  - **鉴权加固（安全关键）**：`resolve_key` / `resolve_key_for_agent` 必须把 `deleted_at IS NOT NULL` 视为 `not_found`（已删除 Key **永不认证**，即使 `is_revoked` 被误置回）；
  - 默认列表**隐藏**已删除行（去噪音），提供「含已删除」开关供审计/回溯；
  - 删除确认用**键入 Key 前缀**的强确认（防手滑，不可逆操作标配）。

**结论**：新增「删除」（不可逆，软删除 + 鉴权屏蔽 + 审计保留）。

### 2.3 点 3：术语「吊销」是否合理？→ **用户直觉正确，应改名**

- 「吊销」在中文业务语境暗示**永久、不可恢复**（当前确认文案甚至写「吊销后…且不可恢复」），但实现是**可逆软标志**——术语与行为不一致，会误导操作者（以为不可恢复而不敢操作，或以为已物理删除）。
- 建议术语映射：

| 现状 | 建议 | 可逆性 |
|---|---|---|
| 吊销（revoke） | **停用（Deactivate）** | 可逆（可激活） |
| （无） | **激活（Activate）** | 反向停用 |
| （无） | **删除（Delete）** | 不可逆（软删 tombstone） |

> 后端 `POST .../revoke` 保留为兼容别名（过渡期），前端切到 `/deactivate`；一期结束后可下线 `/revoke`。

---

## 3. 状态模型（4 态，前端派生）

```
状态 = f(is_revoked, expires_at, deleted_at)
```

| 状态 | 判定 | 视觉 | 可执行操作 | 说明 |
|---|---|---|---|---|
| **激活** Active | `deleted_at IS NULL` 且 `is_revoked=false` 且未过期 | 绿 `激活` | 停用 / 删除 | 正常可用 |
| **停用** Inactive | `deleted_at IS NULL` 且 `is_revoked=true` | 灰 `停用` | 激活 / 删除 | 可恢复；对应现「已吊销」 |
| **已过期** Expired | `expires_at` 已过 | 琥珀 `已过期` | 删除 | 当前前端无过期 Key（创建恒 null），状态预留展示 |
| **已删除** Deleted | `deleted_at` 非空 | 灰 `已删除`（默认隐藏） | 无 | 不可恢复；审计保留 |

- 后端**无需**引入 `status` 枚举列：`is_revoked` + 新增 `deleted_at` 即可派生全部状态，迁移最小。
- 「激活已过期 Key」= 延长有效期，列入二期（当前创建流程不产生过期 Key，YAGNI）。

---

## 4. 前端流程重组（凭据管理 Tab）

### 4.1 布局

```
凭据列表
├─ 筛选行: [状态筛选 ▾ 全部/激活/停用/已过期] [业务域筛选 ▾ 既有] [☐ 含已删除]   [创建凭据]
└─ 表格: 名称 | Key 前缀 | Agent ID | 项目范围 | 业务域范围 | 最近使用 | 状态 | 操作
```

### 4.2 行操作（按状态上下文）

| 状态 | 操作列 |
|---|---|
| 激活 | `停用`（中性） · `删除`（红） |
| 停用 | `激活`（绿） · `删除`（红） |
| 已过期 | `删除`（红） |
| 已删除 | —（只读，仅「含已删除」可见） |

沿用现有行内文字按钮（保持与既有页面一致），不超过 2 个动作，不引入下拉菜单。

### 4.3 确认流（useConfirm 扩展）

| 动作 | 确认文案 | variant | 额外 |
|---|---|---|---|
| 停用 | 「停用凭据『label』？停用后立即失效，可随时重新激活。」 | default | — |
| 激活 | 「激活凭据『label』？恢复访问权限。⚠ 若因泄露停用，建议新建凭据轮换。」 | default | 泄露引导 |
| 删除 | 「删除凭据『label』？删除后不可恢复，使用该凭据的 Agent 将永久无法访问（审计日志保留）。」 | destructive | **键入 Key 前缀确认**（新增 `ConfirmOptions.input` 支持） |

- `useConfirm` 需扩展支持可选「键入确认」：`{ inputLabel, expectedInput, onInputChange }`——小改动，向后兼容。
- 操作后 toast + 刷新列表，与现状一致。

### 4.4 状态徽章

| 状态 | Badge 类 |
|---|---|
| 激活 | emerald（`bg-emerald-500/10 text-emerald-700`，对齐 Hub 页「已接入」风格） |
| 停用 | secondary（现有「已吊销」样式） |
| 已过期 | amber（`bg-amber-500/10 text-amber-700`） |
| 已删除 | muted + `line-through` |

---

## 5. 后端契约（交后端同事）

### 5.1 数据库迁移

```sql
ALTER TABLE agent_api_keys ADD COLUMN deleted_at TIMESTAMPTZ NULL;
-- 小表，无需新索引；查询走现有 idx_aak_revoked_expires 即可
```

### 5.2 端点

| 方法/路径 | 行为 | 幂等 |
|---|---|---|
| `POST /api/v1/internal/api-keys/{id}/deactivate` | `is_revoked=true`（已删除 → 404） | 是 |
| `POST /api/v1/internal/api-keys/{id}/activate` | `is_revoked=false`（已删除 → 404） | 是 |
| `DELETE /api/v1/internal/api-keys/{id}` | `deleted_at=now`（已删除 → 204 幂等） | 是 |
| `GET /api/v1/internal/api-keys?include_deleted=false` | 默认排除 `deleted_at IS NOT NULL`；`true` 返回全部 | — |

- `POST .../revoke` 保留为 `/deactivate` 别名（过渡期兼容），一期后可下线。
- 审计动作：`api_key.deactivate` / `api_key.activate` / `api_key.delete`（沿用 `append_operation_audit_log`）。
- Schema：`ApiKeyItem` 增 `deleted_at: datetime | None`；状态由前端派生，后端不返回派生状态。

### 5.3 鉴权加固（安全关键，必须与端点同时上线）

`resolve_key` 与 `resolve_key_for_agent` 的判定顺序改为：

```
not_found → deleted_at IS NOT NULL → revoked → expired → agent_mismatch
```

即已删除 Key 落入 `not_found`（无认证机会），且**先于** revoked 判定——防止删除后被误激活的 Key 复活认证。

---

## 6. 前端实现清单（后端落地后执行）

| 文件 | 改动 |
|---|---|
| `frontend/lib/api/agent-key-admin.ts` | `AgentApiKeyItem` + `deleted_at`；新增 `deactivateAgentApiKey` / `activateAgentApiKey` / `deleteAgentApiKey`；`revokeAgentApiKey` 改指 `/deactivate`（或改名） |
| `frontend/app/dashboard/system/agent-management/agent-management-client.tsx` | `getKeyStatus()` 派生 4 态；状态徽章 4 色；状态筛选 + 含已删除开关；按状态行操作 + 三确认流（删除带键入确认） |
| `frontend/hooks/use-confirm.tsx` | 扩展 `inputLabel` / `expectedInput`（键入确认，向后兼容） |
| `frontend/app/dashboard/system/agent-management/agent-management-client.test.tsx` | 状态派生单测 + 行操作渲染 + 删除键入确认交互测试 |

验证顺序（对齐 BLF-448）：`cd backend && pytest` → `pnpm lint` → `pnpm build` → `pnpm test`。

---

## 7. 分期建议

- **一期（本设计落地）**：停用/激活 + 删除（键入确认）+ 4 态徽章 + 状态筛选 + 含已删除开关。后端 5.2/5.3 与前端同步上。
- **二期（可选）**：批量删除（烟雾测试清理场景）、创建 Dialog 增过期时间字段 + 过期 Key「延长有效期」、已删除归档视图（按删除时间排序）。

## 8. 不在本期范围（YAGNI）

- 物理删除 Key（审计完整性优先）；`status` 枚举列（派生足够）；读写分离 `scope` 校验（Hub 设计 §9 已排除）；删除恢复/回收站（用户明确定义「删除就是删除」）。
