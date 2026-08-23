//! UI 偏好持久化（BLF-794）
//!
//! 轻量 JSON 偏好文件，承载跨重启保留的界面状态（当前仅 Sub-Nav 折叠态，
//! 后续阶段的新持久化字段在此扩展）。读写失败一律非致命（记日志 + 回退默认），
//! 不阻塞窗口启动。
//!
//! 存储位置（平台惯例目录 / `believeboy-gui/ui-prefs.json`）：
//! - macOS：`~/Library/Application Support`
//! - Windows：`%APPDATA%`
//! - Linux：`$XDG_CONFIG_HOME` 或 `~/.config`

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// UI 偏好（JSON 持久化；新增字段必须带 `#[serde(default)]` 以兼容旧文件）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct UiPrefs {
    /// BLF-794：Sub-Nav 子导航列是否折叠（重启后保留）
    #[serde(default)]
    pub sub_nav_collapsed: bool,
}

/// 偏好文件完整路径（环境变量缺失时返回 None → 读写静默跳过）
pub fn prefs_path() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("believeboy-gui").join("ui-prefs.json"))
}

/// 平台配置根目录
fn config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
        })
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match std::env::var_os("XDG_CONFIG_HOME") {
            Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
            _ => std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")),
        }
    }
}

/// 读偏好（文件缺失 / 解析失败 → 默认值）
pub fn load_ui_prefs() -> UiPrefs {
    let Some(path) = prefs_path() else {
        return UiPrefs::default();
    };
    load_ui_prefs_from(&path).unwrap_or_default()
}

/// 写偏好（失败只记日志，不 panic）
pub fn save_ui_prefs(prefs: &UiPrefs) {
    if let Some(path) = prefs_path() {
        save_ui_prefs_to(&path, prefs);
    }
}

/// 从指定路径读（测试注入路径用）
pub(crate) fn load_ui_prefs_from(path: &std::path::Path) -> Option<UiPrefs> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(prefs) => Some(prefs),
        Err(e) => {
            tracing::warn!("UI 偏好文件解析失败（回退默认）：{path:?}: {e}");
            None
        }
    }
}

/// 写到指定路径（父目录自动创建；测试注入路径用）
pub(crate) fn save_ui_prefs_to(path: &std::path::Path, prefs: &UiPrefs) {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("UI 偏好目录创建失败：{parent:?}: {e}");
            return;
        }
    }
    match serde_json::to_string_pretty(prefs) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                tracing::warn!("UI 偏好写入失败（折叠状态本次不持久化）：{path:?}: {e}");
            }
        }
        Err(e) => tracing::warn!("UI 偏好序列化失败：{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// serde 往返：默认值与显式值都能无损序列化/反序列化。
    #[test]
    fn ui_prefs_serde_roundtrip() {
        let default_prefs = UiPrefs::default();
        assert!(!default_prefs.sub_nav_collapsed);

        let collapsed = UiPrefs {
            sub_nav_collapsed: true,
        };
        let json = serde_json::to_string(&collapsed).expect("序列化失败");
        let back: UiPrefs = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(back, collapsed);
    }

    /// 旧版本偏好文件缺字段时用 `#[serde(default)]` 兼容（空对象 → 默认值）。
    #[test]
    fn ui_prefs_missing_fields_fall_back_to_defaults() {
        let prefs: UiPrefs = serde_json::from_str("{}").expect("空对象应可解析");
        assert!(!prefs.sub_nav_collapsed);
    }

    /// 文件级往返：写入后再读取应得到同一份偏好（临时目录，不碰真实用户目录）。
    #[test]
    fn save_and_load_roundtrip_via_file() {
        let path = std::env::temp_dir().join(format!(
            "believeboy-gui-prefs-test-{}.json",
            std::process::id()
        ));
        let prefs = UiPrefs {
            sub_nav_collapsed: true,
        };
        save_ui_prefs_to(&path, &prefs);
        let loaded = load_ui_prefs_from(&path).expect("刚写出的文件应可读");
        assert_eq!(loaded, prefs);
        std::fs::remove_file(&path).ok();
    }

    /// 读不存在的文件 → None（调用方回退默认值），不 panic。
    #[test]
    fn load_missing_file_returns_none() {
        let path = std::env::temp_dir().join("believeboy-gui-prefs-definitely-missing.json");
        assert_eq!(load_ui_prefs_from(&path), None);
    }

    /// 解析损坏的文件 → None + 日志（不 panic、不产生半套默认值以外的副作用）。
    #[test]
    fn load_corrupt_file_returns_none() {
        let path = std::env::temp_dir().join(format!(
            "believeboy-gui-prefs-corrupt-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, "not-json{{{").expect("写入测试文件");
        assert_eq!(load_ui_prefs_from(&path), None);
        std::fs::remove_file(&path).ok();
    }
}
