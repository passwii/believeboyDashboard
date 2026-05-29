"""FNSKU label PDF verification service.

Extracts FNSKU barcodes/strings from uploaded Amazon label PDFs
and compares them against the expected FNSKU stored in the database.
"""

from __future__ import annotations

import re
from typing import Any

import pdfplumber


# ── FNSKU pattern ──────────────────────────────────────────────────────────
# Amazon FNSKU format: starts with X00 (or X0, X1, X2, etc.), followed by
# alphanumeric chars, total length ~10-12 chars.
# Also accepts plain "FNSKU: <value>" labels commonly printed on the sticker.
_FNSKU_PATTERN = re.compile(
    r"\b(X\d{2}[0-9A-Z]{7,10})\b",
    re.IGNORECASE,
)
_FNSKU_LABEL_PATTERN = re.compile(
    r"FNSKU[:\s]*([0-9A-Z]{10,14})",
    re.IGNORECASE,
)


def extract_fnsku_from_pdf(pdf_bytes: bytes) -> list[str]:
    """Extract all FNSKU candidates from a PDF file.

    Uses pdfplumber to extract text from every page, then scans for
    FNSKU-like strings using two regex strategies:
      1. "FNSKU: <value>" label (highest confidence)
      2. Standalone X-prefixed codes (medium confidence)

    Returns:
        Deduplicated list of uppercase FNSKU strings found.
    """
    candidates: list[str] = []

    try:
        with pdfplumber.open(
            __import__("io").BytesIO(pdf_bytes)
        ) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                if not text:
                    continue

                # Strategy 1: explicit "FNSKU: XXXXX" labels
                for m in _FNSKU_LABEL_PATTERN.finditer(text):
                    val = m.group(1).strip().upper()
                    if val not in candidates:
                        candidates.append(val)

                # Strategy 2: X-prefixed codes (skip if already found via strategy 1)
                if not candidates:
                    for m in _FNSKU_PATTERN.finditer(text):
                        val = m.group(1).strip().upper()
                        if val not in candidates:
                            candidates.append(val)
    except Exception:
        # PDF parsing failure is non-fatal — we just can't verify
        pass

    return candidates


def verify_fnsku_label(
    pdf_bytes: bytes,
    expected_fnsku: str | None,
) -> dict[str, Any]:
    """Verify that a FNSKU label PDF matches the expected FNSKU.

    Args:
        pdf_bytes: Raw PDF file content.
        expected_fnsku: The FNSKU value stored in the database (may be None/empty).

    Returns:
        dict with keys:
          - verified: bool — True if a match was confirmed
          - fnsku_found: str | None — the FNSKU found in the PDF (if any)
          - message: str — human-readable explanation
    """
    found_fnskus = extract_fnsku_from_pdf(pdf_bytes)

    if not found_fnskus:
        return {
            "verified": False,
            "fnsku_found": None,
            "message": "PDF 中未识别到 FNSKU 信息，标签已上传但未验证",
        }

    # No expected FNSKU in DB — we can't verify, but report what we found
    if not expected_fnsku or not expected_fnsku.strip():
        return {
            "verified": False,
            "fnsku_found": found_fnskus[0],
            "message": (
                f"SKU 记录中无 FNSKU 字段，无法校验。"
                f"PDF 中识别到: {', '.join(found_fnskus)}"
            ),
        }

    expected = expected_fnsku.strip().upper()
    found_upper = [f.upper() for f in found_fnskus]

    if expected in found_upper:
        return {
            "verified": True,
            "fnsku_found": expected,
            "message": f"FNSKU 验证通过: {expected}",
        }

    return {
        "verified": False,
        "fnsku_found": found_fnskus[0],
        "message": (
            f"FNSKU 不匹配！"
            f"SKU 记录期望: {expected}，"
            f"PDF 中识别到: {', '.join(found_fnskus)}"
        ),
    }
