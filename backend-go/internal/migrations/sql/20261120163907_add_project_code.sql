-- +goose Up
-- +goose StatementBegin
ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS project_code varchar(3);

CREATE TEMP TABLE project_code_backfill (
    project_code varchar(3) PRIMARY KEY,
    project_name text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO project_code_backfill (project_code, project_name) VALUES
    ('QUF', '铨富'),
    ('XNU', '犀牛'),
    ('YHS', '玥涵'),
    ('CKU', '创酷'),
    ('BLM', '博朗姆'),
    ('CSM', '卡斯摩'),
    ('LVW', '吕沃'),
    ('RDT', '瑞迪特'),
    ('RVJ', '睿见'),
    ('JCN', '骏成'),
    ('XMJ', '鑫敏佳'),
    ('HYF', '华洋泛航');

DO $project_code_preflight$
DECLARE
    mapping record;
    match_count bigint;
    current_code varchar(3);
    invalid_project_name text;
    invalid_project_code varchar(3);
    duplicate_project_name text;
    duplicate_name_count bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'projects'
          AND column_name = 'project_code'
          AND data_type = 'character varying'
          AND character_maximum_length = 3
    ) THEN
        RAISE EXCEPTION 'project_code migration requires public.projects.project_code varchar(3)';
    END IF;

    SELECT project.project_name, count(*)
    INTO duplicate_project_name, duplicate_name_count
    FROM public.projects AS project
    JOIN project_code_backfill AS expected
      ON expected.project_name = project.project_name
    GROUP BY project.project_name
    HAVING count(*) > 1
    ORDER BY project.project_name
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
            'project_name "%" exactly once; found % rows',
            duplicate_project_name, duplicate_name_count;
    END IF;

    FOR mapping IN
        SELECT project_code, project_name
        FROM project_code_backfill
        ORDER BY project_name
    LOOP
        SELECT count(*), max(project_code)
        INTO match_count, current_code
        FROM public.projects
        WHERE project_name = mapping.project_name;

        IF match_count <> 1 THEN
            RAISE EXCEPTION
                'project_code backfill requires project_name "%" exactly once; found % rows',
                mapping.project_name, match_count;
        END IF;
        IF current_code IS NOT NULL AND current_code <> mapping.project_code THEN
            RAISE EXCEPTION
                'project_code mismatch for project_name "%": expected %, found %',
                mapping.project_name, mapping.project_code, current_code;
        END IF;
        SELECT project_name
        INTO invalid_project_name
        FROM public.projects
        WHERE project_code = mapping.project_code
          AND project_name <> mapping.project_name
        ORDER BY project_name
        LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION
                'project_code "%" belongs to project_name "%", expected "%"',
                mapping.project_code, invalid_project_name, mapping.project_name;
        END IF;
    END LOOP;

    SELECT count(*), max(project_code)
    INTO match_count, current_code
    FROM public.projects
    WHERE project_name = '诗澜瑞';
    IF match_count <> 1 THEN
        RAISE EXCEPTION
            'project_code backfill requires project_name "诗澜瑞" exactly once; found % rows',
            match_count;
    END IF;
    IF current_code IS NOT NULL THEN
        RAISE EXCEPTION
            'project_code for project_name "诗澜瑞" must remain NULL; found %',
            current_code;
    END IF;

    SELECT project_name, project_code
    INTO invalid_project_name, invalid_project_code
    FROM public.projects
    WHERE project_code IS NOT NULL
      AND (project_code !~ '^[A-Z]{3}$' OR project_code = 'ALL')
    ORDER BY project_name
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
            'invalid existing project_code "%" for project_name "%"; expected ^[A-Z]{3}$ and not ALL',
            invalid_project_code, invalid_project_name;
    END IF;
END
$project_code_preflight$;

UPDATE public.projects AS project
SET project_code = expected.project_code
FROM project_code_backfill AS expected
WHERE project.project_name = expected.project_name
  AND project.project_code IS NULL;

DO $project_code_constraints_preflight$
DECLARE
    duplicate_code varchar(3);
    duplicate_count bigint;
BEGIN
    SELECT project_code, count(*)
    INTO duplicate_code, duplicate_count
    FROM public.projects
    WHERE project_code IS NOT NULL
    GROUP BY project_code
    HAVING count(*) > 1
    ORDER BY project_code
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
            'duplicate project_code "%" is assigned to % projects',
            duplicate_code, duplicate_count;
    END IF;
END
$project_code_constraints_preflight$;

DO $project_code_add_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.projects'::regclass
          AND conname = 'projects_project_code_format_check'
    ) THEN
        ALTER TABLE public.projects
            ADD CONSTRAINT projects_project_code_format_check
            CHECK (
                project_code IS NULL
                OR (project_code ~ '^[A-Z]{3}$' AND project_code <> 'ALL')
            );
    END IF;
END
$project_code_add_check$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_project_code
    ON public.projects (project_code)
    WHERE project_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_project_code_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $project_code_immutable$
BEGIN
    IF OLD.project_code IS NOT NULL
       AND NEW.project_code IS DISTINCT FROM OLD.project_code THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'projects_project_code_immutable',
            MESSAGE = 'project_code cannot be changed once assigned';
    END IF;
    RETURN NEW;
END
$project_code_immutable$;

DROP TRIGGER IF EXISTS projects_project_code_immutable ON public.projects;
CREATE TRIGGER projects_project_code_immutable
    BEFORE UPDATE OF project_code ON public.projects
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_project_code_reassignment();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $project_code_rollback_guard$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.projects WHERE project_code IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'cannot roll back project_code while any project code is assigned';
    END IF;
END
$project_code_rollback_guard$;

DROP TRIGGER IF EXISTS projects_project_code_immutable ON public.projects;
DROP FUNCTION IF EXISTS public.prevent_project_code_reassignment();
DROP INDEX IF EXISTS public.uq_projects_project_code;
ALTER TABLE public.projects
    DROP CONSTRAINT IF EXISTS projects_project_code_format_check;
ALTER TABLE public.projects
    DROP COLUMN IF EXISTS project_code;
-- +goose StatementEnd
