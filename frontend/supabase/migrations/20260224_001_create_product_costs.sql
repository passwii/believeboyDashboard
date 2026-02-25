create table if not exists public.product_costs (
  id bigint generated always as identity primary key,
  project_name text not null,
  sku text not null,
  asin text not null,
  first_leg_unit_cost numeric(12,2) not null default 0 check (first_leg_unit_cost >= 0),
  fob_unit_cost numeric(12,2) not null default 0 check (fob_unit_cost >= 0),
  currency text not null default 'USD',
  source_file text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_costs_project_sku_asin_key unique (project_name, sku, asin)
);

create index if not exists idx_product_costs_project_name on public.product_costs (project_name);
create index if not exists idx_product_costs_sku on public.product_costs (sku);
create index if not exists idx_product_costs_asin on public.product_costs (asin);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_product_costs_updated_at on public.product_costs;
create trigger set_product_costs_updated_at
before update on public.product_costs
for each row execute function public.set_updated_at();

alter table public.product_costs enable row level security;

drop policy if exists product_costs_select_authenticated on public.product_costs;
create policy product_costs_select_authenticated
on public.product_costs
for select
to authenticated
using (true);

drop policy if exists product_costs_all_service_role on public.product_costs;
create policy product_costs_all_service_role
on public.product_costs
for all
to service_role
using (true)
with check (true);
