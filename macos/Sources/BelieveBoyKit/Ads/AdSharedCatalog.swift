import Foundation

/// 广告两页共用的小目录：站点选项与项目列表端点。
public enum AdSharedCatalog {
    /// 项目列表端点。
    ///
    /// 用 `/projects/manage` 而**不是** `/projects`：前者按 `X-Operator` 过滤可见项目
    /// （`backend/app/api/v1/endpoints/projects.py`），后者会把别的运营的项目也列出来
    /// —— 仓库 AGENTS.md 已把这条写成约定。
    public static let projectsEndpoint = "/projects/manage"
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

/// 站点三选一（广告分析 / 广告数据两页共用同一组常量）。
public enum AdCountries {
    public static let all: [AdCountryOption] = [
        AdCountryOption(code: "US", label: "美国站 (US)"),
        AdCountryOption(code: "DE", label: "德国站 (DE)"),
        AdCountryOption(code: "UK", label: "英国站 (UK)"),
    ]

    public static let defaultCode = "US"

    public static func label(code: String) -> String {
        all.first { $0.code == code }?.label ?? code
    }
}
