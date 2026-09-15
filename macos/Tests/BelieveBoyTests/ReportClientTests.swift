import BelieveBoyKit
import Foundation
import XCTest

/// `ProductAnalysisClient` / `ReportAutomationClient` 的**真实请求属性**断言：
/// 路径 / 方法 / `Content-Type`（multipart 边界）/ 请求体字段名 / 分层超时。
///
/// 为什么这一层必须断言打桩记录里的实际值：本批是计划里第一条写链路，
/// 「multipart 真发」与「commit 传什么」都不能只看调用点代码 —— 后端对这两条的失败形态
/// 分别是 400（缺 file 字段）与 422（键名不是 snake_case），都不会在客户端编译期暴露。
///
/// 识别与入库的响应体取自真实快照（`Fixtures/Report/`），故这里同时钉住「客户端确实能解
/// 后端的真实响应」。
final class ReportClientTests: XCTestCase {
    private let baseURL = URL(string: "https://backend.test")!

    private func makeClient(session: URLSession) -> APIClient {
        APIClient(
            baseURL: baseURL,
            apiKey: "blf_TEST",
            userContext: UserContext(operatorName: "测试员", userId: "user-1", isAdmin: true),
            session: session
        )
    }

    private func makeSyntheticReport() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1068-\(UUID().uuidString)-广告推广的商品报告.csv")
        try """
        开始日期,结束日期,广告SKU,广告ASIN,广告活动名称,广告组名称
        2026-09-07,2026-09-07,JDB-10PCS1-4,B0G1SPQL12,夹具广告活动,夹具广告组
        """.write(to: url, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    // MARK: - 识别（multipart）

    /// `POST /ad-upload/recognize`：multipart 真发、字段名 `file` + `country`、
    /// `Content-Type` 含 boundary、显式 `Content-Length`、中文文件名双形态、走报表档（60s）。
    func testRecognizeSendsRealMultipartWithFileAndCountryFields() async throws {
        let recognitionText = try ReportFixtures.text(fileName: "ad-upload-recognize.json")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/recognize": .json(200, recognitionText),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))

        let fileURL = try makeSyntheticReport()
        let recognition = try await client.recognizeAdUpload(
            fileURL: fileURL,
            filename: "广告推广的商品报告.csv",
            country: "DE"
        )

        // 响应确实来自真实快照（解码路径与线上一致）。
        XCTAssertEqual(recognition.reportType, "ad_promoted_product_report")
        XCTAssertEqual(recognition.projectMatch.status, .matched)

        let log = try XCTUnwrap(StubURLProtocol.log.last)
        XCTAssertEqual(log.method, "POST")
        XCTAssertEqual(log.path, "/api/v1/ad-upload/recognize")
        let contentType = try XCTUnwrap(log.header("Content-Type"))
        XCTAssertTrue(
            contentType.hasPrefix("multipart/form-data; boundary="),
            "实际 Content-Type：\(contentType)"
        )
        let boundary = String(contentType.dropFirst("multipart/form-data; boundary=".count))
        XCTAssertFalse(boundary.isEmpty)

        let body = try XCTUnwrap(log.body, "multipart 体必须真发出去（httpBodyStream 也要读得到）")
        XCTAssertTrue(body.contains("--\(boundary)"), "段分隔用的就是头上那个 boundary")
        XCTAssertTrue(body.contains("name=\"country\""), "`country` 是 Form 字段")
        XCTAssertTrue(body.contains("\r\nDE\r\n"), "country 的值原样发（默认 US，这里显式 DE）")
        XCTAssertTrue(body.contains("name=\"file\""), "字段名必须是 `file`（后端 `File(...)`）")
        XCTAssertTrue(body.contains("广告推广的商品报告.csv"), "中文文件名原样进 body")
        XCTAssertTrue(body.contains("filename*=UTF-8''"), "RFC 5987 兜底形态也要有")
        XCTAssertTrue(body.hasSuffix("--\(boundary)--\r\n"), "结束段形状（RFC 7578 §4.1）")

        let declaredLength = try XCTUnwrap(log.header("Content-Length")).flatMap(Int.init)
        XCTAssertEqual(
            declaredLength,
            body.data(using: .utf8)?.count,
            "声明的 Content-Length 必须等于实际体的字节数（不写就会退化成 chunked）"
        )

        XCTAssertEqual(log.timeout, RequestTier.report.timeout, "识别要解析整份文件，走报表档 60s")
        XCTAssertEqual(log.header("X-API-Key"), "blf_TEST")
        XCTAssertEqual(log.header("X-User-Id"), "user-1")
        XCTAssertEqual(log.header("X-Is-Admin"), "true")
    }

    /// 识别失败（真实 400 体）→ 错误分类是 `.http`，**不是**凭据问题，且中文/英文 detail 可见。
    func testRecognizeFailureSurfacesBackendDetailWithoutCredentialSignal() async throws {
        let envelope = try ReportFixtures.errorEnvelope(
            fileName: "ad-upload-recognize-unknown-headers.json"
        )
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/recognize": .json(
                envelope.status,
                #"{"detail":"\#(envelope.detail)"}"#
            ),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))
        let fileURL = try makeSyntheticReport()

        do {
            _ = try await client.recognizeAdUpload(
                fileURL: fileURL,
                filename: "随便一个报表.csv",
                country: "US"
            )
            XCTFail("400 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .http(status: 400, body: #"{"detail":"\#(envelope.detail)"}"#))
            XCTAssertFalse(error.requiresCredentialFix, "识别失败不是凭据问题")
            XCTAssertTrue(error.displayMessage.contains(envelope.detail), error.displayMessage)
        }
    }

    // MARK: - 入库（JSON）

    /// `POST /ad-upload/commit`：JSON 体 + **snake_case 键名** + `dry_run` + 报表档（60s）。
    ///
    /// 键名写成 camelCase 会被后端当缺字段 → 422（`report_type does not match recognized
    /// report` 之类），而客户端编译期毫无提示 —— 所以逐键断言。
    func testCommitSendsSnakeCaseJSONBody() async throws {
        let commitText = try ReportFixtures.text(fileName: "ad-upload-commit-dry-run.json")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/commit": .json(200, commitText),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))
        let recognition = try ReportFixtures.recognition()

        let result = try await client.commitAdUpload(
            AdUploadCommitRequest(
                tempFileID: recognition.tempFileID,
                reportType: recognition.reportType,
                originalFilename: recognition.originalFilename,
                projectName: "创酷",
                country: "US",
                reportDate: recognition.detectedReportDate,
                reportStartDate: recognition.detectedStartDate,
                reportEndDate: recognition.detectedEndDate,
                dryRun: true
            )
        )

        XCTAssertEqual(result.ingestionStatus, "skipped")
        XCTAssertFalse(result.fileID.isEmpty)

        let log = try XCTUnwrap(StubURLProtocol.log.last)
        XCTAssertEqual(log.method, "POST")
        XCTAssertEqual(log.path, "/api/v1/ad-upload/commit")
        XCTAssertEqual(log.header("Content-Type"), "application/json")
        let body = try XCTUnwrap(log.jsonObject)
        XCTAssertEqual(body["temp_file_id"] as? String, recognition.tempFileID)
        XCTAssertEqual(body["report_type"] as? String, "ad_promoted_product_report")
        XCTAssertEqual(body["original_filename"] as? String, recognition.originalFilename)
        XCTAssertEqual(body["project_name"] as? String, "创酷")
        XCTAssertEqual(body["country"] as? String, "US")
        XCTAssertEqual(body["report_date"] as? String, "2026-09-07")
        XCTAssertEqual(body["report_start_date"] as? String, "2026-09-07")
        XCTAssertEqual(body["report_end_date"] as? String, "2026-09-07")
        XCTAssertEqual(body["dry_run"] as? Bool, true, "手动核算链路一律 dry_run（不写业务表）")
        XCTAssertEqual(
            Set(body.keys),
            [
                "temp_file_id", "report_type", "original_filename", "project_name",
                "country", "report_date", "report_start_date", "report_end_date", "dry_run",
            ],
            "键名全集 —— 多一个少一个都会让后端 422 / 静默取默认值"
        )
        XCTAssertEqual(log.timeout, RequestTier.report.timeout)
    }

    /// 入库时的可选字段为 nil 时，编码器会**省略**它们（后端 `report_date: str | None = None`
    /// 本来就允许缺），而不是发 `null`。
    func testCommitOmitsNilOptionals() async throws {
        let commitText = try ReportFixtures.text(fileName: "ad-upload-commit-dry-run.json")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/commit": .json(200, commitText),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))

        _ = try await client.commitAdUpload(
            AdUploadCommitRequest(tempFileID: "tmp", reportType: "ad_campaign_report", dryRun: true)
        )

        let body = try XCTUnwrap(StubURLProtocol.log.last?.jsonObject)
        XCTAssertNil(body["original_filename"])
        XCTAssertNil(body["report_date"])
        XCTAssertEqual(body["country"] as? String, "US", "country 有默认值，必须发")
        XCTAssertEqual(body["dry_run"] as? Bool, true)
    }

    /// 入库 422（类型与识别不一致）→ `.http`，detail 原样可见。
    func testCommitTypeMismatchSurfaces422() async throws {
        let envelope = try ReportFixtures.errorEnvelope(
            fileName: "ad-upload-commit-type-mismatch.json"
        )
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/commit": .json(
                envelope.status,
                #"{"detail":"\#(envelope.detail)"}"#
            ),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))
        do {
            _ = try await client.commitAdUpload(
                AdUploadCommitRequest(tempFileID: "tmp", reportType: "ad_campaign_report", dryRun: true)
            )
            XCTFail("422 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .http(status: 422, body: #"{"detail":"\#(envelope.detail)"}"#))
            XCTAssertTrue(error.displayMessage.contains(envelope.detail))
        }
    }

    // MARK: - 状态列表 / 项目

    /// `GET /ad-upload/status`：query 逐项对上（有值的才发），走列表档（5s）。
    func testAdUploadStatusQueryShapeAndListTier() async throws {
        let statusText = try ReportFixtures.text(fileName: "ad-upload-status.json")
        let capture = URLCapture()
        let session = StubURLProtocol.session { request in
            capture.append(request.url)
            return .json(200, statusText)
        }
        let client = ProductAnalysisClient(client: makeClient(session: session))

        let response = try await client.adUploadStatuses(AdUploadStatusQuery())
        XCTAssertEqual(response.items.count, ReportCatalog.adUploadStatusLimit)

        _ = try await client.adUploadStatuses(
            AdUploadStatusQuery(projectName: "创酷", reportType: "ad_promoted_product_report", reportDate: "2026-09-07")
        )

        let logs = StubURLProtocol.log
        XCTAssertEqual(logs.map(\.path), ["/api/v1/ad-upload/status", "/api/v1/ad-upload/status"])
        XCTAssertEqual(capture.query(forPath: "/api/v1/ad-upload/status"), "country=US&limit=50")
        let second = try XCTUnwrap(capture.urls.last?.query)
        XCTAssertTrue(second.contains("project_name="), second)
        XCTAssertTrue(second.contains("report_type="), second)
        XCTAssertTrue(second.contains("report_date="), second)
        XCTAssertEqual(logs.map(\.timeout), [5, 5], "列表档")
    }

    /// 项目列表复用既有同源实现（`/projects/manage`，列表档 5s）。
    func testProjectsUsesSharedManagedEndpoint() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/projects/manage": .json(200, #"[{"id": 1, "name": "创酷", "is_active": true}]"#),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))

        let projects = try await client.projects()
        XCTAssertEqual(projects.map(\.name), ["创酷"])
        XCTAssertEqual(StubURLProtocol.log.last?.path, "/api/v1/projects/manage")
        XCTAssertEqual(StubURLProtocol.log.last?.timeout, RequestTier.list.timeout)
    }

    // MARK: - 异步核算任务

    /// 发起核算：JSON 体 snake_case + **detail 档（10s）**。
    func testCreateReportSendsSnakeCaseBodyOnDetailTier() async throws {
        let ticketText = try ReportFixtures.text(fileName: "product-analysis-report-create.json")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/product-analysis-reports": .json(200, ticketText),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))

        let ticket = try await client.createProductAnalysisReport(
            ProductAnalysisReportRequest(
                projectName: "创酷",
                reportStartDate: "2026-08-31",
                reportEndDate: "2026-09-06",
                businessReportFileID: "b.csv",
                paymentReportFileID: "p.csv",
                adReportFileID: "a.csv",
                country: "US"
            )
        )
        XCTAssertEqual(ticket.jobID, 1)

        let log = try XCTUnwrap(StubURLProtocol.log.last)
        XCTAssertEqual(log.method, "POST")
        XCTAssertEqual(log.path, "/api/v1/product-analysis-reports")
        let body = try XCTUnwrap(log.jsonObject)
        XCTAssertEqual(body["project_name"] as? String, "创酷")
        XCTAssertEqual(body["report_start_date"] as? String, "2026-08-31")
        XCTAssertEqual(body["report_end_date"] as? String, "2026-09-06")
        XCTAssertEqual(body["business_report_file_id"] as? String, "b.csv")
        XCTAssertEqual(body["payment_report_file_id"] as? String, "p.csv")
        XCTAssertEqual(body["ad_report_file_id"] as? String, "a.csv")
        XCTAssertEqual(body["country"] as? String, "US")
        XCTAssertNil(body["inventory_report_file_id"], "可选字段没填就省略")
        XCTAssertEqual(log.timeout, RequestTier.detail.timeout)
    }

    /// 可选字段填了就发（后端 `strip()` 后非空才认，所以 store 侧也要 trim）。
    func testCreateReportIncludesOptionalInventoryFileID() async throws {
        let ticketText = try ReportFixtures.text(fileName: "product-analysis-report-create.json")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/product-analysis-reports": .json(200, ticketText),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))
        _ = try await client.createProductAnalysisReport(
            ProductAnalysisReportRequest(
                projectName: "创酷",
                reportStartDate: "2026-08-31",
                reportEndDate: "2026-09-06",
                businessReportFileID: "b.csv",
                paymentReportFileID: "p.csv",
                adReportFileID: "a.csv",
                inventoryReportFileID: "i.csv"
            )
        )
        XCTAssertEqual(StubURLProtocol.log.last?.jsonObject?["inventory_report_file_id"] as? String, "i.csv")
    }

    /// 任务状态：**按后端给的路径**（从发起响应里取的 `status_endpoint`）请求，列表档 5s。
    ///
    /// 这条同时是「后端给的是带 `/api/v1` 的绝对路径」那个坑的回归 —— 用夹具里那个真实值
    /// 直接请求会变成 `/api/v1/api/v1/...`（404），客户端必须先归一化。
    func testTaskStatusFollowsBackendProvidedPath() async throws {
        let failedText = try ReportFixtures.text(fileName: "product-analysis-task-failed.json")
        let ticket = try ReportFixtures.productAnalysisTicket()
        let clientPath = ticket.resolvedStatusPath
        XCTAssertFalse(clientPath.hasPrefix("/api/v1"), "必须先剥掉后端给的前缀：\(clientPath)")

        // 桩件按**最终** URL 的路径匹配（`/api/v1` 已由 APIClient 拼上）。
        let session = StubURLProtocol.session(routes: [
            "/api/v1" + clientPath: .json(200, failedText),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))

        let status = try await client.productAnalysisTask(path: clientPath)
        XCTAssertEqual(status.progress, 100)
        XCTAssertEqual(StubURLProtocol.log.last?.path, "/api/v1" + clientPath, "最终 URL 里只有一层 /api/v1")
        XCTAssertEqual(StubURLProtocol.log.last?.timeout, RequestTier.list.timeout)
    }

    /// 结果下载：**流式落盘**（分片交付也要拼成完整文件）、报表档 60s。
    func testDownloadStreamsChunksToDisk() async throws {
        let chunks = ["PK\u{03}\u{04}", String(repeating: "x", count: 200_000), "TAIL"]
        let session = StubURLProtocol.session(routes: [
            "/api/v1/product-analysis-reports/tasks/7/result": .stream(
                200,
                chunks: chunks,
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1068-result-\(UUID().uuidString).xlsx")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.removeItem(at: destination.deletingLastPathComponent()
                .appendingPathComponent(".\(destination.lastPathComponent).partial-\(UUID().uuidString)"))
        }

        let written = try await client.downloadProductAnalysisResult(
            path: "/product-analysis-reports/tasks/7/result",
            to: destination
        )

        XCTAssertEqual(written, destination)
        let data = try Data(contentsOf: destination)
        XCTAssertEqual(data.count, chunks.joined().utf8.count, "分片必须逐块写全，不能丢尾")
        XCTAssertEqual(String(data: data.suffix(4), encoding: .utf8), "TAIL")
        let log = try XCTUnwrap(StubURLProtocol.log.last)
        XCTAssertEqual(log.method, "GET")
        XCTAssertEqual(log.path, "/api/v1/product-analysis-reports/tasks/7/result")
        XCTAssertEqual(log.timeout, RequestTier.report.timeout, "文件传输走报表档 60s")
    }

    /// 结果未就绪（真实 409）→ `.http(409)`，且**不**被当成凭据问题。
    func testDownloadNotReadySurfaces409() async throws {
        let envelope = try ReportFixtures.errorEnvelope(
            fileName: "product-analysis-result-not-ready.json"
        )
        let session = StubURLProtocol.session(routes: [
            "/api/v1/product-analysis-reports/tasks/7/result": .json(
                envelope.status,
                #"{"detail":"\#(envelope.detail)"}"#
            ),
        ])
        let client = ProductAnalysisClient(client: makeClient(session: session))
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1068-409-\(UUID().uuidString).xlsx")

        do {
            _ = try await client.downloadProductAnalysisResult(
                path: "/product-analysis-reports/tasks/7/result",
                to: destination
            )
            XCTFail("409 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .http(status: 409, body: #"{"detail":"\#(envelope.detail)"}"#))
            XCTAssertFalse(error.requiresCredentialFix)
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: destination.path),
            "失败的下载不能留下半成品文件"
        )
    }

    // MARK: - RPA 状态

    /// `GET /rpa-reports/status`：两个 query 参数必发，走**统计档（15s）**。
    func testRpaStatusUsesStatsTierAndBothQueryParameters() async throws {
        let rpaText = try ReportFixtures.text(fileName: "rpa-status.json")
        let capture = URLCapture()
        let session = StubURLProtocol.session { request in
            capture.append(request.url)
            return .json(200, rpaText)
        }
        let client = ReportAutomationClient(client: makeClient(session: session))

        let response = try await client.rpaStatus(
            RpaReportStatusQuery(reportDate: try ReportFixtures.manifest().params.rpaReportDate)
        )
        XCTAssertEqual(response.items.count, 10)

        let log = try XCTUnwrap(StubURLProtocol.log.last)
        XCTAssertEqual(log.method, "GET")
        XCTAssertEqual(log.path, "/api/v1/rpa-reports/status")
        XCTAssertEqual(capture.query(forPath: "/api/v1/rpa-reports/status"), "country=US&report_date=2026-09-14")
        XCTAssertEqual(log.timeout, RequestTier.stats.timeout, "多表聚合走统计档 15s")
        XCTAssertEqual(log.timeout, 15)
    }

    /// 未登录（无 key）时**请求根本不发**（不产生无谓的 401 往返）。
    func testMissingCredentialFailsBeforeAnyRequest() async throws {
        let session = StubURLProtocol.session(routes: [:])
        let client = ProductAnalysisClient(
            client: APIClient(baseURL: baseURL, apiKey: nil, session: session)
        )
        let fileURL = try makeSyntheticReport()
        do {
            _ = try await client.recognizeAdUpload(fileURL: fileURL, filename: "a.csv", country: "US")
            XCTFail("无凭据必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingCredential)
            XCTAssertTrue(error.requiresCredentialFix)
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "无凭据的请求不该发出去")
    }

    /// 上传体 MIME 按扩展名说真话（后端按扩展名分派解析器，不校验 MIME，但别谎报）。
    func testUploadMimeTypesFollowExtension() {
        XCTAssertEqual(
            ProductAnalysisClient.mimeType(forFilename: "a.xlsx"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        XCTAssertEqual(ProductAnalysisClient.mimeType(forFilename: "a.CSV"), "text/csv")
        XCTAssertEqual(ProductAnalysisClient.mimeType(forFilename: "a.xls"), "application/vnd.ms-excel")
        XCTAssertEqual(ProductAnalysisClient.mimeType(forFilename: "a.txt"), "text/plain")
        XCTAssertEqual(ProductAnalysisClient.mimeType(forFilename: "a.bin"), "application/octet-stream")
    }
}
