-- +goose Up
-- +goose StatementBegin
-- BLF-1556: scheduled_report_subscriptions.user_id was declared INTEGER in
-- Alembic 123, but every authenticated identity is a user_accounts UUID
-- (X-User-Id carries user_accounts.id). Values could never round-trip: the
-- handler dropped the UUID, the column stored NULL, and the list endpoint
-- filtered on a non-existent int so admins saw an empty page.
--
-- Expand/backfill/contract-safe shape: the legacy integer column stays (the
-- previous binary still writes it on rollback), and user_account_id becomes
-- the authoritative UUID reference.

ALTER TABLE public.scheduled_report_subscriptions
    ADD COLUMN IF NOT EXISTS user_account_id uuid;

-- Backfill only where the owner is unambiguous. Existing rows have no
-- user_account_id and either a NULL or unusable legacy user_id, so the
-- project operator is the evidence of record: every subscription in the
-- production snapshot maps to projects whose project_operator starts with
-- 纪亚伟 (project 19 is 纪亚伟、桑喜刚 — the primary operator is listed first).
--
-- A subscription may reference several projects; require every referenced
-- project to resolve to the same active account before assigning it, so a
-- mixed-ownership row stays NULL and is reported instead of guessed.
WITH subscription_projects AS (
    SELECT
        subscription.id AS subscription_id,
        project.project_operator
    FROM public.scheduled_report_subscriptions AS subscription
    CROSS JOIN LATERAL regexp_split_to_table(subscription.project_ids, ',') AS raw_id
    JOIN public.projects AS project
      ON project.id = NULLIF(btrim(raw_id), '')::bigint
    WHERE btrim(subscription.project_ids) <> '*'
),
project_primary_account AS (
    SELECT
        candidate.subscription_id,
        account.id AS user_account_id
    FROM subscription_projects AS candidate
    CROSS JOIN LATERAL (
        SELECT btrim(token.name) AS operator_name
        FROM regexp_split_to_table(
                 coalesce(candidate.project_operator, ''),
                 '[[:space:]、,，;；]+'
             ) WITH ORDINALITY AS token(name, ordinal)
        WHERE btrim(token.name) <> ''
        ORDER BY token.ordinal
        LIMIT 1
    ) AS primary_operator
    JOIN public.user_accounts AS account
      ON account.is_active
     AND account.full_name IS NOT NULL
     AND btrim(account.full_name) = primary_operator.operator_name
),
unambiguous AS (
    SELECT subscription_id, (array_agg(user_account_id))[1] AS user_account_id
    FROM project_primary_account
    GROUP BY subscription_id
    HAVING count(DISTINCT user_account_id) = 1
)
UPDATE public.scheduled_report_subscriptions AS subscription
SET user_account_id = unambiguous.user_account_id
FROM unambiguous
WHERE subscription.id = unambiguous.subscription_id
  AND subscription.user_account_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_scheduled_report_subs_user_account_id
    ON public.scheduled_report_subscriptions (user_account_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'scheduled_report_subscriptions_user_account_id_fkey'
    ) THEN
        ALTER TABLE public.scheduled_report_subscriptions
            ADD CONSTRAINT scheduled_report_subscriptions_user_account_id_fkey
            FOREIGN KEY (user_account_id)
            REFERENCES public.user_accounts (id)
            ON DELETE SET NULL;
    END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE public.scheduled_report_subscriptions
    DROP CONSTRAINT IF EXISTS scheduled_report_subscriptions_user_account_id_fkey;
DROP INDEX IF EXISTS public.ix_scheduled_report_subs_user_account_id;
ALTER TABLE public.scheduled_report_subscriptions
    DROP COLUMN IF EXISTS user_account_id;
-- +goose StatementEnd
