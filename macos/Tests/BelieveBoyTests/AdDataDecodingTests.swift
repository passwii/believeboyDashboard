import BelieveBoyKit
import XCTest

/// 快照 → 模型 → 列：把「与 Web 同源同值」拆成可执行的断言。
///
/// 这一层要钉住的都是**编译期看不见**的东西：后端这 10 个原始行端点返回的是
/// `list[dict[str, object]]`（每行 12–22 个业务字段 + 一整列中文 `raw_row`），键名写错不会有
/// 编译错误、也不会让解码失败，只会静默少一列或把数字变成占位。所以每条断言都指向一个具体
/// 的失效方式：
///
/// - 键名写错 → `testEveryColumnKeyResolvesInItsSnapshot`；
/// - 信封字段名写错（`convertFromSnakeCase` 的坑）→ `testEnvelopeCodingKeysFollowSnakeCaseStrategy`；
/// - 快照被无意改动（跨批次漂移的锚点）→ `testCommittedSnapshotHashesMatchManifest`；
/// - 「`summary.total_rows` 是本页行数而不是总数」这条口径被误解 → `testSummaryTotalRowsIsThisPageOnly`。
final class AdDataDecodingTests: XCTestCase {
    // MARK: - 解码策略的前置事实

    /// 动态行里的键**保持**后端的 snake_case（`APIClient` 的 `convertFromSnakeCase`
    /// 只作用于结构体属性，`[String: JSONValue]` 这种字典型解码不受影响）。
    ///
    /// 这条是整个解析层的立足点：所有列键都照抄后端字段名（`sales_7d` /
    /// `budget_utilization_rate`）。若哪天 Foundation 改了字典解码行为，这条用例会先红。
    func testRowKeysKeepSnakeCaseInDictionaryDecoding() throws {
        struct Probe: Decodable {
            let row: DynamicJSONRow
        }

        let json = #"{"row":{"sales_7d":1.5,"budget_utilization_rate":0.25,"raw_row":{"7天总销售额":"$0.0"}}}"#
        let probe = try AdDataFixtures.apiDecoder().decode(Probe.self, from: Data(json.utf8))

        XCTAssertEqual(probe.row.number("sales_7d"), 1.5)
        XCTAssertEqual(probe.row.number("budget_utilization_rate"), 0.25)
        XCTAssertEqual(probe.row["raw_row"]?["7天总销售额"]?.stringValue, "$0.0")
        XCTAssertNil(probe.row.number("sales7D"), "键被变换过就说明这条设计前提被打破了")
    }

    /// 结构体属性侧的对照：`project_id` 在 `convertFromSnakeCase` 下变成 `projectId`
    /// （不是 `projectID`）—— 信封的 `CodingKeys` 就是按这个写的。
    func testEnvelopeCodingKeysFollowSnakeCaseStrategy() throws {
        let payload = try AdDataFixtures.payload(forEndpoint: "campaigns")

        XCTAssertEqual(payload.projectID, 1, "project_id → projectId，写错会静默 nil")
        XCTAssertEqual(payload.country, "US")
        XCTAssertEqual(payload.period?.type, "custom")
        XCTAssertEqual(payload.period?.startDate, AdDataCatalog.sentinelStartDate)
        XCTAssertEqual(payload.period?.endDate, AdDataCatalog.sentinelEndDate)
        XCTAssertEqual(
            payload.summary?.dateRange,
            [AdDataCatalog.sentinelStartDate, AdDataCatalog.sentinelEndDate]
        )
    }

    // MARK: - 10 个报表类型的信封

    /// 10 个端点的快照都能解出信封，且行数与 `manifest.json` 记录一致。
    func testEveryReportTypeSnapshotDecodesItsEnvelope() throws {
        let manifest = try AdDataFixtures.manifest()

        for type in AdDataCatalog.reportTypes {
            let file = try AdDataFixtures.file(forEndpoint: type.endpoint)
            XCTAssertEqual(file.reportType, type.reportType, "\(type.endpoint): manifest 的类型对不上")
            let payload = try AdDataFixtures.payload(forEndpoint: type.endpoint)
            XCTAssertEqual(payload.projectID, 1, "\(type.endpoint): project_id")
            XCTAssertEqual(payload.country, "US", "\(type.endpoint): country")
            XCTAssertEqual(payload.returnedRowCount, file.rows, "\(type.endpoint): 行数")
            XCTAssertFalse(payload.data.isEmpty, "\(type.endpoint): 行不该为空")
            XCTAssertEqual(
                payload.summary?.totalRows,
                payload.returnedRowCount,
                "\(type.endpoint): summary.total_rows 就是本页返回行数（口径 2）"
            )
        }
        XCTAssertEqual(manifest.files.count, AdDataCatalog.reportTypes.count, "10 个端点各一份")
    }

    /// **口径 2**：`summary.total_rows` 是**本页返回行数**，不是窗口内总行数。
    ///
    /// 拿它当总数会让「可能被截断」这件事看不出来（`limit=200` 的夹具里它恒等于 200），
    /// 也会让页码类 UI 算错总页数。这条用例把口径钉在真实响应上。
    func testSummaryTotalRowsIsThisPageOnly() throws {
        let truncated = try AdDataFixtures.payload(forEndpoint: "campaigns")
        XCTAssertEqual(truncated.summary?.totalRows, 200)
        XCTAssertTrue(
            truncated.isTruncated(limit: 200),
            "顶到 limit 就必须判成「可能被截断」，而不是当作完整数据"
        )
        XCTAssertFalse(truncated.isTruncated(limit: AdDataCatalog.pageLimit))

        // 两个端点的全量数据本来就不到 200 行 → 是完整数据（同一个判据的另一侧）。
        let complete = try AdDataFixtures.payload(forEndpoint: "time-trends")
        XCTAssertEqual(complete.summary?.totalRows, 98)
        XCTAssertFalse(complete.isTruncated(limit: 200), "98 < 200 → 完整，不是截断")
        XCTAssertFalse(complete.isTruncated(limit: AdDataCatalog.pageLimit))
    }

    /// 10 个类型的 `limit=10000` 真实行数都不到上限（今天不截断）—— 结论来自抓取时实测，
    /// 记在 manifest 里可复核。
    func testPageLimitIsNotReachedByAnyReportType() throws {
        for file in try AdDataFixtures.manifest().files {
            XCTAssertLessThan(
                file.fullRows,
                AdDataCatalog.pageLimit,
                "\(file.endpoint): 全量行数已达页面 limit，口径 2 的「今天不截断」结论要重新评估"
            )
            XCTAssertGreaterThan(file.fullBytes, 0, "\(file.endpoint): 抓取时测得的字节数")
        }
    }

    // MARK: - 列键（防「静默少一列」）

    /// 每个报表类型的**每一列**都必须在快照的每一行里存在，且至少有一行取到实际值 ——
    /// 这是「键名写错」唯一的自动化防线（写错时该列整列为占位，肉眼很难从一屏表格里发现）。
    ///
    /// 原始行来自 Pydantic 的 `*RawRow` 强类型模型（字段全声明、不 `exclude_none`），
    /// 所以「每行都有全部键」是这条链路的**事实**，不是假设；哪天后端改成 `exclude_none`，
    /// 这条会红并提醒改成「至少一行有」。
    func testEveryColumnKeyResolvesInItsSnapshot() throws {
        for type in AdDataCatalog.reportTypes {
            let payload = try AdDataFixtures.payload(forReportTypeCode: type.reportType)
            XCTAssertFalse(type.columns.isEmpty, "\(type.reportType) 必须有列定义")

            for column in type.columns {
                let missingKey = payload.data.first { $0[column.key] == nil }
                XCTAssertNil(
                    missingKey,
                    "\(type.reportType).\(column.key)：有行没有这个键 —— 键名可能写错了"
                )
                XCTAssertTrue(
                    payload.data.contains { !column.text(in: $0).isEmpty && column.text(in: $0) != AdDataFormatting.missing },
                    "\(type.reportType).\(column.key)：所有行的该列都是占位 —— 取值或格式化可能坏了"
                )
            }
        }
    }

    /// 列 key 集合必须与后端 `*RawRow` 的业务字段**逐字**一致（含 `id` / `raw_row` 这类基类字段
    /// 不属于业务列，故这里比对「列 key 是行键的子集」+ 「业务字段数不被漏掉」）。
    func testColumnKeysAreSubsetOfRowKeysAndCoverAllBusinessFields() throws {
        for type in AdDataCatalog.reportTypes {
            let payload = try AdDataFixtures.payload(forReportTypeCode: type.reportType)
            guard let row = payload.data.first else {
                return XCTFail("\(type.reportType): 没有行")
            }
            let base = Set(["id", "source_file_id", "raw_row", "created_at"])
            let businessKeys = row.keys.subtracting(base)

            XCTAssertEqual(
                Set(type.columns.map(\.key)),
                businessKeys,
                "\(type.reportType): 列定义与后端行字段不一一对应"
                    + "（多出来的列会永远显示占位，漏掉的列会整块看不见）"
            )
        }
    }

    /// `raw_row` 是**未解析的中文列**——行内展开面板就画它，故必须真的存在且是对象。
    func testRawRowKeepsChineseColumns() throws {
        let payload = try AdDataFixtures.payload(forEndpoint: "campaigns")
        guard let raw = payload.data.first?["raw_row"]?.objectValue else {
            return XCTFail("campaigns 首行没有 raw_row")
        }

        XCTAssertFalse(raw.isEmpty)
        XCTAssertEqual(raw["广告活动名称"]?.stringValue, "Auto-DL18")
        XCTAssertEqual(raw["国家/地区"]?.stringValue, "美国")
        XCTAssertEqual(raw["定位类型"]?.stringValue, "自动投放")
        XCTAssertTrue(
            raw.keys.contains { $0.contains("展示量") },
            "中文列名应当原样保留（用于逐列核对上传原文）"
        )
    }

    // MARK: - 抽样数值（与 Web 同源同值）

    /// 抽样固定行的若干字段 —— 后端换了口径 / 自己把解析写歪了，这几条会直接红。
    func testSpotValuesMatchRealResponses() throws {
        let campaigns = try AdDataFixtures.payload(forEndpoint: "campaigns")
        let first = try XCTUnwrap(campaigns.data.first)
        XCTAssertEqual(first.int("id"), 7465)
        XCTAssertEqual(first.string("campaign_name"), "Auto-DL18")
        XCTAssertEqual(first.number("spend") ?? 0, 14.59, accuracy: 0.0001)
        XCTAssertEqual(first.number("budget") ?? 0, 20.0, accuracy: 0.0001)
        XCTAssertEqual(first.number("ctr") ?? 0, 0.00658, accuracy: 0.000001)
        XCTAssertEqual(first.int("impressions"), 760)
        XCTAssertEqual(first.int("clicks"), 5)
        XCTAssertEqual(first.string("report_start_date"), "2026-09-13")
        XCTAssertEqual(first.string("status"), "ENABLED")

        // 趋势端点：`country` 是中文（列名「国家/地区」），不是站点代码 —— 别顺手映射成 US。
        let trends = try AdDataFixtures.payload(forEndpoint: "time-trends")
        let latest = try XCTUnwrap(trends.data.first)
        XCTAssertEqual(latest.string("country"), "美国")
        XCTAssertEqual(latest.string("currency"), "USD")
        XCTAssertEqual(latest.number("spend") ?? 0, 95.85, accuracy: 0.0001)
        XCTAssertEqual(latest.number("cpc") ?? 0, 2.13, accuracy: 0.0001)
        XCTAssertEqual(trends.data.count, 98)

        // 搜索词份额：排名 / 份额是「非可加」列（聚合视图将来会隐藏它们）。
        let shares = try AdDataFixtures.payload(forEndpoint: "search-term-shares")
        let shareFirst = try XCTUnwrap(shares.data.first)
        XCTAssertEqual(shareFirst.string("search_term"), "freeze dryer machine")
        XCTAssertEqual(shareFirst.int("impression_rank"), 28)
        XCTAssertEqual(shareFirst.number("impression_share") ?? 0, 0.0027, accuracy: 0.000001)

        // 无效流量：比率是 0–1 的比值（展示时 ×100）。
        let traffic = try AdDataFixtures.payload(forEndpoint: "invalid-traffic")
        let trafficFirst = try XCTUnwrap(traffic.data.first)
        XCTAssertEqual(trafficFirst.int("total_impressions"), 1887)
        XCTAssertEqual(trafficFirst.int("invalid_impressions"), 897)
        XCTAssertEqual(trafficFirst.number("invalid_impression_rate") ?? 0, 0.475358, accuracy: 0.000001)
    }

    // MARK: - 入库文件（口径 3）

    /// `ad-upload-files` 的快照解得出，且**恰好**印证口径 3：列表被截断，久未入库的类型不出现。
    ///
    /// 这条用例的价值是把「不能拿这份列表给报表类型置灰」变成可执行事实：快照里没有
    /// `ad_search_term_report`，而搜索词的 raw 快照有 200 行（全量窗口 1321 行）。
    func testUploadFilesSnapshotDocumentsTruncation() throws {
        let items = try AdDataFixtures.uploadFiles()
        let manifest = try AdDataFixtures.manifest()

        XCTAssertEqual(items.count, manifest.uploadFiles.items)
        XCTAssertEqual(items.count, AdUploadFilesQuery.maxLimit, "取到端点上限 500 条")
        XCTAssertEqual(Set(items.map(\.reportType)), Set(manifest.uploadFiles.reportTypes))

        let listed = Set(items.map(\.reportType))
        XCTAssertFalse(
            listed.contains("ad_search_term_report"),
            "「搜索词」不在最近 500 份入库文件里（该类型久未入库 + 列表按 updated_at 截断）"
        )
        let searchTerms = try AdDataFixtures.payload(forReportTypeCode: "ad_search_term_report")
        XCTAssertFalse(
            searchTerms.data.isEmpty,
            "但它其实有数据 —— 故可用性只能由 raw 响应判定，不能照抄 Web 的置灰"
        )

        let first = try XCTUnwrap(items.first)
        XCTAssertEqual(first.reportType, "ad_budget_report")
        XCTAssertEqual(first.reportLabel, "预算")
        XCTAssertEqual(first.ingestionStatus, "success")
        XCTAssertEqual(first.isCurrent, true)
        XCTAssertEqual(first.version, 1)
        XCTAssertEqual(first.uploadedDay, "2026-09-14")
        XCTAssertNotNil(first.fileID)
    }

    /// 所有快照里的入库文件都是成功入库的当前版本（口径 3 的 `ingestion_status == "success"`）。
    func testUploadFilesAreSuccessfulCurrentVersions() throws {
        for item in try AdDataFixtures.uploadFiles() {
            XCTAssertEqual(item.ingestionStatus, "success", "\(item.reportType) 不是成功入库")
            XCTAssertEqual(item.isCurrent, true, "\(item.reportType) 不是当前版本")
        }
    }

    // MARK: - 快照冻结（跨批次漂移防护）

    /// 提交的每一份快照的 `sha256` 必须与 `manifest.json` 记录的一致。
    ///
    /// 快照是本批与 Web 对照的锚点：它被悄悄换掉，后面所有「同源同值」的断言就都失去意义。
    func testCommittedSnapshotHashesMatchManifest() throws {
        let manifest = try AdDataFixtures.manifest()
        let files = manifest.files.map(\.file) + [manifest.uploadFiles.file]

        for fileName in files {
            let data = try AdDataFixtures.data(fileName: fileName)
            let expected: String
            if let file = manifest.files.first(where: { $0.file == fileName }) {
                expected = file.sha256
                XCTAssertEqual(data.count, file.bytes, "\(fileName): 字节数")
            } else {
                expected = manifest.uploadFiles.sha256
                XCTAssertEqual(data.count, manifest.uploadFiles.bytes, "\(fileName): 字节数")
            }
            XCTAssertEqual(
                AdDataFixtures.sha256(of: data),
                expected,
                "\(fileName) 的 sha256 与 manifest 不一致 —— 重抓后必须同步更新 manifest 并在 PR 写明"
            )
        }
    }

    /// manifest 记着抓取口径（固定参数 + 抓取时点），PR 里引用的就是这一份。
    func testManifestRecordsCaptureContract() throws {
        let manifest = try AdDataFixtures.manifest()

        XCTAssertEqual(manifest.params.projectID, 1)
        XCTAssertEqual(manifest.params.country, "US")
        XCTAssertEqual(manifest.params.period, "custom", "口径 1：period 必填，不传会被 400 拒")
        XCTAssertEqual(manifest.params.startDate, AdDataCatalog.sentinelStartDate)
        XCTAssertEqual(manifest.params.endDate, AdDataCatalog.sentinelEndDate)
        XCTAssertEqual(manifest.params.pageLimit, AdDataCatalog.pageLimit, "页面口径 limit=10000")
        XCTAssertEqual(manifest.uploadFiles.limit, AdUploadFilesQuery.maxLimit)
        XCTAssertFalse(manifest.capturedAt.isEmpty)
        XCTAssertTrue(manifest.capturedAt.hasPrefix("2026-"), "抓取时点：\(manifest.capturedAt)")
    }
}
