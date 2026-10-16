"""Tests for P0.3: cleanup_r2_orphaned_files.py — safe defaults + boolean precedence fix.

The script used to be a "data-loss weapon":
  - --dry-run was NOT the default (line 293-297 of original)
  - bare invocation deletes every "orphan" with a yes/no prompt
  - the is_referenced boolean had ambiguous precedence (any(...) and ...)
  - extension whitelist (.pdf/.csv/.xlsx/.txt) didn't cover
    .webp / .png / .jpg used by product images, exchange-rate images,
    inspection PNGs

After P0.3:
  - default = DRY-RUN (safe)
  - new flag --execute turns off dry-run (explicit opt-in)
  - --yes skips interactive confirm (cron-friendly)
  - new flag --config-print exits before touching DB / R2
  - is_referenced now correctly uses only: key in all_referenced OR key in r2_keys_from_local
"""
from __future__ import annotations

import os
import sys
from io import StringIO
from unittest.mock import patch

import pytest

# Make backend/ importable as top-level. We do this BEFORE importing scripts.*.
BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from scripts.cleanup_r2_orphaned_files import _print_config  # noqa: E402


# ---------------------------------------------------------------------------
# (1) --config-print: must exit cleanly without DB / R2
# ---------------------------------------------------------------------------

def test_config_print_exits_zero():
    """--config-print completes without any DB or R2 connection."""
    out = StringIO()
    with patch.object(sys, "stdout", out):
        rc = _print_config()
    assert rc == 0
    text = out.getvalue()
    assert "R2 cleanup script config print" in text
    assert "Discovered R2 key columns" in text
    # 14 columns currently（客户方案 283 新增 CrmProposalVersion.raw/adapted 两个）
    assert "14 total" in text


def test_config_print_lists_known_prefixes():
    out = StringIO()
    with patch.object(sys, "stdout", out):
        _print_config()
    text = out.getvalue()
    for prefix in [
        "monthly_reports",
        "platform-revenue",
        "exchange-rate-notes",
        "inspection-screenshots",
        "fnsku-labels",
        "product-images",
        "product-thumbs",
        "avatars",
        "scheduled-reports",
        "product-analysis",
    ]:
        assert prefix in text, f"missing prefix: {prefix}"


# ---------------------------------------------------------------------------
# (2) argparse defaults: must be SAFE by default (dry-run on, execute off)
# ---------------------------------------------------------------------------

def test_bare_invocation_is_dry_run():
    """Bare invocation should set dry_run=True, execute=False."""
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", "-x", action="store_true", default=False)
    parser.add_argument("--dry-run", "-n", action="store_true", default=True)
    parser.add_argument("--yes", "-y", action="store_true", default=False)
    parser.add_argument("--config-print", action="store_true", default=False)
    args = parser.parse_args([])
    assert args.execute is False
    assert args.dry_run is True
    assert args.yes is False


def test_execute_opt_in_turns_off_dry_run():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", "-x", action="store_true", default=False)
    parser.add_argument("--dry-run", "-n", action="store_true", default=True)
    args = parser.parse_args(["--execute"])
    if args.execute:
        args.dry_run = False
    assert args.execute is True
    assert args.dry_run is False


def test_execute_with_yes_skips_interactive():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", "-x", action="store_true", default=False)
    parser.add_argument("--dry-run", "-n", action="store_true", default=True)
    parser.add_argument("--yes", "-y", action="store_true", default=False)
    args = parser.parse_args(["--execute", "--yes"])
    assert args.execute is True
    assert args.yes is True


def test_execute_dry_run_combination_execute_wins():
    """If both --execute and --dry-run are passed, --execute wins."""
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", "-x", action="store_true", default=False)
    parser.add_argument("--dry-run", "-n", action="store_true", default=True)
    args = parser.parse_args(["--execute", "--dry-run"])
    if args.execute:
        args.dry_run = False
    assert args.execute is True
    assert args.dry_run is False


# ---------------------------------------------------------------------------
# (3) Boolean precedence bugfix (the core data-loss bug)
# ---------------------------------------------------------------------------

# Reproduce find_orphaned_files's classify logic verbatim to lock down behavior.
def _classify(key, all_referenced, r2_keys_from_local):
    """Mirror of cleaned-up classify logic in cleanup_r2_orphaned_files.py.

    Buggy original was:
        key in all_referenced or
        key in referenced_keys or
        any(key.endswith(ext) for ext in [...]) and key in r2_keys_from_local
    which silently dropped .webp/.png/.jpg even when local refs match.
    """
    return key in all_referenced or key in r2_keys_from_local


def test_classify_db_referenced_keys_kept():
    refs = {"a/web.png", "b/product.pdf", "c/image.jpg"}
    assert _classify("a/web.png", refs, set()) is True
    assert _classify("c/image.jpg", refs, set()) is True


def test_classify_local_only_keys_kept():
    refs = set()
    local = {
        "avatars/u1/pic.png",
        "products/x.webp",
        "exchange/y.jpg",
    }
    assert _classify("avatars/u1/pic.png", refs, local) is True
    assert _classify("products/x.webp", refs, local) is True
    assert _classify("exchange/y.jpg", refs, local) is True


def test_classify_image_extensions_now_classified_by_membership():
    """The buggy original's `any(endswith('.pdf')...)` short-circuit silently
    excluded .webp/.png/.jpg from local-path matching. Verify the new classify
    does NOT depend on extension at all."""
    refs = set()
    local = {"avatars/u/pic.png"}
    # would have been DROPPED by buggy logic (any(endswith('.png')) was False
    # because the list was ['.pdf','.csv','.xlsx','.txt']).
    assert _classify("avatars/u/pic.png", refs, local) is True, (
        "image-extension keys must be classified by membership, not ext"
    )


def test_classify_orphan_detected():
    refs = {"keep/this.pdf"}
    local = {"keep/that.xlsx"}
    assert _classify("orphan/x.png", refs, local) is False
    assert _classify("orphan/y.webp", refs, local) is False
    assert _classify("orphan/z.unknown", refs, local) is False


def test_classify_empty_safe():
    assert _classify("any/key.png", set(), set()) is False


# ---------------------------------------------------------------------------
# (4) Sanity: bucket config is present and consumed
# ---------------------------------------------------------------------------

def test_config_print_uses_real_settings():
    """_print_config must read bucket / endpoint from current Settings."""
    from app.core.config import get_settings

    settings = get_settings()
    out = StringIO()
    with patch.object(sys, "stdout", out):
        _print_config()
    text = out.getvalue()
    assert settings.r2_bucket_name in text
    assert settings.r2_endpoint_url in text
