"""Agent 文件型成功响应契约。"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.agent.file_response import agent_file_response


def test_agent_file_response_returns_raw_bytes_and_download_headers():
    payload = b"\x00\xffPK-workbook-content"
    app = FastAPI()

    @app.get("/file")
    def get_file():
        return agent_file_response(
            payload,
            filename="货件 模板.xlsx",
            media_type=(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
        )

    response = TestClient(app).get("/file")

    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert response.headers["content-length"] == str(len(payload))
    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    assert "filename*=UTF-8''%E8%B4%A7%E4%BB%B6%20%E6%A8%A1%E6%9D%BF.xlsx" in disposition
    assert "货件 模板.xlsx" not in disposition


def test_agent_file_response_sanitizes_ascii_fallback_filename():
    app = FastAPI()

    @app.get("/file")
    def get_file():
        return agent_file_response(
            b"file",
            filename='报价"版\\本\r\n.xlsx',
            media_type="application/octet-stream",
        )

    response = TestClient(app).get("/file")

    disposition = response.headers["content-disposition"]
    fallback = disposition.split('filename="', 1)[1].split('"', 1)[0]
    assert '"' not in fallback
    assert "\\" not in fallback
    assert "\r" not in disposition
    assert "\n" not in disposition
    assert "%0D" not in disposition
    assert "%0A" not in disposition


def test_agent_file_response_accepts_lazily_streamed_chunks():
    app = FastAPI()

    @app.get("/file")
    def get_file():
        return agent_file_response(
            (chunk for chunk in (b"first", b"second")),
            filename="archive.zip",
            media_type="application/zip",
        )

    response = TestClient(app).get("/file")

    assert response.content == b"firstsecond"
    assert "content-length" not in response.headers
