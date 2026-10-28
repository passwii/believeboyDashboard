-- name: CountNotifications :one
select count(*)
from public.notifications
where user_id = $1::integer
  and ($2::text is null or type = $2)
  and ($3::boolean is null or "read" = $3);

-- name: ListNotifications :many
select
  id, user_id, type, title, message, data, "read", read_at, created_at
from public.notifications
where user_id = $1::integer
  and ($2::text is null or type = $2)
  and ($3::boolean is null or "read" = $3)
order by created_at desc
offset $4
limit $5;

-- name: CountUnreadNotifications :one
select count(*)
from public.notifications
where user_id = $1::integer
  and "read" = false;
