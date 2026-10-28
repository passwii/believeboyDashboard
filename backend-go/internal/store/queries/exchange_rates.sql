-- name: CountExchangeRates :one
select count(*)
from public.exchange_rates
where ($1::text is null or currency = $1)
  and ($2::text is null or year_month = $2);

-- name: ListExchangeRates :many
select
  id, currency, currency_name, year_month, rate, description,
  note_images, created_at, updated_at
from public.exchange_rates
where ($1::text is null or currency = $1)
  and ($2::text is null or year_month = $2)
order by year_month desc, currency asc
offset $3
limit $4;

-- name: GetExchangeRateByCurrencyMonth :one
select
  id, currency, currency_name, year_month, rate, description,
  note_images, created_at, updated_at
from public.exchange_rates
where currency = $1 and year_month = $2
limit 1;

-- name: GetExchangeRateFallback :one
select
  id, currency, currency_name, year_month, rate, description,
  note_images, created_at, updated_at
from public.exchange_rates
where currency = $1 and year_month <= $2
order by year_month desc, id desc
limit 1;

-- name: GetLatestExchangeRate :one
select
  id, currency, currency_name, year_month, rate, description,
  note_images, created_at, updated_at
from public.exchange_rates
where currency = $1
order by year_month desc, id desc
limit 1;

-- name: ListExchangeRateOptionRows :many
select
  id, currency, currency_name, year_month, rate, description,
  note_images, created_at, updated_at
from public.exchange_rates
order by year_month desc, currency asc;

-- name: GetExchangeRate :one
select
  id, currency, currency_name, year_month, rate, description,
  note_images, created_at, updated_at
from public.exchange_rates
where id = $1
limit 1;
