//! macOS Keychain 会话存储
//!
//! 用 `keyring`（apple-native）把登录成功后的会话持久化到 Keychain：
//!
//! - service = `believeboy-gui`
//! - account = `default`
//!
//! 存的是 `LoginResponse` 的 JSON（含 session_id / user_id / email），
//! 重启 App 时据此重建已登录客户端，跳过登录。
//!
//! 约定：**任何 Keychain 失败都不允许让 App 崩溃** —— 调用方自行兜底降级。

use gui_domain::auth::LoginResponse;

pub const KEYCHAIN_SERVICE: &str = "believeboy-gui";
pub const KEYCHAIN_ACCOUNT: &str = "default";

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// 保存会话（覆盖写）。失败返回带上下文的错误信息。
pub fn save_session(resp: &LoginResponse) -> Result<(), String> {
    let json = serde_json::to_string(resp).map_err(|e| format!("会话序列化失败: {e}"))?;
    entry()
        .and_then(|e| e.set_password(&json))
        .map_err(|e| format!("Keychain 写入失败（service={KEYCHAIN_SERVICE}）: {e}"))
}

/// 读取会话。未存过返回 `Ok(None)`；Keychain 自身错误返回 `Err`。
pub fn load_session() -> Result<Option<LoginResponse>, String> {
    let json = match entry().and_then(|e| e.get_password()) {
        Ok(json) => json,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => {
            return Err(format!(
                "Keychain 读取失败（service={KEYCHAIN_SERVICE}）: {e}"
            ))
        }
    };
    let resp: LoginResponse =
        serde_json::from_str(&json).map_err(|e| format!("Keychain 会话数据损坏: {e}"))?;
    Ok(Some(resp))
}

/// 删除会话（退出登录 / 会话失效时调用）。条目不存在视为成功。
pub fn clear_session() -> Result<(), String> {
    match entry().and_then(|e| e.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain 删除失败: {e}")),
    }
}

/// 「记住密码」凭据（登录页勾选后持久化；明文仅进系统凭据库，取消勾选即清除）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RememberedLogin {
    pub email: String,
    pub password: String,
}

/// 记住密码条目（service 同会话条目，account 区分）
const KEYCHAIN_REMEMBERED_ACCOUNT: &str = "remembered";

fn remembered_entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_REMEMBERED_ACCOUNT)
}

/// 保存记住密码（覆盖写；登录成功且勾选时调用）
pub fn save_remembered(email: &str, password: &str) -> Result<(), String> {
    let json = serde_json::to_string(&RememberedLogin {
        email: email.to_string(),
        password: password.to_string(),
    })
    .map_err(|e| format!("记住密码序列化失败: {e}"))?;
    remembered_entry()
        .and_then(|e| e.set_password(&json))
        .map_err(|e| format!("Keychain 写入失败（记住密码）: {e}"))
}

/// 读取记住密码。未存过返回 `Ok(None)`；Keychain 自身错误返回 `Err`。
pub fn load_remembered() -> Result<Option<RememberedLogin>, String> {
    let json = match remembered_entry().and_then(|e| e.get_password()) {
        Ok(json) => json,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(format!("Keychain 读取失败（记住密码）: {e}")),
    };
    let resp: RememberedLogin =
        serde_json::from_str(&json).map_err(|e| format!("Keychain 记住密码数据损坏: {e}"))?;
    Ok(Some(resp))
}

/// 清除记住密码（取消勾选后下次登录成功时调用）。条目不存在视为成功。
pub fn clear_remembered() -> Result<(), String> {
    match remembered_entry().and_then(|e| e.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain 删除失败（记住密码）: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::auth::UserRoleType;

    /// 纯逻辑单测：不触碰真实 Keychain，只验证 JSON 编解码往返
    #[test]
    fn remembered_json_round_trip() {
        let orig = RememberedLogin {
            email: "demo@believeboy.com".into(),
            password: "p@ss 词".into(),
        };
        let json = serde_json::to_string(&orig).unwrap();
        let back: RememberedLogin = serde_json::from_str(&json).unwrap();
        assert_eq!(back, orig);
    }

    fn session_json_round_trip() {
        let resp = LoginResponse {
            id: "u_1".into(),
            name: "测试".into(),
            email: "demo@believeboy.com".into(),
            operator_name_zh: None,
            is_admin: false,
            is_active: true,
            role_type: UserRoleType::Admin,
            session_id: "sess_abc".into(),
            api_key: String::new(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: LoginResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back, resp);
    }
}
