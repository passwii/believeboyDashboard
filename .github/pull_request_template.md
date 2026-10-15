## 关联 Issue

Closes BLF-XXX

## 变更与影响面

<!-- 改了什么、影响哪些模块。涉及公共函数 / hook / route / service / schema 时，写明 CodeGraph `callers` / `impact` 的影响面结论；fallback 到 Read/Grep 请说明原因。不涉及公共符号时可只写变更说明。 -->

## 风险等级与自检

- [ ] `[risk:normal]`
- [ ] `[risk:high]`（DB 迁移 / 权限认证 / 支付资金 / 外部 API 契约变更 / 删除性操作 / 跨模块大重构）
- [ ] commit author = `jr.way123@gmail.com`（BEL-153，否则 Vercel 拒部署）
- [ ] diff 无 `TODO` / `FIXME` / `console.log` / `debugger` 残留

## 验证（按 AGENTS.md §测试规则 T0–T3 分档，只写实际跑过的）

<!-- 逐条写命令 + 真实数字（errors / warnings / passed / failed）。没实际跑过的命令禁止打 ✓。
示例：
- T1：`cd frontend && vitest run app/.../foo.test.tsx` ✓ (12 passed / 0 failed)
- `pnpm lint` ✓ (0 errors / 0 warnings)
- `pnpm build`：交 Vercel preview（本地未跑）
- T3：`cd backend && pytest` ✓ (0 failed)
- 含迁移：`cd backend && python scripts/check_alembic.py` ✓
-->

## 未执行项及原因

<!-- 例如：pnpm build 交 Vercel preview；无登录 / 权限改动故未跑 Playwright；纯 docs 改动 T0 不跑测试 -->

## 迁移 / 部署说明

<!-- 涉及迁移时给 check_alembic.py 结果与部署注意事项；无则填「无」 -->
