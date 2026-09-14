import Foundation

/// Agent 业务域注册表 —— `frontend/lib/agent-domains.ts` 的 `AGENT_DOMAINS` 在
/// Swift 侧的等价物（S4「数据流总览」用）。
///
/// 为什么要在 Swift 里复刻一份而不是从后端拿：注册表是**前端约定**（后端只按
/// `business_scope` 字符串校验），`domain-summary` 端点又刻意只返回「窗口内有调用」
/// 的域 —— 没有注册表补全，历史上活跃过的域一旦这 7 天没被调用就从矩阵里消失，
/// 用户会以为那个域不存在。补全的基准必须与 Web 一字不差，故照抄一份并把
/// 域数 / live 数 / 顺序钉在 `AgentDomainCatalogTests` 里。
///
/// `code` 与后端 `agent_api_keys.business_scope` 同源（`require_business_scope("<code>")`）。
public struct AgentDomain: Identifiable, Hashable, Sendable {
    /// `live` = 已接入 agent 命名空间；`planned` = 规划中（仅概览展示）。
    public enum Status: String, Hashable, Sendable {
        case live
        case planned
    }

    /// 后端 `business_scope` 取值，如 `shipments`；也是 `domain-summary` 的 `domain`。
    public let code: String
    /// 中文名。
    public let label: String
    /// 一句话说明（Web 的「说明」列）。
    public let summary: String
    public let status: Status
    /// agent 命名空间路由数（Web 的「路由」列，人工维护）。
    public let routeCount: Int
    /// Dashboard 前端入口页；规划中的域没有入口（`finance_profit`）。
    public let dashboardPath: String?
    /// 能力位（Web 的「能力」列拆成 读 / 写 两个徽标）。
    public let capabilities: Capabilities

    public struct Capabilities: Hashable, Sendable {
        public let read: Bool
        public let write: Bool

        public init(read: Bool, write: Bool) {
            self.read = read
            self.write = write
        }

        /// 读 / 写 的可读标签（顺序固定，空能力返回空数组 —— 不伪造徽标）。
        public var labels: [String] {
            var labels: [String] = []
            if read { labels.append("读") }
            if write { labels.append("写") }
            return labels
        }
    }

    public var id: String { code }

    public var isLive: Bool { status == .live }

    public init(
        code: String,
        label: String,
        summary: String,
        status: Status,
        routeCount: Int,
        dashboardPath: String? = nil,
        capabilities: Capabilities
    ) {
        self.code = code
        self.label = label
        self.summary = summary
        self.status = status
        self.routeCount = routeCount
        self.dashboardPath = dashboardPath
        self.capabilities = capabilities
    }
}

/// 注册表本体 + 矩阵行序。
public enum AgentDomainCatalog {
    /// 17 个业务域，顺序与 `agent-domains.ts` 一致（顺序本身是权威数据的一部分，
    /// 见 `orderedDomains` 的稳定排序说明）。
    public static let domains: [AgentDomain] = [
        AgentDomain(
            code: "shipments",
            label: "货件管理",
            summary: "FBA 货件全生命周期：列表/详情/增删改/状态推进/费用重算",
            status: .live,
            routeCount: 11,
            dashboardPath: "/dashboard/operations/shipment-management",
            capabilities: .init(read: true, write: true)
        ),
        AgentDomain(
            code: "shop_calculations",
            label: "店铺测算",
            summary: "店铺测算数据读写与试算：列表/SKU 详情/历史/审计/追加/试算",
            status: .live,
            routeCount: 6,
            dashboardPath: "/dashboard/reports/pricing-calculation/shop-calculation",
            capabilities: .init(read: true, write: true)
        ),
        AgentDomain(
            code: "return_analysis",
            label: "退货分析",
            summary: "退货/客诉归因：全量分析/per-SKU 风险清单/raw 事件/覆盖度",
            status: .live,
            routeCount: 5,
            dashboardPath: "/dashboard/operations/return-analysis",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "inventory",
            label: "库存信息",
            summary: "当前库存快照：总量/库龄/缺货/单 SKU 数量（独立于补货分析）",
            status: .live,
            routeCount: 1,
            dashboardPath: "/dashboard/operations/inventory-analysis",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "ad_analysis",
            label: "广告分析",
            summary: "10 个广告域聚合（预算/搜索词/竞品份额）",
            status: .live,
            routeCount: 10,
            dashboardPath: "/dashboard/advertising/ad-analysis/overview",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "inventory_ledger",
            label: "库存台账",
            summary: "月度盘点/事件/收货簇/完整性/趋势（Detailed + Summary 视图）",
            status: .live,
            routeCount: 10,
            dashboardPath: "/dashboard/operations/inventory-ledger",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "report_upload_status",
            label: "报表状态",
            summary: "RPA 报表上传状态矩阵：15 类活跃报表缺失统计",
            status: .live,
            routeCount: 1,
            dashboardPath: "/dashboard/reports/auto-upload",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "report_upload",
            label: "报表上传",
            summary: "Agent 报表上传：dry-run 校验 + 正式提交（列匹配度/多站点检测/审计）",
            status: .live,
            routeCount: 2,
            dashboardPath: "/dashboard/reports/auto-upload",
            capabilities: .init(read: false, write: true)
        ),
        AgentDomain(
            code: "replenishment_analysis",
            label: "补货分析",
            summary: "补货决策清单/单 SKU 深挖/项目总览/覆盖度/设置（三段式体系，BLF-502）",
            status: .live,
            routeCount: 6,
            dashboardPath: "/dashboard/operations/inventory-replenishment",
            capabilities: .init(read: true, write: true)
        ),
        AgentDomain(
            code: "new_product_calculations",
            label: "新品测算",
            summary: "新品测算快照读写与试算：列表/SKU 详情/审计/落库/试算（读3+写1+试算1，BLF-526）",
            status: .live,
            routeCount: 5,
            dashboardPath: "/dashboard/reports/pricing-calculation/new-product",
            capabilities: .init(read: true, write: true)
        ),
        AgentDomain(
            code: "account_health",
            label: "店铺合规健康",
            summary: "店铺合规/账户健康：周巡检周期列表/概览/单店明细/历史趋势（读 5 条，BLF-547）",
            status: .live,
            routeCount: 5,
            dashboardPath: "/dashboard/operations/platform-inspection",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "platform_inspection",
            label: "平台巡检",
            summary: "平台巡检写侧：模板 + 填写/更新/提交报告 + 截图上传/删除（写 5 条，读侧走 account-health，BLF-944）",
            status: .live,
            routeCount: 5,
            dashboardPath: "/dashboard/operations/platform-inspection",
            capabilities: .init(read: false, write: true)
        ),
        AgentDomain(
            code: "complaint_center",
            label: "客户消息",
            summary: "Agent 每日巡检客诉写入 + Dashboard 概览/明细/详情管理（W1 批量 upsert + R1 列表读取，BLF-981）",
            status: .live,
            routeCount: 2,
            dashboardPath: "/dashboard/operations/complaint-center",
            capabilities: .init(read: true, write: true)
        ),
        AgentDomain(
            code: "sales",
            label: "销售数据",
            summary: "销售订单明细/聚合统计：原始行 + ASIN×日/ASIN/日聚合（Sales Data）",
            status: .live,
            routeCount: 1,
            dashboardPath: "/dashboard/operations/daily-analysis",
            capabilities: .init(read: true, write: false)
        ),
        AgentDomain(
            code: "sku_info",
            label: "SKU 主数据",
            summary: "商品主数据读+写：列表/详情/审计 + 新建/改规格成本/上下架（confirm 流，BLF-579）+ FNSKU 标签上传（BLF-628）",
            status: .live,
            routeCount: 7,
            dashboardPath: "/dashboard/operations/sku-info",
            capabilities: .init(read: true, write: true)
        ),
        AgentDomain(
            code: "agent_provisioning",
            label: "凭据签发",
            summary: "签发新 Agent 凭据（敏感，仅管理 Key）",
            status: .live,
            routeCount: 1,
            dashboardPath: "/dashboard/system/agent-management",
            capabilities: .init(read: false, write: true)
        ),
        AgentDomain(
            code: "finance_profit",
            label: "财务利润",
            summary: "利润/财务（月度×项目×国家），COGS 口径待定",
            status: .planned,
            routeCount: 0,
            capabilities: .init(read: true, write: false)
        ),
    ]

    /// 已接入（live）域数量 —— 页头描述的分子。
    public static var liveCount: Int { domains.filter(\.isLive).count }

    /// 域 code → 注册表条目（未知 code 回 nil，调用方忽略该行 —— Web 同口径）。
    public static func domain(code: String) -> AgentDomain? {
        domains.first { $0.code == code }
    }

    /// 「产出域置顶」顺序（`agent-overview-client.tsx` 的 `PRODUCE_DOMAIN_ORDER`）。
    ///
    /// `account_health` 读侧同属巡检产出，故与 `platform_inspection` 并排。
    private static let produceOrder = [
        "complaint_center",
        "platform_inspection",
        "account_health",
        "report_upload_status",
        "report_upload",
    ]

    private static let produceRank: [String: Int] = Dictionary(
        uniqueKeysWithValues: produceOrder.enumerated().map { ($0.element, $0.offset) }
    )

    /// 单个域在矩阵里的排序档位（越小越靠前）。
    ///
    /// 取自 Web 的 `domainSortKey`：非 live 域恒为 3，产出域按 `PRODUCE_RANK`，
    /// 其余 live 域为 2。注意档位**有重叠**（`account_health` 与普通 live 域同为 2，
    /// `report_upload_status` 与 planned 域同为 3）—— Web 靠 `Array.prototype.sort`
    /// 的稳定性保持注册表顺序，故这里也必须稳定排序，否则行序会与 Web 不一致。
    static func sortRank(of domain: AgentDomain) -> Int {
        guard domain.isLive else { return 3 }
        return produceRank[domain.code] ?? 2
    }

    /// 矩阵行序：产出域置顶 + **稳定**排序（同档保持注册表顺序）。
    ///
    /// `sorted(by:)` 在 Swift 里不保证稳定，故显式按 `(档位, 注册表下标)` 比较 ——
    /// 这样 Web 与桌面端的行序逐行对得上，抽样比对时不必再对一遍位置。
    public static func orderedDomains(_ source: [AgentDomain] = AgentDomainCatalog.domains) -> [AgentDomain] {
        source.enumerated()
            .sorted { lhs, rhs in
                let left = sortRank(of: lhs.element)
                let right = sortRank(of: rhs.element)
                if left != right { return left < right }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }
}
