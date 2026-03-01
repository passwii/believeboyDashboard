#!/usr/bin/env python3
"""Backward-compatible entrypoint. Use test_postgres_simple.py instead."""

from test_postgres_simple import test_connection


if __name__ == "__main__":
    raise SystemExit(0 if test_connection() else 1)
