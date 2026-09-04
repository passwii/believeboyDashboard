from __future__ import annotations

import sys

from worker.tasks import run_job


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python -m worker.oneoff_runner <job_id>')
    run_job(int(sys.argv[1]))


if __name__ == '__main__':
    main()
