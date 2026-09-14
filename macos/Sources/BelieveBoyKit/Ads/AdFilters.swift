import Foundation

/// 广告两页（「广告分析」/「广告数据」）**共用**的筛选条取值：项目 / 站点 / 日期区间。
///
/// 为什么值得抽出来共享而不是各页一份：两页的筛选条是同一个控件（项目 / 站点 / 日期区间），
/// 口径也必须一致 —— 尤其是「日期区间关掉时到底发不发日期参数」。各写一份的必然结果是两页
/// 在某个边缘分支（清空日期、空白串）上悄悄分叉，而这两页正是要拿去与 Web 逐值对照的。
///
/// 日期语义的**差异**留在各页的查询构造里（不是筛选条里）：
/// - 广告分析：`effectiveDateFrom == nil` → 查询里根本不带 `date_from` / `date_to`，
///   后端据此聚合全量历史（`AdAnalysisQuery`）；
/// - 广告数据：`period` 是必填的，不传就被 400 拒 —— 故 `nil` 要落到哨兵窗口
///   （`AdDataQuery` 的 `2000-01-01 ~ 2100-12-31`）。
///
/// 两页都只放**一个**日期开关：关掉即「未限定日期」，落到查询上是上面两种不同写法。
public struct AdFilters: Equatable, Sendable {
    public var projectID: Int?
    public var country: String
    /// 「按日期筛选」开关。**默认关闭**（两页的默认落地口径都是「不限定日期」）。
    public var usesDateRange: Bool
    public var dateFrom: String?
    public var dateTo: String?

    public init(
        projectID: Int? = nil,
        country: String = AdCountries.defaultCode,
        usesDateRange: Bool = false,
        dateFrom: String? = nil,
        dateTo: String? = nil
    ) {
        self.projectID = projectID
        self.country = country
        self.usesDateRange = usesDateRange
        self.dateFrom = dateFrom
        self.dateTo = dateTo
    }

    /// 真正会发出去的日期下界（未启用日期区间时为 nil）。
    public var effectiveDateFrom: String? { usesDateRange ? dateFrom : nil }

    /// 真正会发出去的日期上界（未启用日期区间时为 nil）。
    public var effectiveDateTo: String? { usesDateRange ? dateTo : nil }

    /// 查询签名（决定「这次筛选是否已经加载过」）。
    public var signature: AdQuerySignature {
        AdQuerySignature(
            projectID: projectID,
            country: country,
            dateFrom: effectiveDateFrom,
            dateTo: effectiveDateTo
        )
    }
}

/// 一次查询的筛选签名（不含具体的页内维度，如广告分析的 Tab / 广告数据的报表类型）。
///
/// 只承载「会不会改变后端返回的那几个输入」：项目 / 站点 / 日期区间。页内维度（Tab、
/// 报表类型）由各自的 store 单独记，因为它们的缓存粒度不同。
public struct AdQuerySignature: Equatable, Sendable {
    public let projectID: Int?
    public let country: String
    public let dateFrom: String?
    public let dateTo: String?

    public init(projectID: Int?, country: String, dateFrom: String?, dateTo: String?) {
        self.projectID = projectID
        self.country = country
        self.dateFrom = dateFrom
        self.dateTo = dateTo
    }
}
