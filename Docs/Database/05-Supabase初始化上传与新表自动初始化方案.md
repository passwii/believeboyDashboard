# Supabase 初始化上传与新表初始化（后端手动执行）

## 1. 目标

- 所有建表/初始化/导入统一在后端执行。
- 前端不承担迁移与导入职责，仅负责读取 Supabase 数据。
- 遇到新表需求时，先执行初始化脚本，再执行导入脚本。

## 2. 执行原则（强制）

1. 在 `backend` 目录执行脚本。
2. 使用后端 `DATABASE_URL` 连接 Supabase Postgres。
3. 导入前必须先完成建表初始化（可幂等重复执行）。
4. 前端仅使用只读或受控权限访问 Supabase。

## 3. 当前落地（projects）

推荐一键命令（初始化 + 导入）：

```bash
cd backend
python scripts/init_and_import_projects.py
```

指定文件：

```bash
cd backend
python scripts/init_and_import_projects.py --file=/absolute/path/to/projects.csv
```

分步命令（兼容）：

```bash
cd backend
python scripts/create_projects_table.py
python scripts/import_projects.py --file=/absolute/path/to/projects.csv
```

## 3.1 当前落地（user_accounts）

推荐一键命令（初始化 + 创建管理员）：

```bash
cd backend
python scripts/init_user_accounts.py
```

说明：

- 默认不会重置已存在管理员的密码。
- 仅在显式传入 `--reset-password` 时才重置密码。

可覆盖管理员信息：

```bash
cd backend
python scripts/init_user_accounts.py \
  --name=yawei \
  --email=yawei@believeboy.com \
  --password='XeonJJ2024@' \
  --reset-password
```

分步命令（兼容）：

```bash
cd backend
python scripts/create_user_accounts_table.py
python scripts/seed_admin_user.py
```

若需要手动重置管理员密码：

```bash
cd backend
python scripts/seed_admin_user.py --email=yawei@believeboy.com --password='XeonJJ2024@' --reset-password
```

## 4. 新表接入模板

当需要新增表（如 `sales_daily`）时，按以下结构在后端补齐：

1. `backend/scripts/create_<table>_table.py`
2. `backend/scripts/import_<table>.py`
3. 可选一键入口：`backend/scripts/init_and_import_<table>.py`

要求：

- 建表 SQL 必须幂等（`if not exists`）。
- 需要索引、触发器、RLS 时必须在初始化阶段一起落地。
- 导入必须使用事务，失败回滚。

## 5. 连接与安全

- 后端使用 `DATABASE_URL`（Supabase Postgres）。
- 所有密钥仅存服务端环境变量，不提交到仓库。
- 前端只保留公开变量（如 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`）。

## 6. 验收清单

- [ ] 后端脚本可单独完成初始化与导入。
- [ ] 新表不存在时，可由初始化脚本自动创建。
- [ ] 导入失败能回滚并返回非 0 退出码。
- [ ] 前端不再依赖本地迁移/导入命令。
