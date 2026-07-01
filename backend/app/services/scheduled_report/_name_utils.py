"""Length-safe display/filename helpers for project_name in scheduled reports.

Multi-project subscriptions (e.g. project with multiple stores) can produce
very long combined project names like ``"店铺A, 店铺B, 店铺C, ..."``. We cap:

- Email subject ``project_name`` segment to RFC 5322 friendly length.
- Attachment filename segment to a length that's safe across Windows / macOS
  / Linux filesystems and R2 storage limits.

Both helpers are pure and side-effect free; safe to call from any thread.
"""

from __future__ import annotations

# RFC 5322 软上限：邮件主题建议 ≤ 78 字符（兼容老 IMAP/移动客户端的折叠）。
SUBJECT_MAX_LEN = 78

# 附件名（不含扩展名）安全长度：留余量给频率/日期/扩展名；Win/macOS 普遍 255 限制。
FILENAME_MAX_LEN = 120

# 截断提示符（避免与项目名里的字符冲突）。
_ELLIPSIS = "…"

# 文件名非法字符（Windows 严格集合 + Linux 控制字符）。
_FILENAME_BAD_CHARS = set('/\\:*?"<>|\r\n\t')


def _truncate_segment(segment: str, max_len: int) -> str:
    """按字符截断到 max_len；不足时原样返回。

    注意：是字符数截断，不是字节数截断。中文字符按 1 字符算（在 78 字符上限
    下 UTF-8 编码最长约 234 字节，远低于 RFC 5322 硬上限 998 字节）。
    """
    if len(segment) <= max_len:
        return segment
    return segment[: max_len - 1] + _ELLIPSIS


def truncate_project_name_for_subject(project_name: str) -> str:
    """邮件主题里嵌入的 project_name 长度保护。"""
    return _truncate_segment(project_name, SUBJECT_MAX_LEN)


def sanitize_filename_segment(segment: str) -> str:
    """清理文件名非法字符 + 长度截断。

    用于邮件附件名拼接（``{freq_label}报告_{project_name}_{country}_{date}.png``）。
    """
    clean = "".join("_" if c in _FILENAME_BAD_CHARS else c for c in segment).strip()
    return _truncate_segment(clean, FILENAME_MAX_LEN)