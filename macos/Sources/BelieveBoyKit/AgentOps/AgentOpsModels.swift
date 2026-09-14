import Foundation

// MARK: - 业务域活动（`GET /agent-ops/domain-summary`）

/// 单个业务域在统计窗口内的活动聚合。
///
/// 字段名与后端 `agent_ops.py:DomainSummaryItem` 1:1（`APIClient` 的
/// `keyDecodingStrategy = .convertFromSnakeCase` 负责去下划线）。
///
/// ⚠️ **`calls24H` / `calls7D` / `writes24H` / `writes7D` / `errors7D` 的写法是被解码策略
/// 决定的，不是排版失误**：`convertFromSnakeCase` 的实现是「丢掉下划线 + 大写化下划线后
/// 的第一个字符」，而 `24h` / `7d` 里第一个能被大写的是末尾那个字母 —— 实测产出
/// `calls_24h → calls24H`、`errors_7d → errors7D`（不是 `calls24h`）。写成 `calls24h`
/// 会编译通过但运行时整条响应报「缺少字段」，故这几个名字由 `AgentOpsDataTests`
/// 拿真实响应钉住。
///
/// `lastActiveAt` 保持**字符串**而不解成 `Date`：后端可能返回 `null`（窗口内无活动），
/// 也可能返回带 6 位小数秒 + 偏移量的 ISO 串，两者都要能落地成「从未活动」而不是整条
/// 响应解码失败 —— 详见 `AgentOpsFormatting.parseISO8601`。
public struct DomainActivity: Decodable, Sendable, Equatable {
    public let domain: String
    public let calls24H: Int
    public let calls7D: Int
    public let writes24H: Int
    public let writes7D: Int
    public let errors7D: Int
    public let lastActiveAt: String?

    public init(
        domain: String,
        calls24H: Int,
        calls7D: Int,
        writes24H: Int,
        writes7D: Int,
        errors7D: Int,
        lastActiveAt: String? = nil
    ) {
        self.domain = domain
        self.calls24H = calls24H
        self.calls7D = calls7D
        self.writes24H = writes24H
        self.writes7D = writes7D
        self.errors7D = errors7D
        self.lastActiveAt = lastActiveAt
    }
}

/// `domain-summary` 响应信封。
public struct DomainSummaryResponse: Decodable, Sendable, Equatable {
    public let generatedAt: String?
    public let windowDays: Int?
    /// 后端契约里 `items` 恒在，但 Web 的 `reduceDomainSummaries` 对 null / 非数组
    /// 都做了容错 —— 这里同口径（缺位即空矩阵，而不是解码失败）。
    public let items: [DomainActivity]?

    /// 归一化后的条目（`items` 缺省 / null → 空）。
    public var activityItems: [DomainActivity] { items ?? [] }

    public init(
        generatedAt: String? = nil,
        windowDays: Int? = nil,
        items: [DomainActivity]? = nil
    ) {
        self.generatedAt = generatedAt
        self.windowDays = windowDays
        self.items = items
    }
}

// MARK: - 今日产出：客诉

/// `GET /complaints/overview` 响应信封（只解出「今日产出」列需要的两个字段）。
///
/// 注意后端 `response_model=OverviewResponse` 只暴露 `date` / `metrics` / `trend` /
/// `projects` —— **没有** `shops`（那是 `shop_id → project_id` 重构前的旧字段名）。
/// 「今天有没有巡检 run」的唯一可用信号就是 `projects` 是否非空。
public struct ComplaintOverviewResponse: Decodable, Sendable, Equatable {
    public struct Metrics: Decodable, Sendable, Equatable {
        public let totalNeedsReply: Int?
    }

    public struct ProjectRow: Decodable, Sendable, Equatable {
        public let projectId: Int
    }

    public let metrics: Metrics?
    public let projects: [ProjectRow]?

    public init(metrics: Metrics? = nil, projects: [ProjectRow]? = nil) {
        self.metrics = metrics
        self.projects = projects
    }

    /// 客诉产出口径：有巡检 run（`projects` 非空）才展示待回复数。
    public var production: ComplaintProduction {
        ComplaintProduction(
            hasRun: !(projects ?? []).isEmpty,
            needsReply: metrics?.totalNeedsReply
        )
    }
}

/// 客诉产出（Web `useAgentProduction` 的 `complaints`）。
public struct ComplaintProduction: Sendable, Equatable {
    public let hasRun: Bool
    public let needsReply: Int?

    public init(hasRun: Bool, needsReply: Int?) {
        self.hasRun = hasRun
        self.needsReply = needsReply
    }

    /// 单元格文案；`nil` = 占位「—」（无 run / 无待回复数）。
    public var displayText: String? {
        guard hasRun, let needsReply else { return nil }
        return "待回复 \(needsReply)"
    }
}

// MARK: - 今日产出：巡检

/// `GET /inspections/periods/current` 响应（只需周期 id）。
public struct InspectionPeriodResponse: Decodable, Sendable, Equatable {
    public let id: Int
    public let weekStart: String?
    public let weekEnd: String?

    public init(id: Int, weekStart: String? = nil, weekEnd: String? = nil) {
        self.id = id
        self.weekStart = weekStart
        self.weekEnd = weekEnd
    }
}

/// `GET /inspections/periods/{id}/overview` 响应（只取提交口径）。
public struct InspectionOverviewResponse: Decodable, Sendable, Equatable {
    public let submittedCount: Int?
    public let totalProjects: Int?

    public init(submittedCount: Int? = nil, totalProjects: Int? = nil) {
        self.submittedCount = submittedCount
        self.totalProjects = totalProjects
    }
}

/// 巡检产出（Web `useAgentProduction` 的 `inspection`）。
public struct InspectionProduction: Sendable, Equatable {
    public let submitted: Int?
    public let total: Int?
    /// 当前周期区间（Web 不展示，桌面端只放进 hover/详情，便于人肉判断「这周」是哪周）。
    public let weekStart: String?
    public let weekEnd: String?

    public init(submitted: Int?, total: Int?, weekStart: String? = nil, weekEnd: String? = nil) {
        self.submitted = submitted
        self.total = total
        self.weekStart = weekStart
        self.weekEnd = weekEnd
    }

    /// 单元格文案；`nil` = 占位「—」。
    public var displayText: String? {
        guard let submitted, let total else { return nil }
        return "\(submitted)/\(total) 报告"
    }
}

// MARK: - 今日产出：报表

/// `GET /rpa-reports/status` 响应（状态矩阵）。
public struct ReportStatusResponse: Decodable, Sendable, Equatable {
    public struct Cell: Decodable, Sendable, Equatable {
        public let isUploaded: Bool?

        public init(isUploaded: Bool? = nil) {
            self.isUploaded = isUploaded
        }
    }

    public struct Item: Decodable, Sendable, Equatable {
        public let statuses: [Cell]?

        public init(statuses: [Cell]? = nil) {
            self.statuses = statuses
        }
    }

    public let country: String?
    public let items: [Item]?

    public init(country: String? = nil, items: [Item]? = nil) {
        self.country = country
        self.items = items
    }
}

/// 报表上传完成度（Web `reduceUploadStatus` 的口径）。
///
/// `total` = 项目数 × 每项目报表类型数（cell 数），`uploaded` = `is_uploaded === true`
/// 的 cell 数。**按 cell 计数而不是按项目** —— 少一个 cell 就是缺一份报表。
public struct ReportUploadCompletion: Sendable, Equatable {
    public let uploaded: Int
    public let total: Int

    public var missing: Int { total - uploaded }

    public init(uploaded: Int, total: Int) {
        self.uploaded = uploaded
        self.total = total
    }

    /// 由状态矩阵聚合（Web `reduceUploadStatus` 的等价实现）。
    public init(items: [ReportStatusResponse.Item]?) {
        var uploaded = 0
        var total = 0
        for item in items ?? [] {
            for cell in item.statuses ?? [] {
                total += 1
                if cell.isUploaded == true { uploaded += 1 }
            }
        }
        self.init(uploaded: uploaded, total: total)
    }

    /// 单元格文案；`nil` = 占位「—」。
    public var displayText: String? {
        "\(uploaded)/\(total) 报表"
    }
}

// MARK: - 矩阵行

/// 矩阵里的一行：注册表条目 + 运行时活动 + 今日产出文案。
///
/// `activity == nil` 表示该域在窗口内**没有被调用过**（后端不返回条目）—— 这一行
/// 的运行时列全部是占位「—」，不是 0。把「没数据」显示成 0 会把「这个域没人用」
/// 伪装成「这个域被用了但次数是零」。
public struct AgentOverviewRow: Identifiable, Sendable, Equatable {
    public let domain: AgentDomain
    public let activity: DomainActivity?
    /// 今日产出单元格文案；`nil` = 占位「—」。
    public let production: String?

    public var id: String { domain.code }

    public init(domain: AgentDomain, activity: DomainActivity?, production: String?) {
        self.domain = domain
        self.activity = activity
        self.production = production
    }
}

/// 矩阵装配：注册表补全 + 排序 + 今日产出映射（Web `agent-overview-client.tsx` 的等价实现）。
public enum AgentOverviewBuilder {
    /// 组装矩阵行。
    ///
    /// - Parameters:
    ///   - activity: `domain-summary` 的条目（窗口内无调用的域不会出现）。
    ///   - complaints / inspections / reports: 三个今日产出源；`nil` = 该源失败或未加载
    ///     → 对应列显示占位「—」（与 Web 的**单频道降级**一致：一个源失败不影响其它列）。
    ///   - domains: 注册表（测试可注入）。
    /// - Returns: 按 Web 行序排好的行。
    public static func rows(
        activity: [DomainActivity],
        complaints: ComplaintProduction? = nil,
        inspections: InspectionProduction? = nil,
        reports: ReportUploadCompletion? = nil,
        domains: [AgentDomain] = AgentDomainCatalog.domains
    ) -> [AgentOverviewRow] {
        // 后端可能返回注册表里没有的 code（新域已上线后端、前端注册表还没跟上）。
        // Web 直接忽略这类条目（`summary?.[domain.code]` 落空）；这里同口径，不新增行。
        var byCode: [String: DomainActivity] = [:]
        for item in activity where AgentDomainCatalog.domain(code: item.domain) != nil {
            byCode[item.domain] = item
        }

        return AgentDomainCatalog.orderedDomains(domains).map { domain in
            AgentOverviewRow(
                domain: domain,
                activity: byCode[domain.code],
                production: productionText(
                    for: domain.code,
                    complaints: complaints,
                    inspections: inspections,
                    reports: reports
                )
            )
        }
    }

    /// 今日产出单元格（Web `productionCell` 的等价实现）。
    ///
    /// 只有这 5 个域有产出语义：巡检产出的读侧（`account_health`）与写侧
    /// （`platform_inspection`）共用同一格，报表状态与报表上传同理。
    public static func productionText(
        for code: String,
        complaints: ComplaintProduction?,
        inspections: InspectionProduction?,
        reports: ReportUploadCompletion?
    ) -> String? {
        switch code {
        case "complaint_center":
            return complaints?.displayText
        case "platform_inspection", "account_health":
            return inspections?.displayText
        case "report_upload", "report_upload_status":
            return reports?.displayText
        default:
            return nil
        }
    }
}
