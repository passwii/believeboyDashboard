import BelieveBoyKit
import XCTest

/// `NavigationCatalog` ↔ `frontend/lib/sidebar-config.ts` 的对齐快照。
///
/// 这里钉住的数字是 CLAUDE/AGENTS 与 PLAN §8 S3 的验收基线：**8 个分组 / 56 个二级项**。
/// Web 端一旦增删条目，Swift 侧这份快照会先报红，提醒改 catalog —— 这就是「人工对照」
/// 的执行点（不做代码生成，避免构建期耦合前端工具链，PLAN §2.2）。
///
/// 基线取值时点：`origin/main` = `e2ff65f2`（S2 合并后）。
final class NavigationCatalogTests: XCTestCase {
    /// 分组 id / label / 二级项数 —— 逐项钉住，顺序也钉（顺序即侧栏展示顺序）。
    private static let webBaseline: [(id: String, label: String, items: Int)] = [
        ("operations", "运营", 19),
        ("reports", "报表中心", 7),
        ("finance", "财务资金", 4),
        ("advertising", "广告", 2),
        ("ai", "AI 智能", 8),
        ("crm", "CRM 客户与合作伙伴", 7),
        ("tools", "工具箱", 2),
        ("system", "系统管理", 7),
    ]

    // MARK: - 验收 1：8 分组 / 56 二级项

    func testGroupCountAndOrderMatchWebSidebar() {
        XCTAssertEqual(NavigationCatalog.groups.count, 8, "sidebar-config.ts 的 SIDEBAR_TOP_GROUPS 是 8 组")
        XCTAssertEqual(
            NavigationCatalog.groups.map(\.id),
            Self.webBaseline.map(\.id),
            "分组 id 与顺序必须与 sidebar-config.ts 一致"
        )
        XCTAssertEqual(
            NavigationCatalog.groups.map(\.label),
            Self.webBaseline.map(\.label),
            "分组标题必须与 sidebar-config.ts 一致"
        )
    }

    func testPerGroupItemCountsMatchWebSidebar() {
        let actual = NavigationCatalog.groups.map { (id: $0.id, label: $0.label, items: $0.items.count) }
        for (index, expected) in Self.webBaseline.enumerated() {
            XCTAssertEqual(actual[index].id, expected.id)
            XCTAssertEqual(
                actual[index].items,
                expected.items,
                "分组「\(expected.label)」的二级项数应为 \(expected.items)，"
                    + "实为 \(actual[index].items)（对照 frontend/lib/sidebar-config.ts）"
            )
        }
    }

    func testTotalItemCountIsFiftySix() {
        XCTAssertEqual(NavigationCatalog.allItems.count, 56)
        XCTAssertEqual(NavigationCatalog.groups.reduce(0) { $0 + $1.items.count }, 56)
    }

    /// `matchPrefixes` 实测 18 处。高亮不能只比 `url` 相等，这个数字就是「有多少条
    /// 需要前缀匹配」的对照量。
    func testMatchPrefixesCountMatchesWebSidebar() {
        let prefixed = NavigationCatalog.allItems.filter { !$0.matchPrefixes.isEmpty }
        XCTAssertEqual(prefixed.count, 18, "sidebar-config.ts 实测 18 处 matchPrefixes")
    }

    // MARK: - 结构自洽

    func testRouteIDsAreUniqueAcrossCatalog() {
        let ids = NavigationCatalog.allItems.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "route id 是选择与持久化的唯一键，不得重复")
    }

    func testEveryItemHasTitleRouteAndSymbol() {
        for item in NavigationCatalog.allItems {
            XCTAssertFalse(item.title.isEmpty, "\(item.id) 缺标题")
            XCTAssertFalse(item.route.isEmpty, "\(item.id) 缺 Web 路由")
            XCTAssertTrue(item.route.hasPrefix("/dashboard"), "\(item.id) 的 Web 路由应以 /dashboard 开头")
            XCTAssertFalse(item.symbol.isEmpty, "\(item.id) 缺图标名")
            XCTAssertEqual(item.id, item.route, "route id 直接取 Web 的 url")
        }
    }

    func testLookupsResolveGroupAndItem() {
        XCTAssertEqual(NavigationCatalog.group(id: "crm")?.label, "CRM 客户与合作伙伴")
        XCTAssertNil(NavigationCatalog.group(id: "toolbox"), "Web 端分组 id 是 tools（不是 toolbox）")
        XCTAssertEqual(
            NavigationCatalog.item(routeID: "/dashboard/operations/daily-analysis")?.title,
            "销售数据"
        )
        XCTAssertNil(NavigationCatalog.item(routeID: "/dashboard/not-a-real-page"))
    }

    /// 分组归属看**条目位置**，不看路由前缀：`/dashboard/system/agent-management`
    /// 挂在「运营」下（与 Web 的 `findGroupByPathname` 首个命中语义一致）。
    func testGroupOwnershipFollowsItemPlacementNotRoutePrefix() {
        XCTAssertEqual(
            NavigationCatalog.groupID(forRouteID: "/dashboard/system/agent-management"),
            "operations"
        )
        XCTAssertEqual(NavigationCatalog.groupID(forRouteID: "/dashboard/system/logs"), "system")
        XCTAssertNil(NavigationCatalog.groupID(forRouteID: "/dashboard/nope"))
    }

    // MARK: - 高亮语义（复刻 Web `isLinkActive`）

    func testExactRouteIsActive() {
        let item = NavigationCatalog.item(routeID: "/dashboard/operations/daily-analysis")!
        XCTAssertTrue(NavigationCatalog.isActive(path: "/dashboard/operations/daily-analysis", item: item))
    }

    func testSubPathIsActiveThroughMatchPrefixes() {
        let monthlyReport = NavigationCatalog.item(routeID: "/dashboard/reports/monthly-report/display")!
        XCTAssertTrue(
            NavigationCatalog.isActive(path: "/dashboard/reports/monthly-report/2026-08", item: monthlyReport),
            "18 处 matchPrefixes 就是为了子路径仍然点亮该条目"
        )
    }

    /// 没有 `matchPrefixes` 的条目**不得**被子路径点亮：`数字员工` 与 `虚拟办公室`
    /// 是两条独立条目（后者是前者的子路径），前缀匹配漏进来会让两条同时高亮。
    func testSiblingSubPathDoesNotActivateItemWithoutPrefixes() {
        let employees = NavigationCatalog.item(routeID: "/dashboard/ai/digital-employees")!
        let office = NavigationCatalog.item(routeID: "/dashboard/ai/digital-employees/office")!
        XCTAssertFalse(NavigationCatalog.isActive(path: office.route, item: employees))
        XCTAssertTrue(NavigationCatalog.isActive(path: office.route, item: office))
        XCTAssertTrue(NavigationCatalog.isActive(path: employees.route, item: employees))
    }

    func testUnrelatedPathIsNotActive() {
        let item = NavigationCatalog.item(routeID: "/dashboard/finance/exchange-rate")!
        XCTAssertFalse(NavigationCatalog.isActive(path: "/dashboard/finance/platform-revenue", item: item))
        XCTAssertFalse(NavigationCatalog.isActive(path: "/dashboard", item: item))
    }

    /// Web 的 `/dashboard` 特例：**只**精确相等才算活动，不吃前缀。
    func testDashboardRouteIsExactMatchOnly() {
        let item = NavigationItem(
            id: "/dashboard",
            title: "首页",
            route: "/dashboard",
            symbol: "house",
            matchPrefixes: ["/dashboard"]
        )
        XCTAssertTrue(NavigationCatalog.isActive(path: "/dashboard", item: item))
        XCTAssertFalse(
            NavigationCatalog.isActive(path: "/dashboard/operations/daily-analysis", item: item),
            "`/dashboard` 有特例：只有精确相等才算活动"
        )
    }

    func testPathLookupReturnsTheSidebarOrderedMatch() {
        XCTAssertEqual(
            NavigationCatalog.item(matchingPath: "/dashboard/crm/sea")?.title,
            "客户",
            "`/dashboard/crm/sea` 由「客户」的 matchPrefixes 收编"
        )
        XCTAssertEqual(NavigationCatalog.item(matchingPath: "/dashboard/ai/chat")?.title, "AI Chat")
    }

    // MARK: - 动态徽标只留语义位

    func testOnlyCrmFollowUpDeclaresLiveData() {
        let liveItems = NavigationCatalog.allItems.filter(\.requiresLiveData)
        XCTAssertEqual(
            liveItems.map(\.id),
            ["/dashboard/crm/follow-ups"],
            "Web 端只有 CRM「待跟进」挂动态徽标组件（CrmFollowUpBadge）"
        )
    }

    /// catalog **不带**权限位：`sidebar-config.ts` 的 `roles` / `groupRoles` 已全部移除，
    /// 可见性改由单页权限接管。这条用例把「8 组 / 56 项对所有账号一律可见」钉住 ——
    /// 若将来有人加回 role 过滤，条目数会先在这里变化。
    func testCatalogExposesEveryGroupAndItemWithoutRoleFiltering() {
        XCTAssertEqual(NavigationCatalog.groups.count, 8)
        XCTAssertEqual(NavigationCatalog.allItems.count, 56)
        XCTAssertTrue(
            NavigationCatalog.groups.allSatisfy { !$0.items.isEmpty },
            "没有分组会被角色过滤掉"
        )
    }
}
