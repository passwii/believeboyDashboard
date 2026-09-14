import BelieveBoyKit
import XCTest

/// 业务域注册表快照 —— 与 `frontend/lib/agent-domains.ts` 的一致性检查。
///
/// 注册表是「矩阵行从哪里来」的唯一依据：后端只返回窗口内有调用的域，其余 9 行全靠这份
/// 表补全。少一个域 = 少一行（用户以为那个域不存在），多一个域 = 多一行假数据。故把
/// **域数 / live 数 / code 全集 / 矩阵行序**都钉在这里，漂移在 Swift 侧直接报红，不必
/// 等人工逐行对照 Web。
final class AgentDomainCatalogTests: XCTestCase {
    /// 17 个域、16 live / 1 planned（`finance_profit`），顺序与 TS 文件一致。
    func testRegistrySnapshotMatchesWeb() {
        let domains = AgentDomainCatalog.domains

        XCTAssertEqual(domains.count, 17)
        XCTAssertEqual(AgentDomainCatalog.liveCount, 16)
        XCTAssertEqual(domains.filter { $0.status == .planned }.map(\.code), ["finance_profit"])
        XCTAssertEqual(
            domains.map(\.code),
            [
                "shipments",
                "shop_calculations",
                "return_analysis",
                "inventory",
                "ad_analysis",
                "inventory_ledger",
                "report_upload_status",
                "report_upload",
                "replenishment_analysis",
                "new_product_calculations",
                "account_health",
                "platform_inspection",
                "complaint_center",
                "sales",
                "sku_info",
                "agent_provisioning",
                "finance_profit",
            ]
        )
    }

    /// live 域都有 Dashboard 入口，规划中的域没有（`agent-domains.ts` 的
    /// `dashboardPath?` 契约）—— 界面上「Web 入口」列不能给规划中的域编一个地址。
    func testOnlyLiveDomainsCarryDashboardPath() {
        for domain in AgentDomainCatalog.domains where domain.isLive {
            XCTAssertNotNil(domain.dashboardPath, "\(domain.code) 是 live 域，应有 Web 入口")
            XCTAssertGreaterThan(domain.routeCount, 0, "\(domain.code) 是 live 域，路由数应大于 0")
        }
        for domain in AgentDomainCatalog.domains where domain.status == .planned {
            XCTAssertNil(domain.dashboardPath, "\(domain.code) 是规划中，不应有 Web 入口")
            XCTAssertEqual(domain.routeCount, 0)
        }
    }

    /// 能力位：至少有一侧能力；`labels` 顺序固定为 读 → 写。
    func testCapabilityLabelsAreStable() {
        XCTAssertEqual(
            AgentDomainCatalog.domain(code: "shipments")?.capabilities.labels,
            ["读", "写"]
        )
        XCTAssertEqual(
            AgentDomainCatalog.domain(code: "report_upload")?.capabilities.labels,
            ["写"]
        )
        XCTAssertEqual(
            AgentDomainCatalog.domain(code: "inventory")?.capabilities.labels,
            ["读"]
        )
        for domain in AgentDomainCatalog.domains {
            XCTAssertFalse(
                domain.capabilities.labels.isEmpty,
                "\(domain.code) 读 / 写 都不具备 —— 注册表里没有这种域"
            )
        }
    }

    /// 矩阵行序：产出域置顶 + 同档保持注册表顺序（Web `Array.sort` 的稳定性）。
    ///
    /// 行序本身是对齐项之一：两端顺序一致，抽样比对才能逐行对着看。注意 Web 的档位
    /// **有重叠**（`account_health` 与普通 live 域同为 2、`report_upload_status` 与
    /// planned 域同为 3）—— 不稳定排序会让这些位置随机互换，故这里断言完整序列。
    func testOrderedDomainsPutsProduceFirstAndIsStable() {
        XCTAssertEqual(
            AgentDomainCatalog.orderedDomains().map(\.code),
            [
                "complaint_center",
                "platform_inspection",
                "shipments",
                "shop_calculations",
                "return_analysis",
                "inventory",
                "ad_analysis",
                "inventory_ledger",
                "replenishment_analysis",
                "new_product_calculations",
                "account_health",
                "sales",
                "sku_info",
                "agent_provisioning",
                "report_upload_status",
                "finance_profit",
                "report_upload",
            ]
        )
    }

    /// 排序不改元素集合，也不改动入参数组本身。
    func testOrderingIsPure() {
        let source = AgentDomainCatalog.domains
        let ordered = AgentDomainCatalog.orderedDomains(source)

        XCTAssertEqual(Set(ordered.map(\.code)), Set(source.map(\.code)))
        XCTAssertEqual(source.map(\.code), AgentDomainCatalog.domains.map(\.code), "不得就地排序")
    }

    func testUnknownCodeResolvesToNil() {
        XCTAssertNil(AgentDomainCatalog.domain(code: "not_a_domain"))
    }
}
