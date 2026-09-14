import Foundation

// MARK: - 动态值（`list[dict]` 元素）
// MARK: - 动态值（`list[dict]` 元素）

/// ad-analysis 响应里 `list[dict[str, object]]` 元素的**动态值** —— 就是 `JSONValue`。
///
/// 早前这里定义过一个形状完全相同的枚举（`AdAnalysisValue`），S5.2 的广告数据页也要解同类的
/// 动态行（`list[dict[str, object]]`，行内还有一整列 `raw_row`），两者因此收敛到一个类型
/// （BLF-1057 的收敛项）：同一个「任意 JSON 值」在代码库里只应该有一份实现 —— 两份的差异只会
/// 在解码顺序 / 取值助手这类地方悄悄分叉。取值助手（`text` / `number`）现在挂在 `JSONValue`
/// 上，行为与本类型收敛前逐字一致（`JSONValueTests` + `AdAnalysisDecodingTests` 双向钉住）。
///
/// 为什么动态解析而不是逐 Tab 写一套强类型模型：后端这 10 个端点的行形状由各
/// `build_*` 服务函数拼装（`backend/app/services/ad/*.py`），Pydantic 侧一律声明为
/// `list[dict[str, object]]`（`backend/app/schemas/ad_analysis.py`）—— 契约层面就
/// 没有逐字段的名字与类型。硬写强类型模型等于把「我猜的字段名」当契约，字段改名时
/// 编译器不报错、解码器也不报错（可选字段一律 nil），只会静默少一列数据。
/// 因此这一层照实保存后端给的名字与值，测试用**真实响应快照**逐个 Tab 钉住取值。
///
/// 键名不做 snake→camel 变换：`APIClient` 的 `convertFromSnakeCase` 只作用于**结构体
/// 属性**对应的键，`[String: AdAnalysisValue]` 这种字典型解码保留原样（实测，
/// 见 `AdAnalysisDecodingTests.testRowKeysKeepSnakeCaseInDictionaryDecoding`）——
/// 所以这里读 `sales_7d` / `budget_utilization_rate` 等后端原字段名。
public typealias AdAnalysisValue = JSONValue

// MARK: - 动态行

/// 一条动态行（`items` / `summary` / `top_campaigns` 等列表的元素）—— 就是 `DynamicJSONRow`。
///
/// 与广告数据页的原始行是同一个东西：都是「形状由后端决定的一行」，取值助手（`string` /
/// `nonEmptyString` / `number` / `int` / `strings`）现在只有一份实现。
public typealias AdAnalysisRow = DynamicJSONRow

// MARK: - 强类型卡片（后端 schema 里确实有名字与类型的部分）

/// KPI 磁贴（`overview.metrics`）。
///
/// `display_value` 是后端算好的展示串（`$6,872.17` / `0.57%` / `48`），Web 的 KPI 磁贴
/// 直接显示它而不是自己格式化 —— 桌面端同口径，避免两端各自四舍五入出不同的数。
public struct AdAnalysisMetricCard: Sendable, Equatable, Decodable {
    public let label: String
    public let value: Double
    public let displayValue: String
    public let helper: String?

    public init(label: String, value: Double, displayValue: String, helper: String? = nil) {
        self.label = label
        self.value = value
        self.displayValue = displayValue
        self.helper = helper
    }
}

/// 摘要卡（`campaigns` / `products` / `budget` / … 的 `summary_cards`）。
///
/// `value` 是**字符串**（后端已格式化，如 `"1020"` / `"$6,872.17"`）。
public struct AdAnalysisSummaryCard: Sendable, Equatable, Decodable {
    public let label: String
    public let value: String
    public let helper: String?

    public init(label: String, value: String, helper: String? = nil) {
        self.label = label
        self.value = value
        self.helper = helper
    }
}

/// 风险提醒卡（`overview.issue_cards`）。
public struct AdAnalysisIssueCard: Sendable, Equatable, Decodable {
    public let title: String
    public let level: String
    public let summary: String
    public let drillTo: String?
    public let nextStep: String?

    public init(
        title: String,
        level: String,
        summary: String,
        drillTo: String? = nil,
        nextStep: String? = nil
    ) {
        self.title = title
        self.level = level
        self.summary = summary
        self.drillTo = drillTo
        self.nextStep = nextStep
    }
}

/// 结构化分析段落（`narrative_sections`）。
public struct AdAnalysisNarrativeSection: Sendable, Equatable, Decodable {
    public let title: String
    public let summary: String
    public let evidence: [String]
    public let action: String?
    public let drillTo: String?

    public init(
        title: String,
        summary: String,
        evidence: [String] = [],
        action: String? = nil,
        drillTo: String? = nil
    ) {
        self.title = title
        self.summary = summary
        self.evidence = evidence
        self.action = action
        self.drillTo = drillTo
    }

    private enum CodingKeys: String, CodingKey {
        case title, summary, evidence, action, drillTo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        summary = try container.decode(String.self, forKey: .summary)
        evidence = try container.decodeIfPresent([String].self, forKey: .evidence) ?? []
        action = try container.decodeIfPresent(String.self, forKey: .action)
        drillTo = try container.decodeIfPresent(String.self, forKey: .drillTo)
    }
}

/// 周期对比（`overview.comparison` / `time-trend.comparison`）。
///
/// 后端在**没传日期**时返回 `null` —— 没有可比区间，`build_previous_period` 无从取值。
/// 桌面端照实显示「无对比数据」，不自造一个「最近 7 天」当基准（口径 1）。
public struct AdAnalysisPeriodComparison: Sendable, Equatable, Decodable {
    public let currentStart: String?
    public let currentEnd: String?
    public let previousStart: String?
    public let previousEnd: String?
    public let spendChangeRatio: Double?
    public let clicksChangeRatio: Double?
    public let salesChangeRatio: Double?
    public let ordersChangeRatio: Double?
    public let cpcChangeRatio: Double?
    public let acosChangeRatio: Double?
    public let summary: String?

    public init(
        currentStart: String? = nil,
        currentEnd: String? = nil,
        previousStart: String? = nil,
        previousEnd: String? = nil,
        spendChangeRatio: Double? = nil,
        clicksChangeRatio: Double? = nil,
        salesChangeRatio: Double? = nil,
        ordersChangeRatio: Double? = nil,
        cpcChangeRatio: Double? = nil,
        acosChangeRatio: Double? = nil,
        summary: String? = nil
    ) {
        self.currentStart = currentStart
        self.currentEnd = currentEnd
        self.previousStart = previousStart
        self.previousEnd = previousEnd
        self.spendChangeRatio = spendChangeRatio
        self.clicksChangeRatio = clicksChangeRatio
        self.salesChangeRatio = salesChangeRatio
        self.ordersChangeRatio = ordersChangeRatio
        self.cpcChangeRatio = cpcChangeRatio
        self.acosChangeRatio = acosChangeRatio
        self.summary = summary
    }

    /// `overview` 的 KPI 磁贴 label → 环比字段（Web `overview-client.tsx` 的
    /// `changeRatioFor` 映射表，标签取后端原样）。
    public func changeRatio(forMetricLabel label: String) -> Double? {
        switch label {
        case "Spend": return spendChangeRatio
        case "Sales 7d": return salesChangeRatio
        case "Orders 7d": return ordersChangeRatio
        case "Clicks": return clicksChangeRatio
        case "CPC": return cpcChangeRatio
        case "ACOS": return acosChangeRatio
        default: return nil
        }
    }
}

// MARK: - 响应信封

/// 10 个端点共用的响应信封。
///
/// 每个 Tab 只填自己那几个字段（后端各端点的 `response_model` 不同），缺位即空 ——
/// 这与 Web 逐字段读取 `data?.xxx` 的容错口径一致。
///
/// ⚠️ `CodingKeys` 的原始值必须写成**变换后**的键名（`APIClient` 的
/// `convertFromSnakeCase`）而**不是** JSON 里的写法：`project_id` 变换后是 `projectId`
/// （不是 `projectID`），因此这一处显式写原始值；其余 camelCase case 的默认原始值恰好
/// 等于变换结果（`summary_cards → summaryCards`、`top_cross_sell_products →
/// topCrossSellProducts`），`AdAnalysisDecodingTests` 用真实快照把每个字段钉住。
public struct AdAnalysisPayload: Sendable, Equatable, Decodable {
    public let projectID: Int?
    public let country: String?
    public let metrics: [AdAnalysisMetricCard]
    public let issueCards: [AdAnalysisIssueCard]
    public let narrativeSections: [AdAnalysisNarrativeSection]
    public let comparison: AdAnalysisPeriodComparison?
    public let summaryCards: [AdAnalysisSummaryCard]
    public let topCampaigns: [AdAnalysisRow]
    public let topProducts: [AdAnalysisRow]
    public let topWasteTerms: [AdAnalysisRow]
    public let trendSummary: [AdAnalysisRow]
    public let topCrossSellProducts: [AdAnalysisRow]
    public let summary: [AdAnalysisRow]
    public let items: [AdAnalysisRow]

    public init(
        projectID: Int? = nil,
        country: String? = nil,
        metrics: [AdAnalysisMetricCard] = [],
        issueCards: [AdAnalysisIssueCard] = [],
        narrativeSections: [AdAnalysisNarrativeSection] = [],
        comparison: AdAnalysisPeriodComparison? = nil,
        summaryCards: [AdAnalysisSummaryCard] = [],
        topCampaigns: [AdAnalysisRow] = [],
        topProducts: [AdAnalysisRow] = [],
        topWasteTerms: [AdAnalysisRow] = [],
        trendSummary: [AdAnalysisRow] = [],
        topCrossSellProducts: [AdAnalysisRow] = [],
        summary: [AdAnalysisRow] = [],
        items: [AdAnalysisRow] = []
    ) {
        self.projectID = projectID
        self.country = country
        self.metrics = metrics
        self.issueCards = issueCards
        self.narrativeSections = narrativeSections
        self.comparison = comparison
        self.summaryCards = summaryCards
        self.topCampaigns = topCampaigns
        self.topProducts = topProducts
        self.topWasteTerms = topWasteTerms
        self.trendSummary = trendSummary
        self.topCrossSellProducts = topCrossSellProducts
        self.summary = summary
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "projectId"
        case country
        case metrics
        case issueCards
        case narrativeSections
        case comparison
        case summaryCards
        case topCampaigns
        case topProducts
        case topWasteTerms
        case trendSummary
        case topCrossSellProducts
        case summary
        case items
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projectID = try container.decodeIfPresent(Int.self, forKey: .projectID)
        country = try container.decodeIfPresent(String.self, forKey: .country)
        metrics = try container.decodeIfPresent([AdAnalysisMetricCard].self, forKey: .metrics) ?? []
        issueCards = try container.decodeIfPresent([AdAnalysisIssueCard].self, forKey: .issueCards) ?? []
        narrativeSections =
            try container.decodeIfPresent([AdAnalysisNarrativeSection].self, forKey: .narrativeSections) ?? []
        comparison = try container.decodeIfPresent(AdAnalysisPeriodComparison.self, forKey: .comparison)
        summaryCards = try container.decodeIfPresent([AdAnalysisSummaryCard].self, forKey: .summaryCards) ?? []
        topCampaigns = try container.decodeIfPresent([AdAnalysisRow].self, forKey: .topCampaigns) ?? []
        topProducts = try container.decodeIfPresent([AdAnalysisRow].self, forKey: .topProducts) ?? []
        topWasteTerms = try container.decodeIfPresent([AdAnalysisRow].self, forKey: .topWasteTerms) ?? []
        trendSummary = try container.decodeIfPresent([AdAnalysisRow].self, forKey: .trendSummary) ?? []
        topCrossSellProducts =
            try container.decodeIfPresent([AdAnalysisRow].self, forKey: .topCrossSellProducts) ?? []
        summary = try container.decodeIfPresent([AdAnalysisRow].self, forKey: .summary) ?? []
        items = try container.decodeIfPresent([AdAnalysisRow].self, forKey: .items) ?? []
    }

    // MARK: - 派生

    /// 该 Tab 的明细行（各 Tab 明细所在的字段名不同，这里收成一处判断）。
    public func detailRows(forTabKey tabKey: String) -> [AdAnalysisRow] {
        switch tabKey {
        case "time-trend": return summary
        case "overview": return AdAnalysisOverviewGrid.rows(from: self)
        default: return items
        }
    }

    /// 明细是否为空（空态判定：**无数据要显示「无数据」而不是 0**）。
    public func isEmpty(forTabKey tabKey: String) -> Bool {
        detailRows(forTabKey: tabKey).isEmpty
    }
}

// MARK: - 项目

/// `/api/v1/projects/manage` 的元素（只解桌面端要用的字段）。
public struct AdProject: Sendable, Equatable, Identifiable, Decodable {
    public let id: Int
    public let name: String
    public let country: String?
    public let isActive: Bool

    public init(id: Int, name: String, country: String? = nil, isActive: Bool = true) {
        self.id = id
        self.name = name
        self.country = country
        self.isActive = isActive
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, country, isActive
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        country = try container.decodeIfPresent(String.self, forKey: .country)
        isActive = try container.decodeIfPresent(Bool.self, forKey: .isActive) ?? true
    }
}

// MARK: - 查询

/// 一次 ad-analysis 查询的参数。
///
/// **口径 1（不传日期 ≠ 最近 N 天）**：日期为空时**根本不带** `date_from` / `date_to`
/// 参数。后端 `_apply_report_date_filters`（`backend/app/services/ad/loaders.py:26-32`）
/// 在参数为空时不加任何日期条件，聚合的是**全量历史**；这里若自作聪明填一个「最近 7 天」
/// 默认值，数值会与 Web 不一致。Web 端同样是 `if (dateFrom) query.set(...)`。
public struct AdAnalysisQuery: Sendable, Equatable {
    public let projectID: Int
    public let country: String
    public let dateFrom: String?
    public let dateTo: String?

    public init(projectID: Int, country: String, dateFrom: String? = nil, dateTo: String? = nil) {
        self.projectID = projectID
        self.country = country
        self.dateFrom = dateFrom?.trimmedNonEmpty
        self.dateTo = dateTo?.trimmedNonEmpty
    }

    /// 实际发出的查询串（键序固定，便于断言与两端比对排错）。
    public var parameters: [String: String] {
        var parameters = ["project_id": String(projectID), "country": country]
        if let dateFrom { parameters["date_from"] = dateFrom }
        if let dateTo { parameters["date_to"] = dateTo }
        return parameters
    }
}
