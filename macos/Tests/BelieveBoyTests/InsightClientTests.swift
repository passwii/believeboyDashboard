import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyKit

/// 洞察客户端的请求属性用例：端点路径 / 查询串 / 超时分层 / SSE 真实请求头。
///
/// 断言的判据全部取自 `StubURLProtocol.RequestLog`（**真实请求**），不是常量表 ——
/// 「超时策略生效」这类结论只有在请求上才立得住（BLF-1062 §验收 7：SSE 用例要断言真实
/// 请求属性，不只看常量表）。
final class InsightClientTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    override func setUp() {
        super.setUp()
        Self.recordedURLs.mutate { $0.removeAll() }
    }

    private func makeClient() -> InsightClient {
        InsightClient(
            client: APIClient(
                baseURL: baseURL,
                apiKey: "blf_TEST",
                userContext: UserContext.from(.fixtureAdmin),
                session: StubURLProtocol.session { request in
                    Self.recordedURLs.mutate { $0.append(request.url?.absoluteString ?? "") }
                    return Self.route(request)
                }
            )
        )
    }

    private static func route(_ request: URLRequest) -> StubURLProtocol.Response {
        let path = request.url?.path ?? ""
        let query = request.url?.query ?? ""
        switch true {
        case path.contains("/stream"):
            return .stream(200, chunks: ["data: {\"type\":\"ping\"}\n\n"], holdsOpen: false)
        case path.hasSuffix("/ai-insights"):
            return .json(200, InsightFixtureBodies.list)
        case path.hasSuffix("/ai-insights/schedules"):
            return .json(200, #"{"items": [], "total": 0}"#)
        case path.hasSuffix("/projects/manage"):
            return .json(200, InsightFixtureBodies.projects)
        case path.contains("/insight/runs/"):
            return .json(200, InsightFixtureBodies.runDetail)
        case path.contains("/ai-insights/"):
            return .json(200, InsightFixtureBodies.detail)
        case query.contains("limit"):
            return .json(200, InsightFixtureBodies.list)
        default:
            return .json(404, #"{"detail": "unmapped"}"#)
        }
    }

    // MARK: - 端点路径与查询串

    /// 6 条端点的路径形状（逐条对照 issue 的端点表）。
    func testEndpointPaths() async throws {
        let client = makeClient()
        _ = try await client.projects()
        _ = try await client.insights(query: InsightListQuery())
        _ = try await client.insightDetail(id: 46)
        _ = try await client.schedules(query: InsightScheduleQuery())
        _ = try await client.runDetail(runID: "b1f00000-0000-4000-8000-0000000000c1")

        XCTAssertEqual(
            StubURLProtocol.loggedPaths,
            [
                "/api/v1/projects/manage",
                "/api/v1/ai-insights",
                "/api/v1/ai-insights/46",
                "/api/v1/ai-insights/schedules",
                "/api/v1/insight/runs/b1f00000-0000-4000-8000-0000000000c1",
            ]
        )
    }

    /// 列表查询串：空值一律不发（后端按 `is not None` 判分支，发空串会被当成筛空值）。
    func testListQueryOmitsEmptyFilters() async throws {
        let client = makeClient()
        _ = try await client.insights(
            query: InsightListQuery(projectID: 1, country: "US", insightType: "ad_analysis")
        )
        _ = try await client.insights(query: InsightListQuery())

        let firstURL = try XCTUnwrap(StubURLProtocol.log.first?.path)
        XCTAssertEqual(firstURL, "/api/v1/ai-insights")
        // 逐条断言实发查询项（`StubURLProtocol.RequestLog` 不带 URL 查询串，故从请求 URL 读）。
        let firstQuery = try XCTUnwrap(
            URLComponents(string: Self.recordedURL(at: 1) ?? "")?.queryItems
        )
        let pairs = Dictionary(uniqueKeysWithValues: firstQuery.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(pairs["project_id"], "1")
        XCTAssertEqual(pairs["country"], "US")
        XCTAssertEqual(pairs["insight_type"], "ad_analysis")
        XCTAssertEqual(pairs["limit"], "20")
        XCTAssertEqual(pairs["offset"], "0")
        XCTAssertNil(pairs["status_filter"], "未指定的筛选不该出现在查询串里")

        let secondQuery = try XCTUnwrap(
            URLComponents(string: Self.recordedURL(at: 2) ?? "")?.queryItems
        )
        let secondPairs = Dictionary(uniqueKeysWithValues: secondQuery.map { ($0.name, $0.value ?? "") })
        XCTAssertNil(secondPairs["project_id"])
        XCTAssertNil(secondPairs["country"])
        XCTAssertNil(secondPairs["insight_type"])
    }

    /// 定时列表查询串：`is_active` 用 `true` / `false` 小写（后端 `bool` 解析口径）。
    func testScheduleQueryShape() async throws {
        let client = makeClient()
        _ = try await client.schedules(
            query: InsightScheduleQuery(projectID: 3, isActive: false, insightType: "custom")
        )
        let query = try XCTUnwrap(
            URLComponents(string: Self.recordedURL(at: 1) ?? "")?.queryItems
        )
        let pairs = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(pairs, ["project_id": "3", "is_active": "false", "insight_type": "custom"])
    }

    // MARK: - 超时分层

    /// 列表 / 明细 / 定时 / run detail 全部走 `.list`（5s）。
    func testReadEndpointsUseListTier() async throws {
        let client = makeClient()
        _ = try await client.insights(query: InsightListQuery())
        _ = try await client.insightDetail(id: 1)
        _ = try await client.schedules(query: InsightScheduleQuery())
        _ = try await client.runDetail(runID: "b1f00000-0000-4000-8000-0000000000c1")

        for request in StubURLProtocol.log {
            XCTAssertEqual(
                request.timeout,
                RequestTier.list.timeout,
                "\(request.path) 应当走列表档（5s）"
            )
        }
        XCTAssertEqual(InsightCatalog.readTier, .list)
    }

    /// 两条 SSE 走 `.stream` 档（写的是极大有限值，不是 Foundation 默认的 60s）。
    func testStreamsUseUnboundedTimeoutTier() async throws {
        let client = makeClient()
        _ = try await collect(client.insightStream(id: 46))
        _ = try await collect(client.runStream(runID: "run-1", lastEventID: nil))

        let streamRequests = StubURLProtocol.log.filter { $0.path.contains("/stream") }
        XCTAssertEqual(streamRequests.count, 2)
        for request in streamRequests {
            XCTAssertEqual(request.timeout, RequestTier.unboundedTimeout)
            XCTAssertNotEqual(request.timeout, 60, "默认 60s 会在 SSE 数据间隙处掐断")
        }
        XCTAssertEqual(InsightCatalog.streamTier, .stream)
    }

    // MARK: - SSE 真实请求头

    /// canonical 流：`Accept: text/event-stream` + `Last-Event-ID` 续传头（有游标时才写）。
    func testCanonicalStreamSendsAcceptAndResumeHeader() async throws {
        let client = makeClient()
        _ = try await collect(
            client.runStream(runID: "run-1", lastEventID: "run-1:1:1000001")
        )
        _ = try await collect(client.runStream(runID: "run-1", lastEventID: nil))

        let requests = StubURLProtocol.log.filter { $0.path.contains("/stream") }
        XCTAssertEqual(requests[0].header("Accept"), "text/event-stream")
        XCTAssertEqual(requests[0].header("Last-Event-ID"), "run-1:1:1000001")
        XCTAssertEqual(requests[0].header("Cache-Control"), "no-cache")
        XCTAssertEqual(requests[1].header("Last-Event-ID"), nil, "没有游标时不写这个头")
    }

    /// 旧链路流：**不**写 `Last-Event-ID`（后端不认这个头，写了也只是噪音）。
    func testLegacyStreamDoesNotSendResumeHeader() async throws {
        let client = makeClient()
        _ = try await collect(client.insightStream(id: 46))
        let request = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(request.path, "/api/v1/ai-insights/46/stream")
        XCTAssertEqual(request.header("Accept"), "text/event-stream")
        XCTAssertNil(request.header("Last-Event-ID"))
    }

    /// 凭据与账号上下文照常注入（直连不走代理，`X-Operator` 决定可见项目）。
    func testRequestsCarryCredentialAndOperatorContext() async throws {
        let client = makeClient()
        _ = try await client.projects()
        let request = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(request.apiKey, "blf_TEST")
        // `X-Operator` 走百分号编码（中文名要能过 HTTP 头），期望值直接取同一份
        // `UserContext` 的输出 —— 免得在测试里再抄一遍编码规则。
        XCTAssertEqual(
            request.header("X-Operator"),
            UserContext.from(.fixtureAdmin).headers["X-Operator"]
        )
        XCTAssertNotNil(request.header("X-Operator"))
        XCTAssertEqual(request.header("X-Is-Admin"), "true")
    }

    // MARK: - 错误分类

    /// 403 归类成 `unauthorized`（→ 重新登录），不是普通 HTTP 错误。
    func testUnauthorizedMapsToCredentialFix() async throws {
        let client = InsightClient(
            client: APIClient(
                baseURL: baseURL,
                apiKey: "blf_STALE",
                session: StubURLProtocol.session { _ in
                    .json(403, #"{"detail":"Invalid API key"}"#)
                }
            )
        )
        do {
            _ = try await client.insightDetail(id: 1)
            XCTFail("403 应当抛错")
        } catch let error as APIError {
            guard case .unauthorized(let status, _) = error else {
                return XCTFail("应当是 unauthorized：\(error)")
            }
            XCTAssertEqual(status, 403)
            XCTAssertTrue(error.requiresCredentialFix)
        }
    }

    /// 非法游标的 400 typed 错误：`status` 与 `body` 都要能读到（面板据此回退到 detail）。
    func testInvalidCursorErrorSurfacesTypedBody() async throws {
        let client = InsightClient(
            client: APIClient(
                baseURL: baseURL,
                apiKey: "blf_TEST",
                session: StubURLProtocol.session { _ in
                    .json(
                        400,
                        #"{"detail":{"code":"RESUME_CURSOR_INVALID","message":"bad cursor"}}"#
                    )
                }
            )
        )
        do {
            _ = try await collect(client.runStream(runID: "run-1", lastEventID: "bad"))
            XCTFail("400 应当在流的第一个错误上抛出")
        } catch let error as APIError {
            guard case .http(let status, let body) = error else {
                return XCTFail("应当是 http 错误：\(error)")
            }
            XCTAssertEqual(status, 400)
            XCTAssertTrue(body.contains("RESUME_CURSOR_INVALID"), body)
        }
    }

    // MARK: - 工具

    /// 把一条 SSE 消费到结束（流的第一个错误按 `throws` 抛出，与调用点用法一致）。
    private func collect(_ stream: AsyncThrowingStream<ServerSentEvent, Error>) async throws
        -> [ServerSentEvent]
    {
        var events: [ServerSentEvent] = []
        for try await event in stream { events.append(event) }
        return events
    }

    /// `StubURLProtocol.RequestLog` 只记 path、不记查询串，而查询串正是本文件要断言的东西
    /// （空值不发 / `is_active` 小写 / 分页参数）。故在桩件的 responder 里把完整 URL 另记一份
    /// （`LockedBox` 自带锁：responder 在 URLSession 队列上跑，断言在主线程读）。
    private static let recordedURLs = LockedBox<[String]>([])

    private static func recordedURL(at index: Int) -> String? {
        let urls = Self.recordedURLs.value
        guard index >= 1, index <= urls.count else { return nil }
        return urls[index - 1]
    }
}

/// 桩件用的固定响应体（与真实夹具同形，避免测试自己编字段名）。
enum InsightFixtureBodies {
    static let projects = #"""
    [{"id": 1, "name": "铨富", "country": "US", "is_active": true, "sort_order": 1}]
    """#

    static let list = #"""
    {"items": [{"id": 46, "project_id": 1, "project_name": "铨富", "country": "US",
    "title": "订单量降客单价升趋势走弱", "insight_type": "custom",
    "date_range_start": "2026-05-11", "date_range_end": "2026-05-17",
    "status": "completed", "sub_status": null, "error_message": null,
    "created_by": "纪亚伟", "created_at": "2026-05-18T10:00:00+08:00",
    "updated_at": "2026-05-18T10:05:00+08:00"}], "total": 1}
    """#

    static let detail = #"""
    {"id": 46, "project_id": 1, "project_name": "铨富", "country": "US",
    "title": "订单量降客单价升趋势走弱", "insight_type": "custom",
    "date_range_start": "2026-05-11", "date_range_end": "2026-05-17",
    "status": "completed", "sub_status": null, "error_message": null,
    "created_by": "纪亚伟", "created_at": "2026-05-18T10:00:00+08:00",
    "updated_at": "2026-05-18T10:05:00+08:00", "content": "# 标题\n\n正文",
    "strategy_metadata": null}
    """#

    static let runDetail = #"""
    {"schema_version": 1, "run_id": "b1f00000-0000-4000-8000-0000000000c1", "attempt": 1,
    "role_id": "ad_analysis", "role_version": 1, "project_id": 427, "country": "US",
    "status": "completed", "stage": "finalizing", "progress_percent": 100,
    "output_format": "markdown", "title": null,
    "outputs": {"main": {"format": "markdown", "content": "# 结论\n", "content_sha256": "ab"}},
    "artifact_id": null, "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
    "error": null,
    "resume": {"latest_event_id": null, "current_attempt": 1, "history_available": false},
    "created_at": "2026-09-14T15:54:54Z", "started_at": null, "completed_at": null,
    "updated_at": "2026-09-14T15:54:54Z"}
    """#
}
