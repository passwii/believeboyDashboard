-- name: GetProfileByUserID :one
select
  id::text as id,
  email,
  name,
  full_name,
  is_admin,
  is_active,
  role_type,
  avatar_url,
  password_changed_at,
  created_at,
  updated_at
from public.user_accounts
where id::text = $1
limit 1;
