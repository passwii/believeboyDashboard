"""产品标签制作端点的接口测试。

覆盖：成功路径（页数/尺寸不变、能检出新增文案）、以及所有 fail closed
的负例（非 PDF / 空文件 / 多页 / 纯图形 / 文案超宽 / 未填内容）。
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas

from app.core.config import get_settings
from app.main import app
from app.services import product_label_overlay as M

FNSKU = "X004ABCDEF"
ENDPOINT = "/api/v1/product-label/generate"


# ---------- fixtures ----------


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"X-API-Key": get_settings().api_key}


def make_label(*, extra_pages: int = 0, image_only: bool = False) -> bytes:
    """现场生成单页标签：FNSKU + 两行商品名。"""
    width, height = 4 * 72, 6 * 72
    buf = io.BytesIO()
    page = canvas.Canvas(buf, pagesize=(width, height))
    if image_only:
        page.rect(10, 10, 120, 120, fill=1)
    else:
        page.setFont("Helvetica", 9)
        page.drawString(18, height - 79.9 - 9, FNSKU)
        page.setFont("Helvetica", 8)
        page.drawString(18, height - 100 - 8, "Wireless Bluetooth Earbuds")
        page.drawString(18, height - 110 - 8, "with Charging Case")
    for _ in range(extra_pages):
        page.showPage()
        page.setFont("Helvetica", 8)
        page.drawString(18, height - 100, "second page")
    page.save()
    return buf.getvalue()


# ---------- 成功路径 ----------


def test_generate_returns_pdf_with_added_text(client: TestClient, auth_headers):
    source = make_label()
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", source, "application/pdf")},
        data={"text": "Designed in California", "made_in_china": "true"},
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    assert "label-labeled.pdf" in response.headers["content-disposition"]

    # 页数与尺寸不变
    from pypdf import PdfReader

    source_page = PdfReader(io.BytesIO(source)).pages[0]
    out_page = PdfReader(io.BytesIO(response.content)).pages[0]
    assert (out_page.cropbox.width, out_page.cropbox.height) == (
        source_page.cropbox.width,
        source_page.cropbox.height,
    )

    # 原文与新增文案都在
    texts = " ".join(line.text for line in M.extract_lines(
        response.content, expect_size=(288.0, 432.0)
    ))
    assert FNSKU in texts
    assert "Designed in California" in texts
    assert "Made In China" in texts


def test_generate_made_in_china_only(client: TestClient, auth_headers):
    """只勾 Made In China、不填文案也要能出图。"""
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(), "application/pdf")},
        data={"text": "", "made_in_china": "1"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    texts = " ".join(
        line.text
        for line in M.extract_lines(response.content, expect_size=(288.0, 432.0))
    )
    assert "Made In China" in texts


def test_generate_requires_api_key(client: TestClient):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(), "application/pdf")},
        data={"text": "Hello"},
    )
    assert response.status_code in {401, 403}


# ---------- 负例（fail closed） ----------


def test_rejects_non_pdf_extension(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.txt", make_label(), "application/pdf")},
        data={"text": "Hello"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "PDF" in response.json()["detail"]


def test_rejects_non_pdf_content(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", b"not really a pdf", "application/pdf")},
        data={"text": "Hello"},
        headers=auth_headers,
    )
    assert response.status_code == 400


def test_rejects_empty_file(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", b"", "application/pdf")},
        data={"text": "Hello"},
        headers=auth_headers,
    )
    assert response.status_code == 400


def test_rejects_multi_page(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(extra_pages=1), "application/pdf")},
        data={"text": "Hello"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "单页" in response.json()["detail"]


def test_rejects_image_only_label(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(image_only=True), "application/pdf")},
        data={"text": "Hello"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "文字" in response.json()["detail"]


def test_rejects_when_nothing_to_add(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(), "application/pdf")},
        data={"text": "   ", "made_in_china": "false"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "至少填写" in response.json()["detail"]


def test_rejects_oversize_text(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(), "application/pdf")},
        data={"text": "x" * (M.MAX_TEXT_CHARS + 1)},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "过长" in response.json()["detail"]


def test_rejects_text_too_wide_for_label(client: TestClient, auth_headers):
    response = client.post(
        ENDPOINT,
        files={"file": ("label.pdf", make_label(), "application/pdf")},
        data={"text": "A" * 60},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "过宽" in response.json()["detail"]
