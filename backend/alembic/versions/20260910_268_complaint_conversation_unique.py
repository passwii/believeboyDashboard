"""客诉对话唯一约束与历史去重（BLF-981）

Revision ID: 268
Revises: 267 (seller_identity)
Create Date: 2026-09-10 00:00:00.000000

与 BLF-1004 落地的 Dashboard 契约配套：complaints 已经有
first_message_date / message_count / messages，本迁移只做唯一键切换。

1. 把 GB 统一为仓库 canonical UK（complaints + shop_checks）；
2. 按对话自然键合并重复行，保留最新更新的那条，消息与状态历史取并集；
3. shop_checks 先对同一 (run_id, project_id) 的 GB/UK 成对行去重（保留最新一整行），
   再归一化，否则撞 UNIQUE (run_id, project_id, country)；
4. 删除旧的消息级 partial unique，新增对话级唯一约束。

数据修复不可逆：downgrade 只恢复约束，不恢复被合并删除的行，
也不把 UK 改回 GB。
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

from alembic import op
import sqlalchemy as sa


revision: str = '268'
down_revision: str = '267'
branch_labels = None
depends_on = None


def _complaints_table() -> sa.Table:
    return sa.table(
        'complaints',
        sa.column('id', sa.BigInteger()),
        sa.column('run_id', sa.BigInteger()),
        sa.column('project_id', sa.BigInteger()),
        sa.column('country', sa.String(2)),
        sa.column('buyer_name', sa.String(255)),
        sa.column('first_message_date', sa.Date()),
        sa.column('message_date', sa.Date()),
        sa.column('subject', sa.String(512)),
        sa.column('message_body', sa.Text()),
        sa.column('triage', sa.JSON()),
        sa.column('category', sa.String(16)),
        sa.column('has_order', sa.Boolean()),
        sa.column('order_info', sa.JSON()),
        sa.column('sla', sa.JSON()),
        sa.column('status', sa.String(16)),
        sa.column('draft_path', sa.Text()),
        sa.column('reply_sent_at', sa.DateTime(timezone=True)),
        sa.column('handler_note', sa.Text()),
        sa.column('status_history', sa.JSON()),
        sa.column('message_count', sa.Integer()),
        sa.column('messages', sa.JSON()),
        sa.column('updated_at', sa.DateTime(timezone=True)),
    )


def _as_dict(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _as_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _iso_date(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or '')[:10]


def _message_key(message: dict) -> tuple[str, str, str]:
    return (
        _iso_date(message.get('message_date')),
        str(message.get('subject') or ''),
        str(message.get('message_body') or ''),
    )


def _snapshot_from_row(row: dict) -> dict:
    return {
        'project_id': row['project_id'],
        'country': row['country'],
        'buyer_name': row['buyer_name'],
        'first_message_date': _iso_date(row['first_message_date']),
        'message_date': _iso_date(row['message_date']),
        'subject': row['subject'],
        'message_body': row['message_body'],
        'triage': _as_dict(row['triage']),
        'order': _as_dict(row['order_info']) or None,
        'sla': _as_dict(row['sla']) or None,
        'message_count': 1,
    }


def _merge_messages(rows: list[dict]) -> list[dict]:
    """合并同一对话的全部消息快照，完全重复的人工消息只保留最后一次。"""
    merged: list[dict] = []
    positions: dict[tuple[str, str, str], int] = {}
    ordered = sorted(rows, key=lambda item: (_iso_date(item['message_date']), item['id']))
    for row in ordered:
        snapshots = [item for item in _as_list(row['messages']) if isinstance(item, dict)]
        if not snapshots:
            snapshots = [_snapshot_from_row(row)]
        for snapshot in snapshots:
            key = _message_key(snapshot)
            if key in positions:
                merged[positions[key]] = snapshot
            else:
                positions[key] = len(merged)
                merged.append(snapshot)
    return merged


def _merge_status_history(rows: list[dict]) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    entries: list[tuple[str, dict]] = []
    for row in rows:
        for entry in _as_list(row['status_history']):
            if isinstance(entry, dict):
                entries.append((str(entry.get('at') or ''), entry))
    for _, entry in sorted(entries, key=lambda item: item[0]):
        token = json.dumps(entry, sort_keys=True, ensure_ascii=False, default=str)
        if token not in seen:
            seen.add(token)
            merged.append(entry)
    return merged


def _merge_duplicate_group(rows: list[dict]) -> tuple[int, dict, list[int]]:
    """同一对话键的多行合并为一行，返回 (保留 id, 更新值, 删除 id)。"""
    survivor = max(rows, key=lambda item: (str(item['updated_at'] or ''), item['id']))
    latest_first = sorted(rows, key=lambda item: (str(item['updated_at'] or ''), item['id']), reverse=True)
    messages = _merge_messages(rows)
    message_dates = {_iso_date(row['message_date']) for row in rows}
    message_dates.update(_iso_date(message.get('message_date')) for message in messages)
    message_dates.discard('')

    values: dict[str, Any] = {
        'message_date': date.fromisoformat(max(message_dates)),
        'message_count': len(messages),
        'messages': messages,
        'status_history': _merge_status_history(rows),
    }
    for field in ('draft_path', 'reply_sent_at', 'handler_note'):
        for row in latest_first:
            if row[field] is not None:
                values[field] = row[field]
                break
    if not survivor['has_order']:
        for row in latest_first:
            if row['has_order']:
                values['has_order'] = True
                if row['order_info'] is not None:
                    values['order_info'] = row['order_info']
                break
    if survivor['sla'] is None:
        for row in latest_first:
            if row['sla'] is not None:
                values['sla'] = row['sla']
                break
    delete_ids = [row['id'] for row in rows if row['id'] != survivor['id']]
    return survivor['id'], values, delete_ids


def _duplicate_group_keys(connection: sa.Connection) -> list[tuple]:
    result = connection.execute(
        sa.text(
            """
            SELECT project_id, country, buyer_name, first_message_date
            FROM complaints
            GROUP BY project_id, country, buyer_name, first_message_date
            HAVING COUNT(*) > 1
            """
        )
    )
    return [tuple(row) for row in result.all()]

def _rows_for_group(connection: sa.Connection, key: tuple) -> list[dict]:
    complaints = _complaints_table()
    result = connection.execute(
        sa.select(complaints)
        .where(
            complaints.c.project_id == key[0],
            complaints.c.country == key[1],
            complaints.c.buyer_name == key[2],
            complaints.c.first_message_date == key[3],
        )
        .order_by(complaints.c.id)
    )
    return [dict(row) for row in result.mappings().all()]

def _shop_checks_table() -> sa.Table:
    return sa.table(
        'shop_checks',
        sa.column('id', sa.BigInteger()),
        sa.column('run_id', sa.BigInteger()),
        sa.column('project_id', sa.BigInteger()),
        sa.column('country', sa.String(2)),
        sa.column('updated_at', sa.DateTime(timezone=True)),
    )


def _duplicate_shop_check_keys(connection: sa.Connection) -> list[tuple]:
    """同一 (run_id, project_id) 下同时存在 GB 与 UK 行的键。

    旧写侧用原始 country 做 upsert（未归一），同一 run 的同一店铺可能各写过
    一次 GB 和 UK；归一化为 UK 后会撞 UNIQUE (run_id, project_id, country)。
    """
    result = connection.execute(
        sa.text(
            """
            SELECT run_id, project_id
            FROM shop_checks
            WHERE country IN ('GB', 'UK')
            GROUP BY run_id, project_id
            HAVING COUNT(*) > 1
            """
        )
    )
    return [tuple(row) for row in result.all()]


def _dedupe_shop_checks(connection: sa.Connection) -> None:
    """shop_checks GB/UK 成对行去重：保留 updated_at 最新的一整行。

    shop_checks 是单次 run 的快照（非累积），整行保留最新即等价于“最后一次
    写入为准”，与 upsert_batch 的 last-write-wins 口径一致。
    """
    shop_checks = _shop_checks_table()
    for key in _duplicate_shop_check_keys(connection):
        result = connection.execute(
            sa.select(shop_checks)
            .where(
                shop_checks.c.run_id == key[0],
                shop_checks.c.project_id == key[1],
                shop_checks.c.country.in_(['GB', 'UK']),
            )
            .order_by(shop_checks.c.id)
        )
        rows = [dict(row) for row in result.mappings().all()]
        if len(rows) < 2:
            continue
        survivor = max(rows, key=lambda item: (str(item['updated_at'] or ''), item['id']))
        delete_ids = [row['id'] for row in rows if row['id'] != survivor['id']]
        connection.execute(shop_checks.delete().where(shop_checks.c.id.in_(delete_ids)))


def upgrade() -> None:
    # 先删旧的消息级 partial unique：GB → UK 会让同一对话的两行在旧键上相撞，
    # 必须先解除旧约束，再归一化、合并，最后加新约束。
    # shop_checks 同理：先对 GB/UK 成对行去重（保留最新一行），再归一化，
    # 否则 UPDATE 会撞 UNIQUE (run_id, project_id, country)。
    op.drop_index('uq_complaints_with_order', table_name='complaints')
    op.drop_index('uq_complaints_no_order', table_name='complaints')
    op.execute(sa.text("UPDATE complaints SET country = 'UK' WHERE country = 'GB'"))
    _dedupe_shop_checks(op.get_bind())
    op.execute(sa.text("UPDATE shop_checks SET country = 'UK' WHERE country = 'GB'"))
    op.execute(
        sa.text(
            'UPDATE complaints SET first_message_date = message_date '
            'WHERE first_message_date IS NULL'
        )
    )

    connection = op.get_bind()
    complaints = _complaints_table()
    for key in _duplicate_group_keys(connection):
        rows = _rows_for_group(connection, key)
        if len(rows) < 2:
            continue
        keep_id, values, delete_ids = _merge_duplicate_group(rows)
        connection.execute(
            complaints.update().where(complaints.c.id == keep_id).values(**values)
        )
        connection.execute(complaints.delete().where(complaints.c.id.in_(delete_ids)))

    with op.batch_alter_table('complaints') as batch_op:
        batch_op.create_unique_constraint(
            'uq_complaints_project_country_buyer_date',
            ['project_id', 'country', 'buyer_name', 'first_message_date'],
        )


def downgrade() -> None:
    with op.batch_alter_table('complaints') as batch_op:
        batch_op.drop_constraint(
            'uq_complaints_project_country_buyer_date', type_='unique'
        )
    op.create_index(
        'uq_complaints_with_order',
        'complaints',
        ['project_id', 'country', 'buyer_name', 'message_date'],
        unique=True,
        postgresql_where=sa.text('has_order = true'),
        sqlite_where=sa.text('has_order = 1'),
    )
    op.create_index(
        'uq_complaints_no_order',
        'complaints',
        ['project_id', 'country', 'buyer_name', 'message_date', 'subject'],
        unique=True,
        postgresql_where=sa.text('has_order = false'),
        sqlite_where=sa.text('has_order = 0'),
    )
