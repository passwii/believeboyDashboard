//! 站点导航（GUI-12 / 2.0）
//!
//! frontend `app/dashboard/operations/site-navigation/page.tsx` 的 GPUI 等价数据层：
//! 7 个平台 / 论坛入口（Amazon / Walmart / SHEIN / TEMU / Etsy / TikTok Shop
//! + AMZ123 资讯论坛），静态硬编码，不调后端。
//!
//! 与 frontend 的映射约定：
//! - `group` 对应 frontend `Platform.group`（`'platform' | 'forum'`）；
//! - `accent_rgb` 来自 frontend `tone` 渐变的首色（如 Amazon `from-[#ff9900]/25` → `(0xff, 0x99, 0x00)`），
//!   GUI 端用它渲染卡片左上渐变 wash（GPUI `linear_gradient` 只支持两端色，取「首色 @ 低透明度 → 透明」近似）。
//!
//! 数据维护约定：与 frontend `site-navigation/page.tsx` 的 `platforms` 数组 1:1 同步
//! （名称 / href / region / category / group / 强调色），前端增减站点时必须同步本模块。

use serde::{Deserialize, Serialize};

/// 入口分组（对应 frontend `Platform.group`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SiteNavGroup {
    /// 跨境电商平台
    Platform,
    /// 资讯论坛（行业信息与工具）
    Forum,
}

/// 单个站点入口（对应 frontend `Platform`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteNavigationItem {
    pub name: String,
    /// 点击后由系统默认浏览器打开的 URL
    pub href: String,
    /// 区域（如 "Global" / "United States" / "China"）
    pub region: String,
    /// 品类（如 "Marketplace" / "Fashion" / "Niche"）
    pub category: String,
    pub group: SiteNavGroup,
    /// 品牌强调色 RGB（frontend `tone` 渐变首色，0xRRGGBB 拆成三元组）
    pub accent_rgb: (u8, u8, u8),
}

impl SiteNavigationItem {
    /// 分组判定（对齐 frontend `platformItems` / `forumItems` 的 filter）
    pub fn is_platform(&self) -> bool {
        self.group == SiteNavGroup::Platform
    }
}

/// 7 个站点入口（与 frontend `site-navigation/page.tsx` 的 `platforms` 数组逐项一致）
pub fn site_navigation_items() -> Vec<SiteNavigationItem> {
    vec![
        SiteNavigationItem {
            name: "Amazon".into(),
            href: "https://www.amazon.com".into(),
            region: "Global".into(),
            category: "Marketplace".into(),
            group: SiteNavGroup::Platform,
            accent_rgb: (0xff, 0x99, 0x00),
        },
        SiteNavigationItem {
            name: "Walmart".into(),
            href: "https://www.walmart.com".into(),
            region: "United States".into(),
            category: "Marketplace".into(),
            group: SiteNavGroup::Platform,
            accent_rgb: (0x00, 0x71, 0xce),
        },
        SiteNavigationItem {
            name: "AMZ123".into(),
            href: "https://www.amz123.com".into(),
            region: "China".into(),
            category: "Media & Tools".into(),
            group: SiteNavGroup::Forum,
            accent_rgb: (0x22, 0xc5, 0x5e),
        },
        SiteNavigationItem {
            name: "SHEIN".into(),
            href: "https://us.shein.com".into(),
            region: "Global".into(),
            category: "Fashion".into(),
            group: SiteNavGroup::Platform,
            accent_rgb: (0x11, 0x18, 0x27),
        },
        SiteNavigationItem {
            name: "TEMU".into(),
            href: "https://www.temu.com".into(),
            region: "Global".into(),
            category: "Marketplace".into(),
            group: SiteNavGroup::Platform,
            accent_rgb: (0xf4, 0x3f, 0x5e),
        },
        SiteNavigationItem {
            name: "Etsy".into(),
            href: "https://www.etsy.com".into(),
            region: "Global".into(),
            category: "Niche".into(),
            group: SiteNavGroup::Platform,
            accent_rgb: (0xf9, 0x73, 0x16),
        },
        SiteNavigationItem {
            name: "TikTok Shop".into(),
            href: "https://www.tiktok.com/shop".into(),
            region: "Global".into(),
            category: "Social Commerce".into(),
            group: SiteNavGroup::Platform,
            accent_rgb: (0x0f, 0x17, 0x2a),
        },
    ]
}

/// 平台分组（6 个；对齐 frontend `platformItems`）
pub fn platform_items() -> Vec<SiteNavigationItem> {
    site_navigation_items()
        .into_iter()
        .filter(SiteNavigationItem::is_platform)
        .collect()
}

/// 资讯论坛分组（1 个；对齐 frontend `forumItems`）
pub fn forum_items() -> Vec<SiteNavigationItem> {
    site_navigation_items()
        .into_iter()
        .filter(|item| !item.is_platform())
        .collect()
}

/// 顶部 stats：平台总数（对齐 frontend `stats[0]` = 平台分组条目数）
pub fn platform_count() -> usize {
    platform_items().len()
}

/// 顶部 stats：资讯论坛数（对齐 frontend `stats[1]` = 论坛分组条目数）
pub fn forum_count() -> usize {
    forum_items().len()
}

/// 顶部 stats：平台类型（对齐 frontend `stats[2]` 静态文案「平台/资讯」）
pub const TYPE_LABEL: &str = "平台/资讯";

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 frontend `platforms` 数组的条目数核对表（2026-08-14 对齐）：
    /// 平台 6（Amazon / Walmart / SHEIN / TEMU / Etsy / TikTok Shop）+ 论坛 1（AMZ123）= 7
    const EXPECTED_PLATFORM_NAMES: &[&str] =
        &["Amazon", "Walmart", "SHEIN", "TEMU", "Etsy", "TikTok Shop"];
    const EXPECTED_FORUM_NAMES: &[&str] = &["AMZ123"];

    #[test]
    fn item_count_matches_frontend() {
        assert_eq!(
            site_navigation_items().len(),
            7,
            "应与 frontend platforms 数组一致（7 项）"
        );
        assert_eq!(platform_items().len(), 6, "平台分组应为 6 个");
        assert_eq!(forum_items().len(), 1, "资讯论坛分组应为 1 个");
        assert_eq!(platform_count(), 6);
        assert_eq!(forum_count(), 1);
        assert_eq!(TYPE_LABEL, "平台/资讯");
    }

    #[test]
    fn group_membership_matches_frontend() {
        let platforms = platform_items();
        let forums = forum_items();
        let platform_names: Vec<&str> = platforms.iter().map(|i| i.name.as_str()).collect();
        let forum_names: Vec<&str> = forums.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(platform_names, EXPECTED_PLATFORM_NAMES);
        assert_eq!(forum_names, EXPECTED_FORUM_NAMES);
    }

    #[test]
    fn names_are_unique() {
        let items = site_navigation_items();
        let mut names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "站点名称不允许重复");
    }

    #[test]
    fn hrefs_are_https() {
        for item in site_navigation_items() {
            assert!(
                item.href.starts_with("https://"),
                "{} 的 href 应为 https 链接，实际 {}",
                item.name,
                item.href
            );
        }
    }

    #[test]
    fn fields_match_frontend_values() {
        let items = site_navigation_items();
        // 抽验 frontend 硬编码值（其余条目由上面 group / href 测试兜底）
        let amazon = items.iter().find(|i| i.name == "Amazon").unwrap();
        assert_eq!(amazon.href, "https://www.amazon.com");
        assert_eq!(amazon.region, "Global");
        assert_eq!(amazon.category, "Marketplace");
        assert_eq!(amazon.accent_rgb, (0xff, 0x99, 0x00));
        assert!(amazon.is_platform());

        let amz123 = items.iter().find(|i| i.name == "AMZ123").unwrap();
        assert_eq!(amz123.href, "https://www.amz123.com");
        assert_eq!(amz123.region, "China");
        assert_eq!(amz123.category, "Media & Tools");
        assert_eq!(amz123.accent_rgb, (0x22, 0xc5, 0x5e));
        assert!(!amz123.is_platform());
    }

    #[test]
    fn serde_roundtrip() {
        let items = site_navigation_items();
        let json = serde_json::to_string(&items).expect("序列化失败");
        let back: Vec<SiteNavigationItem> = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(items, back);
        // group 枚举序列化为可读 tag
        assert!(json.contains("\"Platform\""));
        assert!(json.contains("\"Forum\""));
    }
}
