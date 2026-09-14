import BelieveBoyKit
import XCTest

/// 快照 → 模型 → 列：把「与 Web 同源同值」拆成可执行的断言。
///
/// 这一层要钉住的都是**编译期看不见**的东西：后端这 10 个端点返回的是 `list[dict]`，
/// 键名写错不会有编译错误、也不会让解码失败（可选字段一律 nil），只会静默少一列数据
/// 或把数字变成占位「—」。所以这里的每条断言都指向一个具体的失效方式：
///
/// - 键名写错 → `testEveryColumnKeyResolvesInItsSnapshot`；
/// - 信封字段名写错（`convertFromSnakeCase` 的坑）→ `testEveryTabSnapshotDecodesItsEnvelope`；
/// - 快照被无意改动（跨批次漂移的锚点）→ `testCommittedSnapshotHashesMatchManifest`；
/// - 数值口径（比值 vs 百分数、千分位）→ `testSpotValuesMatchRealResponses` + 格式化用例。
final class AdAnalysisDecodingTests: XCTestCase {
    // MARK: - 解码策略的前置事实

    /// 动态行里的键**保持**后端的 snake_case（`APIClient` 的 `convertFromSnakeCase`
    /// 只作用于结构体属性，`[String: AdAnalysisValue]` 这种字典型解码不受影响）。
    ///
    /// 这条是整个解析层的立足点：所有列键都照抄后端字段名（`sales_7d` /
    /// `budget_utilization_rate`）。若哪天 Foundation 改了字典解码行为，这条用例会先红。
    func testRowKeysKeepSnakeCaseInDictionaryDecoding() throws {
        struct Probe: Decodable {
            let row: AdAnalysisRow
            let nested: AdAnalysisRow
        }

        let json = #"{"row":{"sales_7d":1.5,"budget_utilization_rate":0.25},"nested":{"top_of_search_impression_share":0.5}}"#
        let probe = try AdAnalysisFixtures.apiDecoder().decode(Probe.self, from: Data(json.utf8))

        XCTAssertEqual(probe.row.keys, ["sales_7d", "budget_utilization_rate"])
        XCTAssertEqual(probe.row.number("sales_7d"), 1.5)
        XCTAssertEqual(probe.nested.number("top_of_search_impression_share"), 0.5)
        XCTAssertNil(probe.row.number("sales7D"), "键被变换过就说明这条设计前提被打破了")
    }

    /// 结构体属性侧的对照：`project_id` 在 `convertFromSnakeCase` 下变成 `projectId`
    /// （不是 `projectID`）—— 信封的 `CodingKeys` 就是按这个写的。
    func testEnvelopeCodingKeysFollowSnakeCaseStrategy() throws {
        let payload = try AdAnalysisFixtures.payload(forTabKey: "campaigns")
        XCTAssertEqual(payload.projectID, 1, "project_id → projectId，写错会静默 nil")
        XCTAssertEqual(payload.country, "US")
    }

    // MARK: - 10 个 Tab 的信封

    /// 10 个 Tab 的快照都能解出「属于这个 Tab 的字段」，且明细非空。
    func testEveryTabSnapshotDecodesItsEnvelope() throws {
        for tab in AdAnalysisCatalog.tabs {
            let payload = try AdAnalysisFixtures.payload(forTabKey: tab.key)
            XCTAssertEqual(payload.projectID, 1, "\(tab.key): project_id")
            XCTAssertEqual(payload.country, "US", "\(tab.key): country")
            XCTAssertFalse(
                payload.detailRows(forTabKey: tab.key).isEmpty,
                "\(tab.key): 明细行不该为空（空说明信封字段名写错或快照被换）"
            )
            XCTAssertFalse(payload.isEmpty(forTabKey: tab.key), "\(tab.key): 空态判定")
        }
    }

    /// 各 Tab 的**专属**字段（`metrics` / `issue_cards` / `narrative_sections` /
    /// `summary_cards` / `comparison` / `summary`）只有该 Tab 有 —— 逐 Tab 钉住。
    func testTabSpecificEnvelopeFields() throws {
        let overview = try AdAnalysisFixtures.payload(forTabKey: "overview")
        XCTAssertEqual(overview.metrics.count, 9)
        XCTAssertEqual(overview.issueCards.count, 5)
        XCTAssertEqual(overview.narrativeSections.count, 4)
        XCTAssertEqual(overview.topCampaigns.count, 5)
        XCTAssertEqual(overview.topProducts.count, 5)
        XCTAssertEqual(overview.topWasteTerms.count, 5)
        XCTAssertEqual(overview.trendSummary.count, 7)
        XCTAssertEqual(overview.topCrossSellProducts.count, 5)
        XCTAssertTrue(overview.items.isEmpty, "总览没有 items")
        XCTAssertNil(overview.comparison, "不传日期时后端没有可比区间（口径 1）")

        let timeTrend = try AdAnalysisFixtures.payload(forTabKey: "time-trend")
        XCTAssertEqual(timeTrend.summary.count, 96, "全量历史 96 个报表日")
        XCTAssertNil(timeTrend.comparison, "同上：不传日期 → comparison 为 null")

        let campaigns = try AdAnalysisFixtures.payload(forTabKey: "campaigns")
        XCTAssertEqual(campaigns.items.count, 14)
        XCTAssertEqual(campaigns.summaryCards.count, 4)
        XCTAssertEqual(campaigns.narrativeSections.count, 3, "活动层 / 预算归因 / 关联放量")
        XCTAssertEqual(campaigns.narrativeSections.first?.evidence.count, 3)
        XCTAssertEqual(campaigns.narrativeSections.first?.drillTo, "campaigns")

        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "products").items.count, 10)
        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "products").summaryCards.count, 4)
        XCTAssertEqual(
            try AdAnalysisFixtures.payload(forTabKey: "purchased-products").items.count,
            9
        )
        XCTAssertTrue(
            try AdAnalysisFixtures.payload(forTabKey: "purchased-products").summaryCards.isEmpty,
            "已购买商品页没有 summary_cards（Web 也没有）"
        )
        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "search-terms").items.count, 621)
        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "targets").items.count, 17)
        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "placements").items.count, 51)
        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "budget").items.count, 1020)
        XCTAssertEqual(try AdAnalysisFixtures.payload(forTabKey: "traffic-quality").items.count, 933)
    }

    // MARK: - 列键（防「静默少一列」）

    /// 每个 Tab 的每一列都必须能在该 Tab 的快照里取到值 —— 这是「键名写错」唯一的
    /// 自动化防线（写错时列为空、显示占位「—」，肉眼很难从一屏表格里发现）。
    func testEveryColumnKeyResolvesInItsSnapshot() throws {
        for tab in AdAnalysisCatalog.tabs {
            let payload = try AdAnalysisFixtures.payload(forTabKey: tab.key)
            let rows = payload.detailRows(forTabKey: tab.key)
            let columns = AdAnalysisColumns.columns(forTabKey: tab.key)
            XCTAssertFalse(columns.isEmpty, "\(tab.key) 必须有列定义")

            for column in columns {
                XCTAssertTrue(
                    rows.contains { $0[column.key] != nil },
                    "\(tab.key).\(column.key)：快照里一行都没有这个键 —— 键名可能写错了"
                )
                XCTAssertTrue(
                    rows.contains { !column.text(in: $0).isEmpty },
                    "\(tab.key).\(column.key)：取到空串"
                )
            }
        }
    }

    // MARK: - 快照冻结（跨批次漂移防护）

    /// 提交的每一份快照的 `sha256` 必须与 `manifest.json` 记录的一致。
    ///
    /// 这是「跨端漂移防护」的锚点：后续批次复核同一形状时，先比 sha256 就知道快照有没有
    /// 被改动；若后端形状变了要换快照，就得同时更新 manifest 与 PR 里记的哈希 ——
    /// 不能悄悄换一份。
    func testCommittedSnapshotHashesMatchManifest() throws {
        let files = try AdAnalysisFixtures.allFiles()
        XCTAssertEqual(files.count, 12, "10 个 Tab 的全量快照 + 2 份窗口化快照")

        for file in files {
            let data = try AdAnalysisFixtures.data(fileName: file.file)
            XCTAssertEqual(
                AdAnalysisFixtures.sha256(of: data),
                file.sha256,
                "\(file.file) 与 manifest 记录的 sha256 不一致"
            )
            XCTAssertEqual(data.count, file.bytes, "\(file.file) 字节数")
        }
    }

    /// manifest 里的行数统计与解码结果一致（快照与元数据不脱节）。
    func testManifestCountsMatchDecodedPayloads() throws {
        for file in try AdAnalysisFixtures.allFiles() {
            let payload = try AdAnalysisFixtures.payload(fileName: file.file)
            var decoded: [String: Int] = [
                "items": payload.items.count,
                "summary": payload.summary.count,
                "summary_cards": payload.summaryCards.count,
                "metrics": payload.metrics.count,
                "issue_cards": payload.issueCards.count,
                "narrative_sections": payload.narrativeSections.count,
                "top_campaigns": payload.topCampaigns.count,
                "top_products": payload.topProducts.count,
                "top_waste_terms": payload.topWasteTerms.count,
                "trend_summary": payload.trendSummary.count,
                "top_cross_sell_products": payload.topCrossSellProducts.count,
            ]
            decoded = decoded.filter { $0.value > 0 }
            for (key, count) in file.counts where count > 0 {
                XCTAssertEqual(decoded[key], count, "\(file.file): \(key)")
            }
        }
    }

    // MARK: - 抽样数值（与 Web 同源同值的锚点）

    /// 逐 Tab 的实测值：这些数字都是从**真实响应**里抄下来的，比对 Web 时照它们念。
    func testSpotValuesMatchRealResponses() throws {
        let campaigns = try AdAnalysisFixtures.payload(forTabKey: "campaigns")
        let campaign = try XCTUnwrap(campaigns.items.first)
        XCTAssertEqual(campaign.string("campaign_name"), "自动-TR250E")
        XCTAssertEqual(campaign.string("status"), "ENABLED")
        XCTAssertEqual(campaign.string("targeting_type"), "自动投放")
        XCTAssertEqual(campaign.string("grade"), "B")
        XCTAssertEqual(campaign.number("spend") ?? 0, 1468.65, accuracy: 0.001)
        XCTAssertEqual(campaign.number("sales_7d") ?? 0, 4276.93, accuracy: 0.001)
        XCTAssertEqual(campaign.number("acos") ?? 0, 0.3434, accuracy: 0.0001)
        XCTAssertEqual(campaign.number("ctr") ?? 0, 0.0055, accuracy: 0.0001)
        XCTAssertEqual(campaign.string("next_action"), "稳定放量")

        let products = try AdAnalysisFixtures.payload(forTabKey: "products")
        let product = try XCTUnwrap(products.items.first)
        XCTAssertEqual(product.string("ad_sku"), "MJQ-TR250E")
        XCTAssertEqual(product.string("ad_asin"), "B0CJF8GL1H")
        XCTAssertEqual(product.int("orders_7d"), 132)
        XCTAssertEqual(product.number("cvr_7d") ?? 0, 0.0109, accuracy: 0.0001)

        let searchTerms = try AdAnalysisFixtures.payload(forTabKey: "search-terms")
        let term = try XCTUnwrap(searchTerms.items.first)
        XCTAssertEqual(term.string("search_term"), "autoclave")
        XCTAssertEqual(term.string("primary_campaign"), "A-Close 250NM")
        XCTAssertEqual(term.int("impression_rank"), 0, "0 要显示成 `-`（Web `rank || '-'`）")
        XCTAssertEqual(term.number("impression_share") ?? -1, 0, accuracy: 0.0001)

        let targets = try AdAnalysisFixtures.payload(forTabKey: "targets")
        let target = try XCTUnwrap(targets.items.first)
        XCTAssertEqual(target.string("target_text"), "substitutes")
        XCTAssertEqual(
            target.number("top_of_search_impression_share") ?? 0,
            0.1791,
            accuracy: 0.0001
        )

        let placements = try AdAnalysisFixtures.payload(forTabKey: "placements")
        let placement = try XCTUnwrap(placements.items.first)
        XCTAssertEqual(placement.string("placement"), "亚马逊站内的搜索结果顶部")
        XCTAssertEqual(placement.number("roas") ?? 0, 1.7273, accuracy: 0.0001)

        let budget = try AdAnalysisFixtures.payload(forTabKey: "budget")
        let budgetRow = try XCTUnwrap(budget.items.first)
        XCTAssertEqual(budgetRow.number("budget") ?? 0, 15.0, accuracy: 0.001)
        XCTAssertEqual(budgetRow.number("suggested_budget") ?? 0, 192.85, accuracy: 0.001)
        XCTAssertEqual(budgetRow.number("budget_gap") ?? 0, 177.85, accuracy: 0.001)

        let traffic = try AdAnalysisFixtures.payload(forTabKey: "traffic-quality")
        let trafficRow = try XCTUnwrap(traffic.items.first)
        XCTAssertEqual(trafficRow.string("risk_level"), "高风险")
        XCTAssertEqual(trafficRow.int("total_impressions"), 973)
        XCTAssertEqual(trafficRow.int("invalid_impressions"), 676)
        XCTAssertEqual(trafficRow.number("invalid_click_rate") ?? 0, 1.0, accuracy: 0.0001)

        let purchased = try AdAnalysisFixtures.payload(forTabKey: "purchased-products")
        let purchasedRow = try XCTUnwrap(purchased.items.first)
        XCTAssertEqual(purchasedRow.string("purchased_asin"), "B0G6C865B6")
        XCTAssertEqual(purchasedRow.number("other_sku_sales_7d") ?? 0, 2699.97, accuracy: 0.001)

        let timeTrend = try AdAnalysisFixtures.payload(forTabKey: "time-trend")
        let lastDay = try XCTUnwrap(timeTrend.summary.last)
        XCTAssertEqual(lastDay.string("report_date"), "2026-09-11")
        XCTAssertEqual(lastDay.int("clicks"), 47)
        XCTAssertEqual(lastDay.number("running_spend") ?? 0, 6942.21, accuracy: 0.001)

        let overview = try AdAnalysisFixtures.payload(forTabKey: "overview")
        XCTAssertEqual(
            overview.metrics.map(\.displayValue),
            ["$6,872.17", "$35,792.52", "48", "0.57%", "$1.76", "19.20%", "5.21", "96", "$9,039.88"]
        )
        // 后端已经算好展示串：`value` 是原始数值，`display_value` 才是两端都该显示的文本。
        XCTAssertEqual(try XCTUnwrap(overview.metrics.first).value, 6872.17, accuracy: 0.001)
    }

    // MARK: - 周期对比（带日期区间的快照）

    /// 带日期区间时后端给出 `comparison`（含 null 字段），映射到 KPI 磁贴的环比。
    func testWindowedSnapshotsCarryComparison() throws {
        let overview = try AdAnalysisFixtures.windowedPayload(forTabKey: "overview")
        let comparison = try XCTUnwrap(overview.comparison)
        XCTAssertEqual(comparison.currentStart, "2026-08-01")
        XCTAssertEqual(comparison.currentEnd, "2026-09-12")
        XCTAssertEqual(comparison.previousStart, "2026-06-19")
        XCTAssertEqual(comparison.previousEnd, "2026-07-31")
        XCTAssertEqual(comparison.spendChangeRatio ?? 0, -0.0036, accuracy: 0.00001)
        XCTAssertEqual(comparison.clicksChangeRatio ?? 0, -0.361, accuracy: 0.00001)
        XCTAssertEqual(
            comparison.summary,
            "当前周期在收缩花费的同时保持了产出，偏向收缩提效。"
        )

        // KPI 磁贴的环比映射（Web `changeRatioFor` 的表）。
        XCTAssertEqual(comparison.changeRatio(forMetricLabel: "Spend") ?? 0, -0.0036, accuracy: 0.00001)
        XCTAssertEqual(comparison.changeRatio(forMetricLabel: "Clicks") ?? 0, -0.361, accuracy: 0.00001)
        XCTAssertEqual(comparison.changeRatio(forMetricLabel: "CPC") ?? 0, 0.5594, accuracy: 0.00001)
        XCTAssertNil(comparison.changeRatio(forMetricLabel: "ROAS"), "映射表外的指标无环比")

        let timeTrend = try AdAnalysisFixtures.windowedPayload(forTabKey: "time-trend")
        let trendComparison = try XCTUnwrap(timeTrend.comparison)
        XCTAssertEqual(timeTrend.summary.count, 39, "2026-08-01 ~ 2026-09-12 共 39 个报表日")
        XCTAssertNil(trendComparison.salesChangeRatio, "趋势端点不返回销售环比 → null 要如实为 nil")
        XCTAssertEqual(trendComparison.cpcChangeRatio ?? 0, 0.5619, accuracy: 0.00001)
    }

    // MARK: - 总览明细合并

    /// 「总览」把五个来源合并成一张网格（Web DETAILS 区），分组、行数与键映射逐条钉住。
    func testOverviewGridMergesFiveSources() throws {
        let payload = try AdAnalysisFixtures.payload(forTabKey: "overview")
        let rows = AdAnalysisOverviewGrid.rows(from: payload)

        XCTAssertEqual(rows.count, 5 + 5 + 5 + 7 + 5, "活动 / SKU / 浪费词 / 日趋势(末7) / 关联购买")

        let groups = rows.compactMap { $0.string("group") }
        XCTAssertEqual(Array(groups.prefix(5)), Array(repeating: "活动 CAMP", count: 5))
        XCTAssertEqual(groups.filter { $0 == "SKU" }.count, 5)
        XCTAssertEqual(groups.filter { $0 == "浪费词 WASTE" }.count, 5)
        XCTAssertEqual(groups.filter { $0 == "日趋势 DAILY" }.count, 7)
        XCTAssertEqual(groups.filter { $0 == "关联购买 X-SELL" }.count, 5)

        let campaignRow = try XCTUnwrap(rows.first)
        XCTAssertEqual(campaignRow.string("name"), "A-Close 250NM")
        XCTAssertEqual(campaignRow.number("spend") ?? 0, 32.67, accuracy: 0.001)

        let wasteRow = try XCTUnwrap(rows.first { $0.string("group") == "浪费词 WASTE" })
        XCTAssertEqual(wasteRow.string("name"), "autoclave sterilizers")
        XCTAssertNil(wasteRow["sales_7d"], "浪费词行没有销售额（Web 传 0）→ 显示占位「—」")
        XCTAssertEqual(
            AdAnalysisColumns.overview.first { $0.key == "sales_7d" }?.text(in: wasteRow),
            AdAnalysisFormatting.missing
        )

        let crossSellRow = try XCTUnwrap(rows.first { $0.string("group") == "关联购买 X-SELL" })
        XCTAssertEqual(crossSellRow.string("name"), "MJQ-TR250NM → B0G6C865B6")
        XCTAssertEqual(crossSellRow.number("sales_7d") ?? 0, 2699.97, accuracy: 0.001)
        XCTAssertNil(crossSellRow["spend"], "关联购买行没有花费 → 占位「—」")

        let trendRow = try XCTUnwrap(rows.first { $0.string("group") == "日趋势 DAILY" })
        XCTAssertEqual(trendRow.string("name"), "2026-09-03")
        XCTAssertNotNil(trendRow["cpc"])
    }

    /// 空态判定：把明细清空即 `.empty`（**显示「无数据」而不是 0 / 报错**）。
    func testEmptyPayloadIsReportedAsEmpty() {
        let payload = AdAnalysisPayload()
        XCTAssertTrue(payload.isEmpty(forTabKey: "campaigns"))
        XCTAssertTrue(payload.isEmpty(forTabKey: "overview"))
        XCTAssertTrue(payload.isEmpty(forTabKey: "time-trend"))
        XCTAssertTrue(payload.detailRows(forTabKey: "time-trend").isEmpty)
    }

    // MARK: - 覆盖对照表（端点 ↔ 消费点）

    /// 10 个端点各有且只有一个消费点：Tab key 唯一、端点唯一、且列定义与明细字段一一对应。
    ///
    /// 这条用例是「覆盖对照表」的可执行版本 —— 多加一个 Tab（重复端点）或漏一个
    /// （没有列）都会红。
    func testEndpointCoverageIsOneTabPerEndpoint() {
        let tabs = AdAnalysisCatalog.tabs
        XCTAssertEqual(tabs.count, 10)
        XCTAssertEqual(Set(tabs.map(\.key)).count, 10, "Tab key 唯一")
        XCTAssertEqual(Set(tabs.map(\.endpoint)).count, 10, "端点唯一（一个 Tab 一个端点）")
        XCTAssertEqual(
            Set(tabs.map(\.endpoint)),
            Set([
                "/ad-analysis/overview",
                "/ad-analysis/time-trend",
                "/ad-analysis/campaigns",
                "/ad-analysis/products",
                "/ad-analysis/purchased-products",
                "/ad-analysis/search-terms",
                "/ad-analysis/targets",
                "/ad-analysis/placements",
                "/ad-analysis/budget",
                "/ad-analysis/traffic-quality",
            ])
        )
        for tab in tabs {
            XCTAssertFalse(
                AdAnalysisColumns.columns(forTabKey: tab.key).isEmpty,
                "\(tab.key) 没有列定义 → 该端点无消费点"
            )
        }
        XCTAssertTrue(
            AdAnalysisCatalog.tabs.contains { $0.key == AdAnalysisCatalog.defaultTabKey },
            "默认落地 Tab 必须存在"
        )
        XCTAssertEqual(AdAnalysisCatalog.tabs.map(\.label), [
            "总览", "趋势", "活动", "SKU", "已购买商品", "搜索词", "投放", "广告位", "预算", "流量质量",
        ], "Tab 文案与顺序以 Web config.ts 为准")
    }
}
