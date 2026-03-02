alter table if exists public.product_costs
  add column if not exists is_active boolean not null default true;

create index if not exists idx_product_costs_is_active
  on public.product_costs (is_active);
