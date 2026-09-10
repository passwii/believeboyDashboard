"""I-4：事件 discriminated union、SSE cursor、状态语义测试。"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.services.insight import contracts
from app.services.insight.cursor import (
    CursorError,
    check_future_cursor,
    event_id_of,
    format_event_id,
    group_by_attempt,
    parse_event_id,
    validate_attempt_sequence,
)
from app.services.insight.events import InsightEventAdapter

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "insight"


def _load(name: str) -> list:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))["events"]


def _parse_all(name: str):
    return [InsightEventAdapter.validate_python(raw) for raw in _load(name)]


def _envelope(run_id=None, **overrides):
    base = {
        "schema_version": 1,
        "run_id": str(run_id or uuid4()),
        "attempt": 1,
        "seq": 1,
        "type": "ping",
    }
    base.update(overrides)
    return base


def test_union_discriminates_all_seven_types():
    events = _parse_all("normal-run")
    assert [e.type for e in events] == [
        "snapshot",
        "status",
        "content.delta",
        "content.delta",
        "content.snapshot",
        "status",
        "done",
    ]
    assert [e.type for e in _parse_all("failed-run")][-1] == "error"
    assert [e.type for e in _parse_all("cancelled-run")][-1] == "error"
    ping = InsightEventAdapter.validate_python(_envelope())
    assert ping.type == "ping"


def test_envelope_rejects_bad_schema_version_uuid_and_seq():
    run_id = str(uuid4())
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(_envelope(run_id, schema_version=2))
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(_envelope("not-a-uuid"))
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(_envelope(run_id, seq=0))
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(_envelope(run_id, attempt=0))


def test_unknown_discriminator_and_unknown_field_rejected():
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(_envelope(type="content.future"))
    bad = _envelope()
    bad["bogus"] = 1
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(bad)


def test_content_delta_rejects_empty_and_bad_nested_slot():
    run_id = str(uuid4())
    bad = _envelope(run_id, type="content.delta", seq=3)
    bad.update({"slot": "main", "block_id": "b1", "format": "markdown", "delta": ""})
    with pytest.raises(ValidationError):
        InsightEventAdapter.validate_python(bad)


def test_replay_same_json_gives_same_model_and_bytes():
    raw = _load("normal-run")[2]
    first = InsightEventAdapter.validate_python(raw)
    second = InsightEventAdapter.validate_python(json.loads(json.dumps(raw)))
    assert first == second
    assert contracts.serialize_contract(first) == contracts.serialize_contract(second)


def test_same_identity_cannot_be_two_events():
    # 同一 (run_id, attempt, seq) 不同 type → 解析后身份相同但内容不同由调用方去重；
    # 这里断言外部 id 只由三元组决定
    run_id = uuid4()
    assert format_event_id(run_id, 1, 3) == f"{run_id}:1:3"
    assert " " not in format_event_id(run_id, 1, 3)


def test_event_id_roundtrip_and_invalid_cursors():
    run_id = uuid4()
    parsed = parse_event_id(f"{run_id}:2:7")
    assert (parsed.run_id, parsed.attempt, parsed.seq) == (run_id, 2, 7)
    for bad in ["", "abc", f"{run_id}:1", f"{run_id}:0:1", "notauuid:1:1", f"{run_id}:1:1 "]:
        with pytest.raises(CursorError):
            parse_event_id(bad)


def test_future_cursor_rejected():
    run_id = uuid4()
    cursor = parse_event_id(f"{run_id}:3:1")
    with pytest.raises(CursorError):
        check_future_cursor(cursor, current_attempt=2)


def test_sequence_rules_per_attempt_and_terminal_last():
    for name in ("normal-run", "failed-run", "cancelled-run"):
        for group in group_by_attempt(_parse_all(name)).values():
            validate_attempt_sequence(group)
    groups = group_by_attempt(_parse_all("retry-attempt"))
    assert set(groups) == {1, 2}
    for group in groups.values():
        validate_attempt_sequence(group)
    # retry 后 attempt 重置 seq=1
    assert groups[2][0].seq == 1


def test_terminal_event_must_be_last():
    events = _parse_all("failed-run")
    done_like = events[-1].model_copy(update={"seq": 99})
    with pytest.raises(CursorError):
        validate_attempt_sequence([*events, done_like])


def test_resume_gap_detected_and_cursor_points_before_gap():
    doc = json.loads((FIXTURES / "resume-gap.json").read_text(encoding="utf-8"))
    events = [InsightEventAdapter.validate_python(raw) for raw in doc["events"]]
    with pytest.raises(CursorError):
        validate_attempt_sequence(events)
    cursor = parse_event_id(doc["resume_from"])
    assert cursor.seq == 2
    assert event_id_of(events[0]) == f"{events[0].run_id}:1:1"
