from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.orm import Session


DEFAULT_AVATAR_URL = "/avatars/default.svg"


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def ensure_presence_table(db: Session) -> None:
    dialect = db.bind.dialect.name if db.bind is not None else ""

    if dialect == "postgresql":
        db.execute(
            text(
                """
                create table if not exists public.user_presence (
                  user_id text primary key,
                  display_name text not null,
                  email text null,
                  avatar_url text null,
                  current_path varchar(255) not null,
                  current_page_title varchar(255) not null,
                  last_seen_at timestamptz not null default now(),
                  created_at timestamptz not null default now(),
                  updated_at timestamptz not null default now()
                )
                """
            )
        )
        db.execute(text("create index if not exists idx_user_presence_last_seen_at on public.user_presence (last_seen_at desc)"))
        db.execute(
            text(
                """
                create index if not exists idx_user_presence_current_path
                on public.user_presence (current_path)
                """
            )
        )
        return

    db.execute(
        text(
            """
            create table if not exists user_presence (
              user_id text primary key,
              display_name text not null,
              email text null,
              avatar_url text null,
              current_path varchar(255) not null,
              current_page_title varchar(255) not null,
              last_seen_at text not null,
              created_at text not null,
              updated_at text not null
            )
            """
        )
    )
    db.execute(text("create index if not exists idx_user_presence_last_seen_at on user_presence (last_seen_at desc)"))
    db.execute(text("create index if not exists idx_user_presence_current_path on user_presence (current_path)"))


def upsert_presence(
    db: Session,
    *,
    user_id: str,
    display_name: str,
    email: str | None,
    avatar_url: str | None,
    current_path: str,
    current_page_title: str,
) -> None:
    ensure_presence_table(db)

    payload = {
        "user_id": user_id[:255],
        "display_name": display_name[:255],
        "email": (email or None),
        "avatar_url": (avatar_url or DEFAULT_AVATAR_URL)[:500],
        "current_path": current_path[:255],
        "current_page_title": current_page_title[:255],
    }

    dialect = db.bind.dialect.name if db.bind is not None else ""
    if dialect == "postgresql":
        db.execute(
            text(
                """
                insert into public.user_presence (
                  user_id,
                  display_name,
                  email,
                  avatar_url,
                  current_path,
                  current_page_title,
                  last_seen_at,
                  created_at,
                  updated_at
                )
                values (
                  :user_id,
                  :display_name,
                  :email,
                  :avatar_url,
                  :current_path,
                  :current_page_title,
                  now(),
                  now(),
                  now()
                )
                on conflict (user_id) do update
                set
                  display_name = excluded.display_name,
                  email = excluded.email,
                  avatar_url = excluded.avatar_url,
                  current_path = excluded.current_path,
                  current_page_title = excluded.current_page_title,
                  last_seen_at = now(),
                  updated_at = now()
                """
            ),
            payload,
        )
        return

    now_iso = _utc_now_iso()
    db.execute(
        text(
            """
            insert into user_presence (
              user_id,
              display_name,
              email,
              avatar_url,
              current_path,
              current_page_title,
              last_seen_at,
              created_at,
              updated_at
            )
            values (
              :user_id,
              :display_name,
              :email,
              :avatar_url,
              :current_path,
              :current_page_title,
              :now_iso,
              :now_iso,
              :now_iso
            )
            on conflict(user_id) do update set
              display_name = excluded.display_name,
              email = excluded.email,
              avatar_url = excluded.avatar_url,
              current_path = excluded.current_path,
              current_page_title = excluded.current_page_title,
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at
            """
        ),
        {
            **payload,
            "now_iso": now_iso,
        },
    )


def list_active_presence(db: Session, *, current_user_id: str | None, stale_after_seconds: int) -> list[dict[str, object]]:
    ensure_presence_table(db)

    safe_seconds = max(30, min(stale_after_seconds, 300))
    dialect = db.bind.dialect.name if db.bind is not None else ""

    if dialect == "postgresql":
        rows = db.execute(
            text(
                """
                select
                  user_id,
                  display_name,
                  email,
                  avatar_url,
                  current_path,
                  current_page_title,
                  last_seen_at
                from public.user_presence
                where last_seen_at >= now() - make_interval(secs => :safe_seconds)
                order by last_seen_at desc, display_name asc
                """
            ),
            {"safe_seconds": safe_seconds},
        ).mappings().all()
    else:
        cutoff = datetime.now(UTC).timestamp() - safe_seconds
        rows = db.execute(
            text(
                """
                select
                  user_id,
                  display_name,
                  email,
                  avatar_url,
                  current_path,
                  current_page_title,
                  last_seen_at
                from user_presence
                where unixepoch(last_seen_at) >= :cutoff
                order by unixepoch(last_seen_at) desc, display_name asc
                """
            ),
            {"cutoff": cutoff},
        ).mappings().all()

    return [
        {
            "user_id": str(row["user_id"]),
            "display_name": str(row["display_name"]),
            "email": str(row["email"]) if row["email"] is not None else None,
            "avatar_url": str(row["avatar_url"]) if row["avatar_url"] is not None else DEFAULT_AVATAR_URL,
            "current_path": str(row["current_path"]),
            "current_page_title": str(row["current_page_title"]),
            "last_seen_at": str(row["last_seen_at"]),
            "is_current_user": current_user_id is not None and str(row["user_id"]) == current_user_id,
        }
        for row in rows
    ]
