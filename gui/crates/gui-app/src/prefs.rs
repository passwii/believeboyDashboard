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

/// UI 偏好（JSON 持久化；容器级 `#[serde(default)]`——缺字段按 [`UiPrefs::default`]
/// 回填，新增字段自动兼容旧文件）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiPrefs {
    /// BLF-794：Sub-Nav 子导航列是否折叠（重启后保留）
    #[serde(default)]
    pub sub_nav_collapsed: bool,
    /// BLF-795：Console Bar 筛选状态（项目/站点/日期；重启后还原，对齐 web 端
    /// 「筛选写 URL query 刷新还原」的桌面等价物）
    #[serde(default)]
    pub console_filter: Option<ConsoleFilterPrefs>,
    /// BLF-796：右侧 Inspector 抽屉可见性（默认展开；未注册形态页面自动隐藏
    /// 入口，该偏好仅记录用户显式开合意图）
    pub inspector_visible: bool,
    /// BLF-796：Inspector 拖拽调宽记忆（整数 px，280~340；None = 默认 300）
    pub inspector_width: Option<u16>,
    /// BLF-799：Pattern B 双轴画布分割比例（per-mille，400~500 = 图表区占
    /// 40%~50%；None = 默认 450）。广告分析页为首个消费方，后续 Pattern B
    /// 页面如需独立比例再按页面 key 扩展。
    pub analysis_chart_ratio: Option<u16>,
    /// BLF-800：Pattern C 会话置顶列表（AI Chat 首个消费方；后端无置顶字段，
    /// 属 GUI 本地偏好，重启保留）
    #[serde(default)]
    pub chat_pinned_conversations: Vec<i64>,
    /// BLF-800：Pattern C 右上下文栏是否收起（默认展开）
    #[serde(default)]
    pub chat_context_collapsed: bool,
    /// BLF-830：界面密度三档（compact/standard/relaxed 的字符串 key；
    /// 缺省/未知值回退标准档——字符串协议避免旧文件炸解析）
    #[serde(default)]
    pub density: Option<String>,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            sub_nav_collapsed: false,
            console_filter: None,
            // Inspector 默认展开（交易终端风格：常驻上下文面板）
            inspector_visible: true,
            inspector_width: None,
            analysis_chart_ratio: None,
            chat_pinned_conversations: Vec::new(),
            chat_context_collapsed: false,
            density: None,
        }
    }
}

/// BLF-795：Console Bar 筛选持久化值（日期存 ISO `YYYY-MM-DD` 字符串，
/// 避免为偏好文件引入 chrono serde 依赖；解析失败按缺省处理）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ConsoleFilterPrefs {
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
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
        assert!(default_prefs.console_filter.is_none());

        let prefs = UiPrefs {
            sub_nav_collapsed: true,
            console_filter: Some(ConsoleFilterPrefs {
                project_id: Some(7),
                country: Some("US".into()),
                date_from: Some("2026-08-01".into()),
                date_to: Some("2026-08-15".into()),
            }),
            // BLF-796：Inspector 开合与宽度记忆一并持久化
            inspector_visible: false,
            inspector_width: Some(320),
            // BLF-799：Pattern B 分割比例记忆一并持久化（per-mille 400~500）
            analysis_chart_ratio: Some(470),
        // BLF-800：Pattern C 置顶会话与右栏收起态一并持久化
        chat_pinned_conversations: vec![7, 11],
        chat_context_collapsed: true,
        // BLF-830：密度档位一并持久化（宽松档示例）
        density: Some("relaxed".into()),
    };
        let json = serde_json::to_string(&prefs).expect("序列化失败");
        let back: UiPrefs = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(back, prefs);
    }

    /// BLF-795：旧版本偏好文件（只有 sub_nav_collapsed）解析后 console_filter 为
    /// None，不破坏向后兼容。
    #[test]
    fn ui_prefs_legacy_file_without_console_filter() {
        let prefs: UiPrefs =
            serde_json::from_str(r#"{"sub_nav_collapsed": true}"#).expect("旧格式应可解析");
        assert!(prefs.sub_nav_collapsed);
        assert!(prefs.console_filter.is_none());
    }

    /// 旧版本偏好文件缺字段时按 `Default::default()` 兼容（空对象 → 默认值）。
    #[test]
    fn ui_prefs_missing_fields_fall_back_to_defaults() {
        let prefs: UiPrefs = serde_json::from_str("{}").expect("空对象应可解析");
        assert!(!prefs.sub_nav_collapsed);
        // BLF-796：Inspector 默认展开、默认宽（None = 300 锚点）
        assert!(prefs.inspector_visible);
        assert!(prefs.inspector_width.is_none());
        // BLF-799：Pattern B 分割比例缺省（None = 模板默认 45%）
        assert!(prefs.analysis_chart_ratio.is_none());
        // BLF-800：Pattern C 置顶列表缺省为空、右栏默认展开
        assert!(prefs.chat_pinned_conversations.is_empty());
        assert!(!prefs.chat_context_collapsed);
        // BLF-830：密度缺省为标准档（None → 调用方回退）
        assert!(prefs.density.is_none());
    }

    /// BLF-830：旧版偏好文件无 density 字段时正常解析；未知密度值保留原样
    ///（解析归组合根，文件层只存字符串——保证协议向前兼容）。
    #[test]
    fn ui_prefs_legacy_file_without_density() {
        let prefs: UiPrefs =
            serde_json::from_str(r#"{"sub_nav_collapsed": true}"#).expect("旧格式应可解析");
        assert!(prefs.density.is_none(), "旧文件无 density 字段应落 None");

        let prefs: UiPrefs = serde_json::from_str(r#"{"density": "relaxed"}"#).expect("应可解析");
        assert_eq!(prefs.density.as_deref(), Some("relaxed"));
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
            ..UiPrefs::default()
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
