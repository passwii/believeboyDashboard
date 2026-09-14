import Foundation

/// 「广告 → 广告分析」的一个子 Tab（一个 Tab 对应一个后端端点）。
///
/// 顺序、`key`、`label` 以 `frontend/components/dashboard/ad-analysis/config.ts`
/// （`AD_ANALYSIS_TABS`）为准；`endpoint` 抄自
/// `backend/app/api/v1/endpoints/ad_analysis.py`（router 自带 `Depends(protected)`）。
public struct AdAnalysisTab: Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String
    public let endpoint: String

    public var id: String { key }

    public init(key: String, label: String, endpoint: String) {
        self.key = key
        self.label = label
        self.endpoint = endpoint
    }
}

/// 站点选项（Web `top-filters.tsx` 的 `COUNTRY_OPTIONS`，三选一）。
public struct AdCountryOption: Sendable, Hashable, Identifiable {
    public let code: String
    public let label: String

    public var id: String { code }

    public init(code: String, label: String) {
        self.code = code
        self.label = label
    }
}

/// 「广告分析」页的端点目录与常量。
public enum AdAnalysisCatalog {
    /// Web 路由 —— 同时是 `NavigationItem.id`，也是模块路由表的命中键。
    public static let routeID = "/dashboard/advertising/ad-analysis/overview"

    /// 默认落地的 Tab（Web 的 `/ad-analysis` 重定向到 `/overview`）。
    public static let defaultTabKey = "overview"

    /// 10 个子 Tab，顺序与 Web 的 Tab 栏逐一对应。
    public static let tabs: [AdAnalysisTab] = [
        AdAnalysisTab(key: "overview", label: "总览", endpoint: "/ad-analysis/overview"),
        AdAnalysisTab(key: "time-trend", label: "趋势", endpoint: "/ad-analysis/time-trend"),
        AdAnalysisTab(key: "campaigns", label: "活动", endpoint: "/ad-analysis/campaigns"),
        AdAnalysisTab(key: "products", label: "SKU", endpoint: "/ad-analysis/products"),
        AdAnalysisTab(
            key: "purchased-products",
            label: "已购买商品",
            endpoint: "/ad-analysis/purchased-products"
        ),
        AdAnalysisTab(key: "search-terms", label: "搜索词", endpoint: "/ad-analysis/search-terms"),
        AdAnalysisTab(key: "targets", label: "投放", endpoint: "/ad-analysis/targets"),
        AdAnalysisTab(key: "placements", label: "广告位", endpoint: "/ad-analysis/placements"),
        AdAnalysisTab(key: "budget", label: "预算", endpoint: "/ad-analysis/budget"),
        AdAnalysisTab(
            key: "traffic-quality",
            label: "流量质量",
            endpoint: "/ad-analysis/traffic-quality"
        ),
    ]

    public static func tab(key: String) -> AdAnalysisTab? {
        tabs.first { $0.key == key }
    }

    /// 站点三选一（Web 常量）。
    public static let countries: [AdCountryOption] = [
        AdCountryOption(code: "US", label: "美国站 (US)"),
        AdCountryOption(code: "DE", label: "德国站 (DE)"),
        AdCountryOption(code: "UK", label: "英国站 (UK)"),
    ]

    public static let defaultCountry = "US"

    public static func countryLabel(code: String) -> String {
        countries.first { $0.code == code }?.label ?? code
    }

    /// 项目列表端点。
    ///
    /// 用 `/projects/manage` 而**不是** `/projects`：前者按 `X-Operator` 过滤可见项目
    /// （`backend/app/api/v1/endpoints/projects.py:95`），后者会把别的运营的项目也列出来
    /// —— 仓库 AGENTS.md 已把这条写成约定。
    public static let projectsEndpoint = "/projects/manage"
}
