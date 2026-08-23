//! 站内通知领域类型（BLF-797 Footer 未读徽标）
//!
//! 字段对齐 backend `backend/app/schemas/notification.py` 与
//! `backend/app/api/v1/endpoints/notifications.py`；轮询行为对齐 web 端
//! `frontend/components/notifications/server-notifications-context.tsx`
//! （30s 一次 unread-count）。

use serde::{Deserialize, Serialize};

/// `GET /api/v1/notifications/unread-count` 响应
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationUnreadCount {
    /// 当前用户未读通知数（`Notification.read == False` 的行数）
    pub count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反序列化契约：snake_case 直通，仅 count 一个字段
    #[test]
    fn unread_count_parses_backend_shape() {
        let parsed: NotificationUnreadCount =
            serde_json::from_str(r#"{"count": 7}"#).expect("解析失败");
        assert_eq!(parsed.count, 7);
    }
}
