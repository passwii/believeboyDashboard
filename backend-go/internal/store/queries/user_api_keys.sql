-- name: ResolveUserAPIKey :one
select user_id::text, revoked_at
from public.user_api_keys
where key_hash = $1
limit 1;
