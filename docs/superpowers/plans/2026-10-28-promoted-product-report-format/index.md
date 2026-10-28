# 已推广商品报表新版兼容实施计划（索引）

> **状态：** ✅ 已完成
> **分支：** `fix-promoted-product-report-format`
> **日期：** 2026-10-28
> **PR：** [#786](https://github.com/passwii/believeboyDashboard/pull/786)
> **设计：** [已推广商品广告报表新版格式适配设计](../../../../specs/2026-10-28-promoted-product-report-format-design.md)

---

## 入口表

| 文档 | 说明 |
|---|---|
| [2026-10-28-promoted-product-report-format.md](./2026-10-28-promoted-product-report-format.md) | 实施任务、字段映射和验证记录 |
| [设计 spec](../../../../specs/2026-10-28-promoted-product-report-format-design.md) | 需求、兼容范围与验收标准 |

## Phase 进度表

| Phase | 范围 | 状态 |
|---|---|---|
| 1 | 新版签名、日期范围和通用校验 | ✅ 完成 |
| 2 | 新旧字段映射、国家码与百分比值 | ✅ 完成 |
| 3 | 目标测试、样例文件和 PR 审阅 | ✅ 完成 |

## Git tag 清单

- 无

## 外部关联

- PR #786：新版已推广商品广告报告兼容
- 后端部署：PR 合并 main 后由 deploy-vps.yml 自动触发

## 数据快照

- Commit：1 个功能提交
- 测试：广告上传及相关校验 102 passed
- 实际新版工作簿：16 行，US，CTR 0.6829% 映射为 0.006829
- 实际旧版工作簿：德国映射为国家代码 DE
- Alembic：单 head 检查通过
