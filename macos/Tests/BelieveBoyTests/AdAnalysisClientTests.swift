import BelieveBoyKit
import Foundation
import XCTest

/// `AdAnalysisClient` 的请求形状：路径 / 查询参数（**日期可空**）/ 凭据与账号上下文头 /
/// 分层超时。
///
/// 验收口径 5（列表档 5s、统计档 15s）只能在这一层证明：超时不是常量表里的一个数，
/// 而是按端点档位写进 `URLRequest.timeoutInterval` 的值 —— 所以断言取打桩记录里的**实际值**。
/// 同理，「不传日期 ≠ 最近 N 天」只能靠断言**查询串里没有** `date_from` / `date_to` 来证明。
final class AdAnalysisClientTests: XCTestCase {
    private let baseURL = URL(string: "https://backend.test")!

    private func makeClient(
        routes: [String: StubURLProtocol.Response]
    ) -> (AdAnalysisClient, URLCapture) {
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
        return (AdAnalysisClient(client: api), capture)
    }

    private func routes(forTabKeys tabKeys: [String]) throws -> [String: StubURLProtocol.Response] {
        var routes: [String: StubURLProtocol.Response] = [
            "/api/v1/projects/manage": .json(200, Self.projectsBody),
        ]
        for key in tabKeys {
            let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: key))
            routes["/api/v1" + tab.endpoint] = .json(
                200,
                try AdAnalysisFixtures.text(fileName: try AdAnalysisFixtures.fullHistoryFile(forTabKey: key).file)
            )
        }
        return routes
    }

    private static let projectsBody = #"""
    [
      {"id": 1, "name": "铨富", "brand_name": "MJQ", "country": "US", "is_active": true, "sort_order": 1,
       "project_operator": "测试员", "has_context": true, "vat_enabled": false},
      {"id": 4, "name": "玥涵", "country": "DE", "is_active": true, "sort_order": 4},
      {"id": 7, "name": "骏成", "country": "US", "is_active": false, "sort_order": 7}
    ]
    """#

    // MARK: - 查询参数（口径 1）

    /// 不传日期：查询串里**只有** `country` 与 `project_id` —— 后端据此聚合全量历史。
    func testQueryOmitsDatesWhenTheyAreNil() async throws {
        let (client, capture) = try makeClient(routes: try routes(forTabKeys: ["campaigns"]))
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "campaigns"))

        _ = try await client.payload(
            tab: tab,
            query: AdAnalysisQuery(projectID: 1, country: "US")
        )

        let query = try XCTUnwrap(capture.query(forPath: "/api/v1/ad-analysis/campaigns"))
        XCTAssertEqual(query, "country=US&project_id=1")
        XCTAssertFalse(query.contains("date_from"), "不传日期时**不得**带 date_from：\(query)")
        XCTAssertFalse(query.contains("date_to"), "不传日期时**不得**带 date_to：\(query)")
    }

    /// 空白日期串视同未传（UI 清空日期后不该发出 `date_from=`）。
    func testBlankDatesAreTreatedAsAbsent() throws {
        let query = AdAnalysisQuery(projectID: 1, country: "US", dateFrom: "  ", dateTo: "")
        XCTAssertEqual(query.parameters, ["project_id": "1", "country": "US"])
    }

    func testQueryCarriesDatesWhenPresent() async throws {
        let (client, capture) = try makeClient(routes: try routes(forTabKeys: ["time-trend"]))
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "time-trend"))

        _ = try await client.payload(
            tab: tab,
            query: AdAnalysisQuery(
                projectID: 4,
                country: "DE",
                dateFrom: "2026-08-01",
                dateTo: "2026-09-12"
            )
        )

        XCTAssertEqual(
            capture.query(forPath: "/api/v1/ad-analysis/time-trend"),
            "country=DE&date_from=2026-08-01&date_to=2026-09-12&project_id=4"
        )
    }

    /// 10 个 Tab 的路径与目录表逐一对应（端点不能写错一个字母）。
    func testEveryTabUsesItsOwnEndpointPath() async throws {
        let (client, capture) = try makeClient(routes: try routes(forTabKeys: AdAnalysisCatalog.tabs.map(\.key)))

        for tab in AdAnalysisCatalog.tabs {
            _ = try await client.payload(
                tab: tab,
                query: AdAnalysisQuery(projectID: 1, country: "US")
            )
        }

        XCTAssertEqual(
            capture.urls.map(\.path),
            AdAnalysisCatalog.tabs.map { "/api/v1" + $0.endpoint }
        )
    }

    // MARK: - 超时档

    /// ad-analysis 全部走统计档（15s，对齐 Web 的 `AD_FETCH_TIMEOUT_MS = 15_000`）。
    func testAdAnalysisRequestsUseStatsTier() async throws {
        let (client, _) = try makeClient(routes: try routes(forTabKeys: ["budget"]))
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "budget"))

        _ = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))

        XCTAssertEqual(StubURLProtocol.log.count, 1)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, RequestTier.stats.timeout)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, 15)
    }

    /// 项目列表走列表档（5s）。
    func testProjectsRequestUsesListTier() async throws {
        let (client, capture) = try makeClient(routes: try routes(forTabKeys: []))

        let projects = try await client.projects()

        XCTAssertEqual(StubURLProtocol.log.count, 1)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, RequestTier.list.timeout)
        XCTAssertEqual(StubURLProtocol.log[0].timeout, 5)
        XCTAssertEqual(capture.urls.map(\.path), ["/api/v1/projects/manage"])
        XCTAssertEqual(projects.map(\.id), [1, 4, 7])
        XCTAssertEqual(projects.first?.name, "铨富")
        XCTAssertEqual(projects[1].country, "DE")
        XCTAssertFalse(projects[2].isActive, "is_active 要解出来（项目列表里可能带停用项目）")
    }

    /// 用的必须是 `/projects/manage`（按 `X-Operator` 过滤可见项目），不是 `/projects`。
    func testProjectsEndpointIsTheOperatorFilteredOne() throws {
        XCTAssertEqual(AdAnalysisCatalog.projectsEndpoint, "/projects/manage")
    }

    // MARK: - 请求头

    /// 凭据 + 账号上下文：后端按 `X-Operator` 判定项目可见性，缺了会 403 或看到别人的数据。
    func testRequestCarriesCredentialAndAccountContext() async throws {
        let (client, _) = try makeClient(routes: try routes(forTabKeys: ["overview"]))
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "overview"))

        _ = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))

        let log = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(log.apiKey, "blf_TEST")
        // `X-Operator` 是中文：`UserContext` 按 Web 约定做 percent-encoding，后端
        // `_decode_header_value` 再解回来（两边对得上；写死明文反而会漏掉编码环节）。
        XCTAssertEqual(log.header("X-Operator"), "%E6%B5%8B%E8%AF%95%E5%91%98")
        XCTAssertEqual(
            log.header("X-Operator")?.removingPercentEncoding,
            "测试员",
            "后端按 `unquote` 解读，必须能解回中文名"
        )
        XCTAssertEqual(log.header("X-User-Id"), "user-1")
        XCTAssertEqual(log.header("X-Is-Admin"), "true")
        XCTAssertEqual(log.method, "GET")
    }

    /// 没有凭据时不发请求（UI 提前拦截，避免一次必然 401 的往返）。
    func testMissingCredentialFailsWithoutRequest() async throws {
        let session = StubURLProtocol.session(routes: [:])
        let api = APIClient(baseURL: baseURL, apiKey: nil, session: session)
        let client = AdAnalysisClient(client: api)
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "overview"))

        do {
            _ = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))
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
            "/api/v1/ad-analysis/overview": .json(403, #"{"detail":"forbidden"}"#),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdAnalysisClient(client: api)
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "overview"))

        do {
            _ = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))
            XCTFail("403 应当抛错")
        } catch let error as APIError {
            XCTAssertTrue(error.requiresCredentialFix, "401/403 是「凭据需修」信号")
        }
    }

    func testMalformedBodyMapsToDecodingError() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-analysis/overview": .json(200, #"{"items": "not-an-array"}"#),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdAnalysisClient(client: api)
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "overview"))

        do {
            _ = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))
            XCTFail("字段类型不对应当抛解码错误")
        } catch let error as APIError {
            guard case .decoding = error else {
                return XCTFail("应当是 decoding，实际 \(error)")
            }
        }
    }

    /// 空 `items`（真实的「这段时间没数据」）不是错误 —— 解成空列表，由 UI 显示空态。
    func testEmptyItemsDecodeToEmptyPayload() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-analysis/campaigns": .json(
                200,
                #"{"project_id": 1, "country": "US", "summary_cards": [], "narrative_sections": [], "items": []}"#
            ),
        ])
        let api = APIClient(baseURL: baseURL, apiKey: "blf_TEST", session: session)
        let client = AdAnalysisClient(client: api)
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "campaigns"))

        let payload = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))

        XCTAssertTrue(payload.isEmpty(forTabKey: "campaigns"))
        XCTAssertEqual(payload.projectID, 1)
    }

    // MARK: - 真实快照走真实客户端

    /// 快照本体（真实后端响应）经**真实** `APIClient` 路径解出来 —— 请求形状与解码在同一条
    /// 与被测代码一致的链路上跑通，避免「夹具用另一套解码器解对了、线上解不对」。
    func testRealSnapshotDecodesThroughRealClient() async throws {
        let (client, _) = try makeClient(routes: try routes(forTabKeys: ["search-terms"]))
        let tab = try XCTUnwrap(AdAnalysisCatalog.tab(key: "search-terms"))

        let payload = try await client.payload(tab: tab, query: AdAnalysisQuery(projectID: 1, country: "US"))

        XCTAssertEqual(payload.items.count, 621)
        XCTAssertEqual(payload.summaryCards.map(\.value), ["621", "10", "46", "0"])
        XCTAssertEqual(payload.items.first?.string("search_term"), "autoclave")
        XCTAssertEqual(payload.items.first?.number("acos") ?? 0, 0.0717, accuracy: 0.0001)
    }
}
