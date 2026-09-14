import Foundation
import XCTest

@testable import BelieveBoyKit

/// 真后端「同源同值」用例：**默认 skip**，配 `BELIEVEBOY_E2E_*` 才跑。
///
/// 为什么需要它（而不是只靠打桩）：打桩用的快照是**抓下来的**，它证明的是「解码器能解
/// 这一份 JSON」，证明不了「桌面端此刻算出来的数与后端此刻发出来的数一致」。这条用例
/// 对同一组端点做两次读 —— 一次走 `AgentOpsClient`，一次走裸 `URLSession` +
/// `JSONSerialization` —— 然后**逐字段比对**。两边都是真响应，故「同源同值」在这一层
/// 可自动验证，而不是靠人工抽样。
///
/// 跑法（本地后端 + 生产库快照 `BLF`，绝不用生产真人账号的 `blf_` key：
/// 登录会轮换该账号的 key）：
///
/// ```bash
/// cd backend && DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" \
///   .venv/bin/uvicorn app.main:app --port 8100   # <repo>/backend/.venv
/// # 另开一终端：
/// cd macos
/// BELIEVEBOY_E2E_BASE_URL=http://127.0.0.1:8100 \
/// BELIEVEBOY_E2E_API_KEY="$(grep '^API_KEY=' ../backend/.env | cut -d= -f2-)" \
/// BELIEVEBOY_E2E_OPERATOR=Yawei \
/// BELIEVEBOY_E2E_USER_ID=723c8e9a-8dbe-4b54-803e-0ec91430cee8 \
/// BELIEVEBOY_E2E_IS_ADMIN=true \
/// DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test --filter LiveAgentOpsTests
/// ```
///
/// `X-Operator` 一族必须与 Web 端登录会话一致：报表 / 巡检端点按操作员过滤可见项目，
/// 不带上下文时「今日产出」会是 0 个项目（而不是与 Web 相同的数字）。
final class LiveAgentOpsTests: XCTestCase {
    private struct LiveBackend {
        let baseURL: URL
        let apiKey: String
        let context: UserContext?
    }

    private func liveBackend() throws -> LiveBackend {
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["BELIEVEBOY_E2E_BASE_URL"],
              let baseURL = URL(string: raw),
              let apiKey = environment["BELIEVEBOY_E2E_API_KEY"]?.trimmedNonEmpty
        else {
            throw XCTSkip(
                "未配置 BELIEVEBOY_E2E_BASE_URL / _API_KEY —— 真后端同源同值用例跳过"
                    + "（本地后端 + 生产库快照的跑法见本文件注释）。"
            )
        }
        let context = UserContext(
            operatorName: environment["BELIEVEBOY_E2E_OPERATOR"],
            userId: environment["BELIEVEBOY_E2E_USER_ID"],
            isAdmin: environment["BELIEVEBOY_E2E_IS_ADMIN"] == "true"
        )
        return LiveBackend(baseURL: baseURL, apiKey: apiKey, context: context)
    }

    private func client(for backend: LiveBackend) -> AgentOpsClient {
        AgentOpsClient(
            client: APIClient(
                baseURL: backend.baseURL,
                apiKey: backend.apiKey,
                userContext: backend.context
            )
        )
    }

    /// 与 `APIClient` 同一条请求路径的裸读（同样的头、同样的前缀）。
    private func rawJSON(
        backend: LiveBackend,
        path: String,
        query: [String: String]
    ) async throws -> [String: Any] {
        var components = URLComponents(
            url: backend.baseURL.appendingPathComponent("/api/v1\(path)"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = query
            .sorted { $0.key < $1.key }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: try XCTUnwrap(components?.url))
        request.setValue(backend.apiKey, forHTTPHeaderField: "X-API-Key")
        for (field, value) in backend.context?.headers ?? [:] {
            request.setValue(value, forHTTPHeaderField: field)
        }
        let (data, _) = try await URLSession.shared.data(for: request)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any],
            "裸读应拿到 JSON 对象：\(path)"
        )
    }

    /// 业务域矩阵：逐域逐字段比对（调用量 / 写量 / 错误数 / 最近活动时间）。
    func testDomainSummaryMatchesRawWireValues() async throws {
        let backend = try liveBackend()
        let decoded = try await client(for: backend).domainSummary(windowDays: 7)
        let raw = try await rawJSON(
            backend: backend,
            path: "/agent-ops/domain-summary",
            query: ["days": "7"]
        )

        let rawItems = try XCTUnwrap(raw["items"] as? [[String: Any]])
        let rawByDomain = Dictionary(
            uniqueKeysWithValues: rawItems.map { ($0["domain"] as? String ?? "", $0) }
        )

        XCTAssertEqual(decoded.activityItems.count, rawItems.count, "条目数必须一致")
        for item in decoded.activityItems {
            let wire = try XCTUnwrap(rawByDomain[item.domain], "\(item.domain) 在裸读里不存在")
            XCTAssertEqual(item.calls24H, wire["calls_24h"] as? Int, "\(item.domain).calls_24h")
            XCTAssertEqual(item.calls7D, wire["calls_7d"] as? Int, "\(item.domain).calls_7d")
            XCTAssertEqual(item.writes24H, wire["writes_24h"] as? Int, "\(item.domain).writes_24h")
            XCTAssertEqual(item.writes7D, wire["writes_7d"] as? Int, "\(item.domain).writes_7d")
            XCTAssertEqual(item.errors7D, wire["errors_7d"] as? Int, "\(item.domain).errors_7d")
            XCTAssertEqual(
                item.lastActiveAt,
                wire["last_active_at"] as? String,
                "\(item.domain).last_active_at（时间戳要原样，不能被解码截断）"
            )
        }

        // 注册表补全后的行数必须恒为 17（后端只返回有调用的域）。
        let rows = AgentOverviewBuilder.rows(activity: decoded.activityItems)
        XCTAssertEqual(rows.count, AgentDomainCatalog.domains.count)
        XCTAssertGreaterThanOrEqual(rows.filter { $0.activity != nil }.count, rawItems.count)
    }

    /// 今日产出三源：与裸读的聚合结果一致（客诉 / 巡检 / 报表）。
    func testProductionSourcesMatchRawWireValues() async throws {
        let backend = try liveBackend()
        let client = client(for: backend)
        let usDate = AgentOpsFormatting.usToday()

        // 客诉
        let complaints = try await client.complaintProduction(usDate: usDate)
        let rawComplaints = try await rawJSON(
            backend: backend,
            path: "/complaints/overview",
            query: ["date": usDate]
        )
        let rawProjects = rawComplaints["projects"] as? [[String: Any]] ?? []
        let rawMetrics = rawComplaints["metrics"] as? [String: Any] ?? [:]
        XCTAssertEqual(complaints.hasRun, !rawProjects.isEmpty, "hasRun 必须与 projects 是否为空一致")
        XCTAssertEqual(
            complaints.needsReply,
            rawMetrics["total_needs_reply"] as? Int,
            "待回复数必须与 metrics.total_needs_reply 一致"
        )

        // 巡检（两跳：当前周期 → 概览）
        let inspections = try await client.inspectionProduction()
        let rawPeriod = try await rawJSON(
            backend: backend,
            path: "/inspections/periods/current",
            query: [:]
        )
        let periodID = try XCTUnwrap(rawPeriod["id"] as? Int)
        let rawOverview = try await rawJSON(
            backend: backend,
            path: "/inspections/periods/\(periodID)/overview",
            query: [:]
        )
        XCTAssertEqual(inspections.total, rawOverview["total_projects"] as? Int, "巡检 total_projects")
        XCTAssertEqual(
            inspections.submitted,
            rawOverview["submitted_count"] as? Int,
            "巡检 submitted_count"
        )

        // 报表：按 cell 聚合（Web `reduceUploadStatus` 口径）
        let reports = try await client.reportUploadCompletion(usDate: usDate, country: "US")
        let rawReports = try await rawJSON(
            backend: backend,
            path: "/rpa-reports/status",
            query: ["report_date": usDate, "country": "US"]
        )
        let rawItems = rawReports["items"] as? [[String: Any]] ?? []
        var expectedTotal = 0
        var expectedUploaded = 0
        for item in rawItems {
            for cell in item["statuses"] as? [[String: Any]] ?? [] {
                expectedTotal += 1
                if cell["is_uploaded"] as? Bool == true { expectedUploaded += 1 }
            }
        }
        XCTAssertEqual(reports.total, expectedTotal, "报表 cell 总数")
        XCTAssertEqual(reports.uploaded, expectedUploaded, "已上传 cell 数")

        // 巡检两头都用同一账号上下文 —— 报表数不为 0 说明 `X-Operator` 确实生效
        // （没有上下文时后端按「无可见项目」返回空矩阵，整列会变成 0/0）。
        XCTAssertGreaterThan(reports.total, 0, "带账号上下文时报表矩阵不该为空")
    }
}
