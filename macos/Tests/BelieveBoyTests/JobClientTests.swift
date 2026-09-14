import Foundation
import XCTest

@testable import BelieveBoyKit

/// 长任务：入队请求形状、详情解码（含未知状态）、轮询到终态、结果下载。
final class JobClientTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    // 固定夹具用 `static`：`StubURLProtocol.session(handler:)` 的闭包是 `@Sendable`，
    // 在闭包里调实例方法会把非 Sendable 的 `XCTestCase` 捕进去（Swift 6 直接编译不过）。
    // 需要按次数变响应时，先在外面算好字符串再捕。
    private static func jobJSON(
        id: Int = 7,
        status: String = "pending",
        errorMessage: String? = nil,
        logExcerpt: String? = nil
    ) -> String {
        let error = errorMessage.map { "\"\($0)\"" } ?? "null"
        let log = logExcerpt.map { "\"\($0)\"" } ?? "null"
        return """
        {"id":\(id),"job_type":"report_upload_ingest","status":"\(status)",\
        "payload_json":{"file_id":"f-1","rows":120},\
        "operator":"测试管理员","created_at":"2026-09-14T09:34:19.980042",\
        "updated_at":"2026-09-14T09:36:02.123456",\
        "runs":[{"id":31,"started_at":"2026-09-14T09:34:20.000001",\
        "finished_at":"2026-09-14T09:36:02.000001","operator":"测试管理员",\
        "log_excerpt":\(log),"error_message":\(error),"result_path":"results/7.xlsx"}]}
        """
    }

    private static func summaryJSON(status: String = "pending") -> String {
        """
        {"id":7,"job_type":"report_upload_ingest","status":"\(status)",\
        "payload_json":{"file_id":"f-1"},"operator":"测试管理员",\
        "created_at":"2026-09-14T09:34:19.980042","updated_at":null}
        """
    }

    // MARK: - 入队

    func testSubmitPostsSnakeCaseBodyToJobs() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs": .json(200, Self.summaryJSON()),
        ])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)
        let jobs = JobClient(client: client)

        let summary = try await jobs.submit(
            jobType: "report_upload_ingest",
            fileID: "f-1",
            params: ["reset": .bool(true), "rows": .number(120)]
        )

        XCTAssertEqual(summary.id, 7)
        XCTAssertEqual(summary.status, .pending)
        XCTAssertEqual(summary.jobType, "report_upload_ingest")
        XCTAssertEqual(summary.operator, "测试管理员", "后端字段就叫 operator，解码要能取到")
        XCTAssertEqual(summary.payloadJson?["file_id"], .string("f-1"))

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "POST")
        XCTAssertEqual(recorded.path, "/api/v1/jobs")
        XCTAssertEqual(recorded.header("Content-Type"), "application/json")
        let body = try XCTUnwrap(recorded.jsonObject)
        XCTAssertEqual(
            Set(body.keys),
            ["job_type", "file_id", "params"],
            "后端要 snake_case —— 换成 jobType/fileID 会直接 422"
        )
        XCTAssertEqual(body["job_type"] as? String, "report_upload_ingest")
        XCTAssertEqual(body["file_id"] as? String, "f-1")
        let params = try XCTUnwrap(body["params"] as? [String: Any])
        XCTAssertEqual(params["reset"] as? Bool, true)
        XCTAssertEqual(params["rows"] as? Double, 120)
    }

    // MARK: - 详情解码

    func testDetailDecodesRunsAndTimestamps() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7": .json(200, Self.jobJSON(status: "success")),
        ])
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        let detail = try await jobs.detail(7)

        XCTAssertTrue(detail.status.isSuccess)
        XCTAssertTrue(detail.status.isTerminal)
        XCTAssertEqual(detail.runs.count, 1)
        XCTAssertEqual(detail.runs.first?.resultPath, "results/7.xlsx")
        XCTAssertEqual(detail.runs.first?.startedAt, "2026-09-14T09:34:20.000001", "时间戳保持字符串，避免小数秒解码崩")
        XCTAssertNil(detail.failureMessage, "成功任务没有失败原因")
    }

    /// 后端将来加状态（如 `cancelled`）时不得让整条响应解码失败 —— 那会把
    /// 「多了一个不认识的状态」显示成「任务查询坏了」。
    func testUnknownStatusDecodesAndIsTreatedAsNotTerminal() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7": .json(200, Self.jobJSON(status: "cancelled")),
        ])
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        let detail = try await jobs.detail(7)

        XCTAssertEqual(detail.status.rawValue, "cancelled")
        XCTAssertFalse(detail.status.isTerminal, "未知状态按未终态处理，由轮询上限兜底")
        XCTAssertFalse(detail.status.isSuccess)
    }

    func testFailureMessageFallsBackToLatestRunLog() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7": .json(200, Self.jobJSON(status: "failed")),
        ])
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        let detail = try await jobs.detail(7)

        XCTAssertTrue(detail.status.isTerminal)
        XCTAssertEqual(detail.failureMessage, "后端未提供失败原因。", "两处都空时也要给出一句可展示的话")
    }

    // MARK: - 轮询

    func testWaitForCompletionPollsWithBackoffUntilTerminal() async throws {
        let callCount = LockedBox(0)
        // 轮询走 `GET /jobs/{id}`（返回 JobDetail，带 runs），故 pending 态也用详情夹具。
        let running = Self.jobJSON(status: "running")
        let success = Self.jobJSON(status: "success")
        let session = StubURLProtocol.session { _ in
            callCount.mutate { $0 += 1 }
            return .json(200, callCount.value < 3 ? running : success)
        }
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        let delays = RecordingSink<TimeInterval>()
        let detail = try await jobs.waitForCompletion(
            7,
            policy: PollingPolicy(initialDelay: 1, multiplier: 1.5, maxDelay: 5, maxAttempts: 10),
            sleeper: PollSleeper { delays.record($0) }
        )

        XCTAssertEqual(detail.status, .success)
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/jobs/7"), 3, "第 3 次拿到终态即停")
        XCTAssertEqual(delays.values, [1, 1.5], "两次 pending → 两次退避")
    }

    func testWaitForSuccessThrowsJobFailedWithRunMessage() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7": .json(200, Self.jobJSON(status: "failed", errorMessage: "文件缺少表头")),
        ])
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        do {
            _ = try await jobs.waitForSuccess(7, policy: PollingPolicy(maxAttempts: 3))
            XCTFail("任务失败必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .jobFailed(status: "failed", detail: "文件缺少表头"))
            XCTAssertFalse(error.requiresCredentialFix, "任务失败不是凭据问题")
            XCTAssertTrue(error.displayMessage.contains("文件缺少表头"), "文案要带出后端给的原因")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    func testWaitForCompletionGivesUpAtAttemptLimit() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7": .json(200, Self.jobJSON(status: "running")),
        ])
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        do {
            _ = try await jobs.waitForCompletion(
                7,
                policy: PollingPolicy(initialDelay: 0, multiplier: 1, maxDelay: 0, maxAttempts: 2),
                sleeper: PollSleeper { _ in }
            )
            XCTFail("到上限必须抛错，不能无限轮询")
        } catch let error as APIError {
            XCTAssertEqual(error, .pollingTimedOut(attempts: 2))
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/jobs/7"), 2)
    }

    // MARK: - 结果下载

    func testDownloadResultStreamsJobResultToDisk() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("job-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let destination = directory.appendingPathComponent("7.xlsx")

        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .stream(
                chunks: ["xlsx", "-bytes"],
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
        ])
        let jobs = JobClient(client: APIClient(baseURL: baseURL, apiKey: "blf_test", session: session))

        let url = try await jobs.downloadResult(7, to: destination)

        XCTAssertEqual(url, destination)
        XCTAssertEqual(try Data(contentsOf: destination), Data("xlsx-bytes".utf8))
        XCTAssertEqual(StubURLProtocol.log.first?.path, "/api/v1/jobs/7/result")
    }
}
