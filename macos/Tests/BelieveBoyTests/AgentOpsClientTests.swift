import BelieveBoyKit
import Foundation
import XCTest

/// `AgentOpsClient` 的请求形状：路径 / 查询参数 / 凭据与账号上下文头 / **分层超时**。
///
/// 验收 3「列表超时 5s、统计 15s 的分层超时生效」只能在这一层证明：超时不是一个常量，
/// 而是按端点档位写进 `URLRequest.timeoutInterval` 的值，故断言取打桩记录里的实际值，
/// 不读常量表（读常量表只能证明「表里有这两个数」，证明不了「这个请求用的是那一档」）。
final class AgentOpsClientTests: XCTestCase {
    private let baseURL = URL(string: "https://backend.test")!

    private func makeClient(
        routes: [String: StubURLProtocol.Response],
        isAdmin: Bool = true
    ) -> (AgentOpsClient, URLCapture) {
        let capture = URLCapture()
        let session = StubURLProtocol.session { request in
            capture.append(request.url)
            let path = request.url?.path ?? ""
            return routes[path] ?? .json(500, #"{"detail":"stub: unregistered path \#(path)"}"#)
        }
        let api = APIClient(
            baseURL: baseURL,
            apiKey: "blf_TEST",
            userContext: UserContext(operatorName: "测试员", userId: "user-1", isAdmin: isAdmin),
            session: session
        )
        return (AgentOpsClient(client: api), capture)
    }

    /// 四个端点的真实路径（含巡检的两跳）。
    private var productionRoutes: [String: StubURLProtocol.Response] {
        [
            "/api/v1/agent-ops/domain-summary": .json(200, AgentOpsFixtures.domainSummary),
            "/api/v1/complaints/overview": .json(200, AgentOpsFixtures.complaintsWithRun),
            "/api/v1/inspections/periods/current": .json(200, AgentOpsFixtures.currentInspectionPeriod),
            "/api/v1/inspections/periods/17/overview": .json(200, AgentOpsFixtures.inspectionOverview),
            "/api/v1/rpa-reports/status": .json(200, AgentOpsFixtures.reportStatus),
        ]
    }

    // MARK: - 路径与查询参数

    func testDomainSummaryUsesSevenDayWindow() async throws {
        let (client, capture) = makeClient(routes: productionRoutes)

        let response = try await client.domainSummary()

        XCTAssertEqual(response.activityItems.count, 8, "真实快照应被原样解出")
        XCTAssertEqual(capture.query(forPath: "/api/v1/agent-ops/domain-summary"), "days=7")
    }

    func testInspectionProductionThreadsPeriodIdentifierFromCurrentPeriod() async throws {
        let (client, _) = makeClient(routes: productionRoutes)

        let production = try await client.inspectionProduction()

        XCTAssertEqual(production.submitted, 0)
        XCTAssertEqual(production.total, 10)
        // 第二跳的 id 必须来自第一跳的响应（写死 id 会在周期滚动后 404）。
        XCTAssertEqual(
            StubURLProtocol.loggedPaths,
            [
                "/api/v1/inspections/periods/current",
                "/api/v1/inspections/periods/17/overview",
            ]
        )
    }

    func testProductionQueriesCarryUsDateAndCountry() async throws {
        let (client, capture) = makeClient(routes: productionRoutes)

        _ = try await client.complaintProduction(usDate: "2026-09-13")
        _ = try await client.reportUploadCompletion(usDate: "2026-09-13", country: "US")

        XCTAssertEqual(capture.query(forPath: "/api/v1/complaints/overview"), "date=2026-09-13")
        // `APIClient` 把查询参数按键名排序（与后端无关，但是一条稳定契约）：
        // country 在 report_date 之前。
        XCTAssertEqual(
            capture.query(forPath: "/api/v1/rpa-reports/status"),
            "country=US&report_date=2026-09-13"
        )
    }

    // MARK: - 分层超时

    /// 矩阵（统计档）15s；其余三源（列表档）5s。
    func testTimeoutTiersMatchEndpointClass() async throws {
        let (client, _) = makeClient(routes: productionRoutes)

        _ = try await client.domainSummary()
        _ = try await client.complaintProduction(usDate: "2026-09-13")
        _ = try await client.inspectionProduction()
        _ = try await client.reportUploadCompletion(usDate: "2026-09-13", country: "US")

        let timeouts = Dictionary(
            StubURLProtocol.log.map { ($0.path, $0.timeout) },
            uniquingKeysWith: { first, _ in first }
        )
        XCTAssertEqual(timeouts["/api/v1/agent-ops/domain-summary"], 15, "聚合统计走 stats 档")
        XCTAssertEqual(timeouts["/api/v1/complaints/overview"], 5)
        XCTAssertEqual(timeouts["/api/v1/inspections/periods/current"], 5)
        XCTAssertEqual(timeouts["/api/v1/inspections/periods/17/overview"], 5)
        XCTAssertEqual(timeouts["/api/v1/rpa-reports/status"], 5)
    }

    // MARK: - 凭据与账号上下文

    /// 四个请求都必须带 `X-API-Key` 与账号上下文：报表 / 巡检端点按 `X-Operator`
    /// 过滤可见项目，漏发这一个头会让「今日产出」整列变成 0/0（而不是报错）。
    func testRequestsCarryCredentialAndAccountContext() async throws {
        let (client, _) = makeClient(routes: productionRoutes, isAdmin: false)

        _ = try await client.domainSummary()
        _ = try await client.complaintProduction(usDate: "2026-09-13")
        _ = try await client.inspectionProduction()
        _ = try await client.reportUploadCompletion(usDate: "2026-09-13", country: "US")

        XCTAssertEqual(StubURLProtocol.log.count, 5)
        for entry in StubURLProtocol.log {
            XCTAssertEqual(entry.apiKey, "blf_TEST", "\(entry.path) 缺 X-API-Key")
            XCTAssertEqual(entry.header("X-User-Id"), "user-1", "\(entry.path) 缺账号上下文")
            XCTAssertEqual(entry.header("X-Is-Admin"), "false", "\(entry.path) 的管理员位应为显式 false")
            XCTAssertNotNil(entry.header("X-Operator"), "\(entry.path) 缺 X-Operator")
        }
    }

    /// 无凭据时请求**不发**（`APIClient` 在拼请求阶段就拦下），错误是
    /// `missingCredential` 而不是 401 往返 —— 状态机据此显示「未登录」而非「key 被拒绝」。
    func testMissingCredentialFailsBeforeSending() async {
        let session = StubURLProtocol.session(routes: productionRoutes)
        let client = AgentOpsClient(client: APIClient(baseURL: baseURL, apiKey: nil, session: session))

        do {
            _ = try await client.domainSummary()
            XCTFail("没有凭据不应发出请求")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingCredential)
            XCTAssertTrue(error.requiresCredentialFix, "缺凭据要导向重新登录")
        } catch {
            XCTFail("期望 APIError.missingCredential，实得 \(error)")
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty)
    }

    // MARK: - 失败形态

    /// 401/403 归类为 `unauthorized`（UI 据此回登录页），不是普通 http 错误。
    func testUnauthorizedSurfacesAsCredentialFailure() async {
        let (client, _) = makeClient(routes: [
            "/api/v1/agent-ops/domain-summary": .json(403, #"{"detail":"Invalid API key"}"#),
        ])

        do {
            _ = try await client.domainSummary()
            XCTFail("403 应抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized(status: 403, body: #"{"detail":"Invalid API key"}"#))
            XCTAssertTrue(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError.unauthorized，实得 \(error)")
        }
    }

    /// 响应体形状不对 → `decoding`（不能静默当成空矩阵：那会把「后端契约变了」
    /// 显示成「这段时间没有业务活动」）。
    func testMalformedPayloadSurfacesAsDecodingFailure() async {
        let (client, _) = makeClient(routes: [
            "/api/v1/agent-ops/domain-summary": .json(200, #"{"items":[{"domain":"shipments"}]}"#),
        ])

        do {
            _ = try await client.domainSummary()
            XCTFail("缺字段应抛解码错误")
        } catch let error as APIError {
            guard case .decoding = error else {
                return XCTFail("期望 APIError.decoding，实得 \(error)")
            }
        } catch {
            XCTFail("期望 APIError.decoding，实得 \(error)")
        }
    }
}
