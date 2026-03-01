#!/usr/bin/env python3
"""Backward-compatible entrypoint. Use bench_postgres_rw.py instead."""

from bench_postgres_rw import main


if __name__ == "__main__":
    raise SystemExit(main())
