"""BLF-1047：beat 专用 Celery app（`app.tasks.celery_beat_app`）的守门测试。

背景：`celery beat` 启动会走 `app.loader.init_worker()` →
`import_default_modules()`，把 app 的 `include=[...]` 里的任务模块**全部** import。
beat 只按任务名往 broker 发消息、不需要任务实现，所以生产上把 beat 单元切到这个
`include=[]` 的 app：实测调度进程 202MB → ~70MB RSS、153 个 `app.*` 模块 → 0 个。

本文件守两类回归，对应这个改动两个真实失败模式：

1. **import 链被加回来**（省下的内存又还回去）。用子进程实测 `sys.modules`，
   不看注释、只看事实。
2. **beat 与 worker 的路由/调度表漂移**（本改动最危险的一类）：beat 发消息时
   按 `task_routes` + `task_default_queue` 选队列，一旦两表不一致，任务会被发到
   没有人消费的队列而**静默不执行**。所以这里逐项对齐两个 app 的发消息侧配置，
   并把「每条 beat 条目的目标队列必须被某个 worker 单元消费」做成机械断言
   （消费队列从 systemd 单元的 `-Q` 解析，不写死）。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2]
SYSTEMD_DIR = BACKEND_ROOT / "deploy" / "systemd"


def _beat_app():
    from app.tasks.celery_beat_app import celery_beat_app

    return celery_beat_app


# ---------------------------------------------------------------------------
# 1. 空 include：beat 不该 import 任何任务实现
# ---------------------------------------------------------------------------


def test_beat_app_has_empty_include() -> None:
    """`include=[]` 是本 app 存在的全部理由：celery beat 会 eager import 它。"""
    beat = _beat_app()
    assert beat.conf.include == []
    # loader 侧的真实口径：beat 启动时 import 的模块集合必须为空
    assert beat.loader.default_modules == ()
    # 不断言 beat.tasks 里有没有任务：celery 的 shared_task 会让「任何 app
    # finalize 时都继承进程里已 import 的共享任务」，所以在同一个 pytest 进程里
    # 跑过别的任务测试后，beat.tasks 会带上那些任务——与「beat 启动 import 了
    # 多少模块」无关。这条真实口径由下面的子进程测试把关。


def test_importing_beat_app_loads_no_task_service_or_model_module() -> None:
    """子进程实测：import beat app 之后 sys.modules 里不得有任务/服务/模型层。

    这是「省下 ~130MB」的机械判据——只断言配置值不够，真正的代价在 import 图里。
    """
    code = (
        "import sys, app.tasks.celery_beat_app;"
        "leaked = sorted(m for m in sys.modules if m.startswith("
        "('app.celery_tasks', 'app.models', 'app.services', 'app.db', 'app.api')));"
        "print('LEAKED=' + ','.join(leaked))"
    )
    env = dict(os.environ)
    # Settings 必须有库可指（import 期不会真连库）；本地/CI 缺 env 时给个占位值。
    env.setdefault("DATABASE_URL", "postgresql+psycopg://blf:blf@localhost:5432/BLF_test")

    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(BACKEND_ROOT),
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
        check=False,  # 失败由下面的 returncode 断言给出可读信息
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    leaked_line = [ln for ln in proc.stdout.splitlines() if ln.startswith("LEAKED=")]
    assert leaked_line, proc.stdout
    assert leaked_line[0] == "LEAKED=", (
        f"beat app 的 import 链漏进了任务/服务/模型层：{leaked_line[0]}"
    )


# ---------------------------------------------------------------------------
# 2. beat 与 worker 的发消息侧配置必须一致
# ---------------------------------------------------------------------------


def test_beat_app_mirrors_worker_publish_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """broker / 默认队列 / 路由 / 调度表 / 时区必须与 worker app 同源同值。

    beat 是「发布者」，worker 是「执行者」——发布侧配置与执行侧不一致就会出现
    发了没人收（静默丢调度）或发错队列（screenshot 内存隔离失效）。

    两个 app 都**当场重建**而不比单例：单例的 broker 在各自 import 时就从
    Settings 定下了，而同进程里 `get_settings` 是 lru_cache（别的用例会清缓存
    换 env），比单例会把测试顺序变成结果变量。这里统一 env + 统一清缓存后建，
    比的才是「同一个 Settings 喂出同一个 broker」这条真不变式。
    """
    from app.core import config as config_mod
    from app.tasks import celery_app as worker_mod
    from app.tasks import celery_beat_app as beat_mod

    monkeypatch.setenv("REDIS_HOST", "redis.local")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.delenv("CELERY_BROKER_URL", raising=False)
    monkeypatch.delenv("CELERY_RESULT_URL", raising=False)
    config_mod.get_settings.cache_clear()
    try:
        worker = worker_mod._build_celery_app()
        beat = beat_mod._build_beat_app()

        assert beat.conf.broker_url == worker.conf.broker_url
        assert beat.conf.result_backend == worker.conf.result_backend
        assert beat.conf.task_default_queue == worker.conf.task_default_queue
        assert beat.conf.task_routes == worker.conf.task_routes
        assert beat.conf.beat_schedule == worker.conf.beat_schedule
        assert beat.conf.timezone == worker.conf.timezone
        assert beat.conf.enable_utc == worker.conf.enable_utc
    finally:
        # 不把带 redis.local 的 Settings 留在 lru_cache 里污染后续用例
        # （test_celery_app_config.py 就是这么留下的：它清了缓存后不还回去）。
        config_mod.get_settings.cache_clear()


def test_beat_and_worker_share_the_same_table_objects() -> None:
    """不只是值相等：两张表必须是同一份对象（单一来源，改一处两边都变）。"""
    from app.tasks import celery_shared
    from app.tasks.celery_app import celery_app as worker

    beat = _beat_app()
    assert beat.conf.beat_schedule is celery_shared.BEAT_SCHEDULE
    assert beat.conf.task_routes is celery_shared.TASK_ROUTES
    assert worker.conf.beat_schedule is celery_shared.BEAT_SCHEDULE
    assert worker.conf.task_routes is celery_shared.TASK_ROUTES


_CONSUMED_QUEUES = re.compile(r"-Q\s+([\w,]+)")


def _worker_consumed_queues() -> set[str]:
    """从 worker systemd 单元的 `-Q` 解析出「实际有人消费」的队列集合。"""
    queues: set[str] = set()
    units = sorted(SYSTEMD_DIR.glob("believeboy-celery*.service"))
    assert units, f"未找到 worker 单元：{SYSTEMD_DIR}"
    for unit in units:
        matches = _CONSUMED_QUEUES.findall(unit.read_text(encoding="utf-8"))
        assert matches, f"{unit.name} 里没解析到 -Q，断言口径已失效"
        for match in matches:
            queues.update(q for q in match.split(",") if q)
    return queues


def test_every_beat_entry_routes_to_a_consumed_queue() -> None:
    """每条 beat 条目的目标队列都必须有 worker 消费（防「静默丢调度」）。

    按 beat app 自己的 `task_routes` + `task_default_queue` 算目标队列——这正是
    beat 发消息时的解析顺序；若 beat app 漏了默认队列，未路由条目会落到 celery
    内置的 `celery` 队列，没有任何 worker 消费，任务就永远不执行。
    """
    beat = _beat_app()
    consumed = _worker_consumed_queues()
    assert beat.conf.task_default_queue in consumed, (
        f"默认队列 {beat.conf.task_default_queue!r} 无 worker 消费：{sorted(consumed)}"
    )

    for name, entry in beat.conf.beat_schedule.items():
        route = beat.conf.task_routes.get(entry["task"], {})
        queue = route.get("queue", beat.conf.task_default_queue)
        assert queue in consumed, (
            f"beat 条目 {name!r}（task={entry['task']!r}）发往 {queue!r}，"
            f"但只有 {sorted(consumed)} 有 worker 消费 → 会静默不执行"
        )


def test_beat_app_resolves_for_celery_dash_a() -> None:
    """systemd 用 `-A app.tasks.celery_beat_app`：celery 必须能从中解析出 app。

    celery 5.4 的 `find_app` 对模块会先取 `.app` 属性、否则扫模块里第一个
    Celery 实例（celery/app/utils.py）。这条断言把 `-A` 的解析契约钉住。
    """
    from celery.app.utils import find_app

    assert find_app("app.tasks.celery_beat_app") is _beat_app()
