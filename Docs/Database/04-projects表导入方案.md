# Projects 表导入方案（Supabase）

## 目标

- 在 Supabase `public` schema 中创建项目主数据表 `projects`。
- 从 `projects.csv` 批量导入项目名。
- 导入采用增量 upsert：仅新增/更新，不删除数据库现有项目。
- `sort_order` 仅对新项目分配，已有项目保留原排序。

## 数据源

- 默认文件：`Docs/ModelFiles/projects.csv`
- 必填表头：`项目名称`
- 当前示例数据：16 条项目名（单列）

## 表结构（public.projects）

```sql
create table if not exists public.projects (
  id bigint generated always as identity primary key,
  project_name text not null,
  sort_order integer not null check (sort_order >= 0),
  source_file text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_project_name_key unique (project_name)
);

create index if not exists idx_projects_sort_order on public.projects (sort_order);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
before update on public.projects
for each row execute function public.set_updated_at();
```

## 环境变量

后端脚本使用 `backend/.env` 中的 `DATABASE_URL` 连接数据库。

```bash
DATABASE_URL=postgresql+psycopg://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
```

说明：

- 本方案目标库是 Supabase Postgres，不适用于 SQLite。
- `DATABASE_URL` 未配置或不可连接时，脚本会失败并返回非 0 退出码。

## 执行步骤

推荐：一步完成初始化 + 导入（后端执行）

```bash
cd backend
python scripts/init_and_import_projects.py
```

如需指定自定义文件：

```bash
cd backend
python scripts/init_and_import_projects.py --file=/absolute/path/to/projects.csv
```

兼容分步执行：

1. 创建表（幂等，可重复执行）

```bash
cd backend
python scripts/create_projects_table.py
```

2. 导入默认 `projects.csv`

```bash
cd backend
python scripts/import_projects.py
```

3. 导入自定义文件

```bash
cd backend
python scripts/import_projects.py --file=/absolute/path/to/projects.csv
```

## 导入规则

- 编码：CSV 必须是 UTF-8（支持 UTF-8 BOM）。
- 表头校验：必须包含 `项目名称`。
- 文本规范：项目名会先 `trim` 后再入库。
- 跳过规则：
  - 空项目名行跳过；
  - 文件内重复项目名，仅首次保留，后续重复行跳过。
- 写入策略（增量 upsert）：
  - 若 `project_name` 已存在：更新 `source_file`，保留原 `sort_order`；
  - 若 `project_name` 不存在：插入新记录，`sort_order = 当前最大 + 1`。

## 导入结果统计

脚本输出：

- `inserted`：新增数量
- `updated`：更新数量（命中已有 `project_name`）
- `skipped`：跳过数量（空值 + 文件内重复）
- `total`：CSV 数据行总数（不含表头）

## 验证 SQL

```sql
-- 查看总数
select count(*) from public.projects;

-- 查看排序结果
select id, project_name, sort_order, source_file, updated_at
from public.projects
order by sort_order asc, id asc;

-- 查看是否有重复项目名
select project_name, count(*)
from public.projects
group by project_name
having count(*) > 1;
```

## 回滚方案

```sql
drop trigger if exists set_projects_updated_at on public.projects;
drop index if exists public.idx_projects_sort_order;
drop table if exists public.projects;
```

注意：回滚会删除项目数据，执行前请确认已备份。
