alter table if exists public.product_costs
  add column if not exists sort_order integer not null default 1;

with ranked as (
  select
    id,
    row_number() over (
      partition by project_name
      order by id asc
    ) as rn
  from public.product_costs
)
update public.product_costs as pc
set sort_order = ranked.rn
from ranked
where pc.id = ranked.id;

create index if not exists idx_product_costs_sort_order
  on public.product_costs (sort_order);

create index if not exists idx_product_costs_project_sort
  on public.product_costs (project_name, sort_order, id);
