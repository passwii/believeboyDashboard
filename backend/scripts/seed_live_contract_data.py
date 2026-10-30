"""Seed deterministic data for the FastAPI <-> Go live contract test.

The live contract suite runs both implementations against the same database.
These fixtures cover every Week 1 read route without depending on whatever
happens to be in a developer's persistent BLF_test database.

Only ephemeral/test databases named BLF_test or BLF_ci are accepted.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote

from sqlalchemy import create_engine, make_url, text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

LIVE_PROJECT_NAME = "__live_contract_project__"
LIVE_RULE_NAME = "__live_contract_rule__"
LIVE_NOTIFICATION_TITLE = "__live_contract_notification__"
LIVE_NOTIFICATION_USER_ID = 424242
LIVE_EXCHANGE_CURRENCY = "LVC"
LIVE_EXCHANGE_YEAR_MONTH = "2026-10"
LIVE_PROFILE_EMAIL = "test_admin@believeboy.com"


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _export_env(values: dict[str, str]) -> None:
    for key, value in values.items():
        os.environ[key] = value


def _load_env_files() -> None:
    explicit_env = os.environ.get("LIVE_CONTRACT_ENV_FILE")
    if explicit_env:
        explicit_path = Path(explicit_env)
        if not explicit_path.exists():
            raise SystemExit(
                f"seed_live_contract_data failed: env file not found: {explicit_path}"
            )
        values = _read_env_file(explicit_path)
        database_url = values.get("DATABASE_URL")
        test_database_url = values.get("TEST_DATABASE_URL")
        if database_url and test_database_url and database_url != test_database_url:
            raise SystemExit(
                "seed_live_contract_data failed: DATABASE_URL and TEST_DATABASE_URL "
                "in LIVE_CONTRACT_ENV_FILE point to different databases"
            )
        chosen_db_url = database_url or test_database_url
        if chosen_db_url:
            values["DATABASE_URL"] = chosen_db_url
            values["TEST_DATABASE_URL"] = chosen_db_url
        _export_env(values)
        return

    for path, override in ((ROOT / ".env", False), (ROOT / ".env.test", True)):
        if not path.exists():
            continue
        for key, value in _read_env_file(path).items():
            if override or key not in os.environ:
                os.environ[key] = value


def _database_url(explicit_url: str | None = None) -> str:
    url = (
        (explicit_url or "").strip()
        or os.environ.get("LIVE_CONTRACT_DATABASE_URL", "").strip()
        or os.environ.get("TEST_DATABASE_URL", "").strip()
        or os.environ.get("DATABASE_URL", "").strip()
    )
    if not url:
        raise SystemExit(
            "seed_live_contract_data failed: TEST_DATABASE_URL or DATABASE_URL is required"
        )
    database = (make_url(url).database or "").casefold()
    if database not in {"blf_test", "blf_ci"}:
        raise SystemExit(
            "seed_live_contract_data refused: database must be BLF_test or BLF_ci "
            f"(got {unquote(database)!r})"
        )
    return url


def seed(database_url: str | None = None) -> None:
    engine = create_engine(_database_url(database_url), future=True)
    with engine.begin() as conn:
        profile = conn.execute(
            text(
                """
                select id::text
                from public.user_accounts
                where lower(email) = lower(:email)
                limit 1
                """
            ),
            {"email": LIVE_PROFILE_EMAIL},
        ).scalar_one_or_none()
        if profile is None:
            raise SystemExit(
                "seed_live_contract_data failed: test admin account is missing; "
                "run scripts/seed_test_accounts.py first"
            )

        project_id = conn.execute(
            text("select id from public.projects where project_name = :project_name limit 1"),
            {"project_name": LIVE_PROJECT_NAME},
        ).scalars().first()
        if project_id is None:
            project_id = conn.execute(
                text(
                    """
                    insert into public.projects (
                      project_name, project_operator, sort_order, is_active, country
                    )
                    values (:project_name, 'live-contract-operator', 0, true, 'US')
                    returning id
                    """
                ),
                {"project_name": LIVE_PROJECT_NAME},
            ).scalar_one()
        else:
            conn.execute(
                text(
                    """
                    update public.projects
                    set project_operator = 'live-contract-operator',
                        sort_order = 0,
                        is_active = true,
                        country = 'US',
                        updated_at = now()
                    where id = :project_id
                    """
                ),
                {"project_id": project_id},
            )

        conn.execute(
            text("delete from public.alert_events where message = '[live-contract] fixture event'")
        )
        conn.execute(
            text("delete from public.alert_rules where name = :name"),
            {"name": LIVE_RULE_NAME},
        )
        rule_id = conn.execute(
            text(
                """
                insert into public.alert_rules (
                  name, project_id, country, metric, trigger_type, condition,
                  threshold, window_days, severity, notification_channels,
                  is_active, created_by, created_at, updated_at
                )
                values (
                  :name, :project_id, 'US', 'acos', 'threshold', 'above',
                  0.25, 7, 'warning', 'in_app', true, 'live-contract-operator',
                  '2026-10-01T02:03:04.123+00:00',
                  '2026-10-01T02:03:04.123+00:00'
                )
                returning id
                """
            ),
            {"name": LIVE_RULE_NAME, "project_id": project_id},
        ).scalar_one()
        conn.execute(
            text(
                """
                insert into public.alert_events (
                  rule_id, project_id, metric, current_value, baseline_value,
                  deviation_pct, severity, message, status, triggered_at
                )
                values (
                  :rule_id, :project_id, 'acos', 0.3, 0.2, 50, 'warning',
                  '[live-contract] fixture event', 'active',
                  '2026-10-01T02:03:04.123+00:00'
                )
                """
            ),
            {"rule_id": rule_id, "project_id": project_id},
        )

        conn.execute(
            text("delete from public.notifications where title = :title"),
            {"title": LIVE_NOTIFICATION_TITLE},
        )
        conn.execute(
            text(
                """
                insert into public.notifications (
                  user_id, type, title, message, data, "read", created_at
                )
                values (
                  :user_id, 'alert', :title, 'live contract notification',
                  cast(:data as json), false, '2026-10-01T02:03:04.123+00:00'
                )
                """
            ),
            {
                "user_id": LIVE_NOTIFICATION_USER_ID,
                "title": LIVE_NOTIFICATION_TITLE,
                "data": json.dumps({"project_id": project_id}),
            },
        )

        conn.execute(
            text(
                """
                delete from public.exchange_rates
                where currency = :currency and year_month = :year_month
                """
            ),
            {
                "currency": LIVE_EXCHANGE_CURRENCY,
                "year_month": LIVE_EXCHANGE_YEAR_MONTH,
            },
        )
        conn.execute(
            text(
                """
                insert into public.exchange_rates (
                  currency, currency_name, year_month, rate, description,
                  note_images, created_at, updated_at
                )
                values (
                  :currency, 'Live Contract Currency', :year_month, 7.12345678,
                  'live contract exchange rate', cast('[]' as json),
                  '2026-10-01T01:02:03.456+00:00',
                  '2026-10-01T01:02:03.456+00:00'
                )
                """
            ),
            {
                "currency": LIVE_EXCHANGE_CURRENCY,
                "year_month": LIVE_EXCHANGE_YEAR_MONTH,
            },
        )

    engine.dispose()
    print(
        "Live contract fixture ready: "
        f"project={LIVE_PROJECT_NAME}, user_id={LIVE_NOTIFICATION_USER_ID}, "
        f"exchange={LIVE_EXCHANGE_CURRENCY}/{LIVE_EXCHANGE_YEAR_MONTH}, "
        f"profile={LIVE_PROFILE_EMAIL}"
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url",
        help="Exact database URL chosen by the caller; takes precedence over env files.",
    )
    args = parser.parse_args(argv)
    _load_env_files()
    seed(args.database_url)


if __name__ == "__main__":
    main()
