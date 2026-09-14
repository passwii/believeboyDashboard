import BelieveBoyKit
import Foundation
import XCTest

/// `AdDataClient` 的请求形状：路径 / 查询参数（**哨兵窗口**）/ 凭据与账号上下文头 / 分层超时。
///
/// 验收口径 4（列表档 5s、报表档 15s）只能在这一层证明：超时不是常量表里的一个数，而是按端点
/// 档位写进 `URLRequest.timeoutInterval` 的值 —— 所以断言取打桩记录里的**实际值**。同理，
/// 「10 个端点各走自己的路径」「不传 offset / order_by」也只能靠断言真实请求 URL 来证明。
final class AdDataClientTests: XCTestCase {
    private let baseURL = URL(string: "https://backend.test")!

    private static let projectsBody = #"""
    [
      {"id": 1, "name": "铨富", "brand_name": "MJQ", "country": "US", "is_active": true, "sort_order": 1,
       "project_operator": "测试员", "has_context": true, "vat_enabled": false},
      {"id": 4, "name": "玥涵", "country": "DE", "is_active": true, "sort_order": 4}
    ]
    """#

    private func makeClient(
        routes: [String: StubURLProtocol.Response]
    ) -> (AdDataClient, URLCapture) {
        let capture = URLCapture()
        let session = StubURLProtocol.session { request in
            capture.append(request.url)
            let path = request.url?.path ?? ""
            return routes[path] ?? .json(500, #"{"detail":"stub: unregistered path \#(path)"}"#)
        }
        let api = APIClient(
            baseURL: baseURL,
            apiKey: "blf_TEST",
            userContext: UserContext(operatorName: "测试员", userId: "user-1", isAdmin: true),
            session: session
        )
        return (AdDataClient(client: api), capture)
    }

    private func snapshotRoutes(uploadFiles: Bool = true) throws -> [String: StubURLProtocol.Response] {
        var routes: [String: StubURLProtocol.Response] = [
            "/api/v1/projects/manage": .json(200, Self.projectsBody),
        ]
        for type in AdDataCatalog.reportTypes {
            routes["/api/v1" + AdDataCatalog.rawEndpoint(projectID: 1, endpoint: type.endpoint)] = .json(
                200,
                try AdDataFixtures.text(fileName: try AdDataFixtures.file(forEndpoint: type.endpoint).file)
            )
        }
        if uploadFiles {
            routes["/api/v1" + AdDataCatalog.uploadFilesEndpoint(projectID: 1)] = .json(
                200,
                try AdDataFixtures.text(fileName: try AdDataFixtures.manifest().uploadFiles.file)
            )
        }
        return routes
    }

    // MARK: - 查询参数（口径 1 / 2）

    /// 未限定日期 → 发的是**哨兵窗口**，而不是省略参数（后端 `period` 必填）。
    func testNilDatesFallBackToSentinelWindow() async throws {
        let (client, capture) = try makeClient(routes: try snapshotRoutes())
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        _ = try await client.rawPayload(
            reportType: type,
            projectID: 1,
            query: AdDataQuery(country: "US")
        )

        let query = try XCTUnwrap(
            capture.query(forPath: "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw")
        )
        XCTAssertEqual(query, "country=US&end_date=2100-12-31&limit=10000&period=custom&start_date=2000-01-01")
        XCTAssertTrue(query.contains("period=custom"), "period 必填：不传会被 400 拒")
        XCTAssertTrue(query.contains("start_date=2000-01-01"))
        XCTAssertTrue(query.contains("end_date=2100-12-31"))
        XCTAssertTrue(query.contains("limit=10000"), "口径 2：单发 10000 行")
        XCTAssertFalse(query.contains("offset"), "口径 2：不做服务端 offset 翻页")
        XCTAssertFalse(query.contains("order_by"), "排序放客户端，不发 order_by")
    }

    func testExplicitWindowIsSentVerbatim() async throws {
        // 项目 id 换成 4：路径里的 id 必须来自参数（而不是写死 1）。
        var routes = try snapshotRoutes()
        routes["/api/v1/internal/ad-data/projects/4/ad-search-terms-raw"] = .json(
            200,
            try AdDataFixtures.text(
                fileName: try AdDataFixtures.file(forEndpoint: "search-terms").file
            )
        )
        let (client, capture) = try makeClient(routes: routes)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_search_term_report"))

        _ = try await client.rawPayload(
            reportType: type,
            projectID: 4,
            query: AdDataQuery(country: "DE", dateFrom: "2026-08-01", dateTo: "2026-09-12", limit: 500)
        )

        XCTAssertEqual(
            capture.query(forPath: "/api/v1/internal/ad-data/projects/4/ad-search-terms-raw"),
            "country=DE&end_date=2026-09-12&limit=500&period=custom&start_date=2026-08-01"
        )
    }

    /// 10 个端点各走自己的路径（端点写错一个字母就是 404）。
    func testEveryReportTypeUsesItsOwnEndpointPath() async throws {
        let (client, capture) = try makeClient(routes: try snapshotRoutes())

        for type in AdDataCatalog.reportTypes {
            _ = try await client.rawPayload(
                reportType: type,
                projectID: 1,
                query: AdDataQuery(country: "US")
            )
        }

        XCTAssertEqual(
            capture.urls.map(\.path),
            AdDataCatalog.reportTypes.map {
                "/api/v1/internal/ad-data/projects/1/ad-\($0.endpoint)-raw"
            }
        )
    }

    /// 入库文件列表：项目在路径里、只带 country + limit。
    func testUploadFilesRequestShape() async throws {
        let (client, capture) = try makeClient(routes: try snapshotRoutes())

        let items = try await client.uploadFiles(
            projectID: 1,
            query: AdUploadFilesQuery(country: "US")
        )

        XCTAssertEqual(capture.urls.map(\.path), ["/api/v1/internal/ad-data/projects/1/ad-upload-files"])
        XCTAssertEqual(capture.query(forPath: "/api/v1/internal/ad-data/projects/1/ad-upload-files"), "country=US&limit=500")
        XCTAssertEqual(items.count, 500)
    }

    // MARK: - 超时档

    /// 原始行走统计档（15s，对齐 Web 的 `AD_FETCH_TIMEOUT_MS = 15_000`）。
    func testRawPayloadUsesStatsTier() async throws {
        let (client, _) = try makeClient(routes: try snapshotRoutes())
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        _ = try await client.rawPayload(
            reportType: type,
            projectID: 1,
            query: AdDataQuery(country: "US")
        )

        XCTAssertEqual(StubURLProtocol.log.count, 1)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, RequestTier.stats.timeout)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, 15)
    }

    /// 项目列表与入库文件列表走列表档（5s）。
    func testLightweightRequestsUseListTier() async throws {
        let (client, _) = try makeClient(routes: try snapshotRoutes())

        _ = try await client.projects()
        _ = try await client.uploadFiles(projectID: 1, query: AdUploadFilesQuery(country: "US"))

        XCTAssertEqual(StubURLProtocol.log.count, 2)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, 5)
        XCTAssertEqual(StubURLProtocol.log[0].path, "/api/v1/projects/manage")
        XCTAssertEqual(StubURLProtocol.log[1].timeout, 5)
        XCTAssertEqual(StubURLProtocol.log[1].path, "/api/v1/internal/ad-data/projects/1/ad-upload-files")
    }

    /// 用的必须是 `/projects/manage`（按 `X-Operator` 过滤可见项目），不是 `/projects`。
    func testProjectsEndpointIsTheOperatorFilteredOne() {
        XCTAssertEqual(AdSharedCatalog.projectsEndpoint, "/projects/manage")
    }

    // MARK: - 请求头

    func testRequestCarriesCredentialAndAccountContext() async throws {
        let (client, _) = try makeClient(routes: try snapshotRoutes())
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        _ = try await client.rawPayload(
            reportType: type,
            projectID: 1,
            query: AdDataQuery(country: "US")
        )

        let log = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(log.apiKey, "blf_TEST")
        XCTAssertEqual(
            log.header("X-Operator")?.removingPercentEncoding,
            "测试员",
            "后端按 `unquote` 解读 `X-Operator`，中文名要能解回来"
        )
        XCTAssertEqual(log.header("X-User-Id"), "user-1")
        XCTAssertEqual(log.header("X-Is-Admin"), "true")
        XCTAssertEqual(log.method, "GET")
    }

    /// 没有凭据时不发请求（UI 提前拦截，避免一次必然 401 的往返）。
    func testMissingCredentialFailsWithoutRequest() async throws {
        let session = StubURLProtocol.session(routes: [:])
        let api = APIClient(baseURL: baseURL, apiKey: nil, session: session)
        let client = AdDataClient(client: api)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        do {
            _ = try await client.rawPayload(
                reportType: type,
                projectID: 1,
                query: AdDataQuery(country: "US")
            )
            XCTFail("没有凭据应当直接抛错")
        } catch let error as APIError {
            guard case .missingCredential = error else {
                return XCTFail("应当是 missingCredential，实际 \(error)")
            }
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "缺凭据不得发出请求")
    }

    // MARK: - 错误映射

    func testUnauthorizedMapsToCredentialError() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(403, #"{"detail":"forbidden"}"#),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdDataClient(client: api)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        do {
            _ = try await client.rawPayload(
                reportType: type,
                projectID: 1,
                query: AdDataQuery(country: "US")
            )
            XCTFail("403 应当抛错")
        } catch let error as APIError {
            XCTAssertTrue(error.requiresCredentialFix, "401/403 是「凭据需修」信号")
        }
    }

    /// 后端对缺 `period` 的请求回 400 `period is required` —— 这条是口径 1 的来源，
    /// 顺手把「错误体里的 detail 会透出到界面」也钉住。
    func testPeriodValidationErrorSurfacesDetail() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(400, #"{"detail":"period is required"}"#),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdDataClient(client: api)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        do {
            _ = try await client.rawPayload(
                reportType: type,
                projectID: 1,
                query: AdDataQuery(country: "US")
            )
            XCTFail("400 应当抛错")
        } catch let error as APIError {
            XCTAssertFalse(error.requiresCredentialFix, "400 不是凭据问题")
            XCTAssertTrue(error.displayMessage.contains("period is required"))
        }
    }

    func testMalformedBodyMapsToDecodingError() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(200, #"{"data": "not-an-array"}"#),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdDataClient(client: api)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        do {
            _ = try await client.rawPayload(
                reportType: type,
                projectID: 1,
                query: AdDataQuery(country: "US")
            )
            XCTFail("字段类型不对应当抛解码错误")
        } catch let error as APIError {
            guard case .decoding = error else {
                return XCTFail("应当是 decoding，实际 \(error)")
            }
        }
    }

    /// 空 `data`（真实的「这个窗口没有数据」）不是错误 —— 解成空列表，由 UI 显示空态。
    func testEmptyDataDecodesToEmptyPayload() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(
                200,
                #"{"project_id": 1, "country": "US", "period": {"type": "custom", "value": "custom", "start_date": "2000-01-01", "end_date": "2100-12-31"}, "data": [], "summary": {"total_rows": 0, "date_range": ["2000-01-01", "2100-12-31"]}}"#
            ),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdDataClient(client: api)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        let payload = try await client.rawPayload(
            reportType: type,
            projectID: 1,
            query: AdDataQuery(country: "US")
        )

        XCTAssertTrue(payload.data.isEmpty)
        XCTAssertEqual(payload.summary?.totalRows, 0)
        XCTAssertFalse(payload.isTruncated(), "0 行不是截断")
    }

    // MARK: - 真实快照走真实客户端

    /// 10 份快照（真实后端响应）经**真实** `APIClient` 路径解出来 —— 请求形状与解码在同一条
    /// 与被测代码一致的链路上跑通，避免「夹具用另一套解码器解对了、线上解不对」。
    func testRealSnapshotsDecodeThroughRealClient() async throws {
        let (client, _) = try makeClient(routes: try snapshotRoutes())

        for type in AdDataCatalog.reportTypes {
            let file = try AdDataFixtures.file(forEndpoint: type.endpoint)
            let payload = try await client.rawPayload(
                reportType: type,
                projectID: 1,
                query: AdDataQuery(country: "US")
            )
            XCTAssertEqual(payload.data.count, file.rows, "\(type.endpoint)")
            XCTAssertEqual(payload.projectID, 1)
        }
    }
}
