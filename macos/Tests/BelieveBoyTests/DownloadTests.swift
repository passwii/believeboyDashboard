import Foundation
import XCTest

@testable import BelieveBoyKit

/// 文件下载：流式落盘、原子替换、失败清理、错误分类。
final class DownloadTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    private func client(apiKey: String? = "blf_test", session: URLSession) -> APIClient {
        APIClient(baseURL: baseURL, apiKey: apiKey, session: session)
    }

    /// 在临时目录里造一个下载目标路径（目录由用例负责清理）。
    private func makeDestinationDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("download-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func leftoverPartialFiles(in directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.contains(".partial-") }
    }

    // MARK: - 正常路径

    func testDownloadWritesChunksToDiskAndReportsProgress() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("result.xlsx")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .stream(
                chunks: ["AAAA", "BBBB", "CCCC"],
                contentType: "application/octet-stream",
                headers: ["Content-Length": "12"]
            ),
        ])

        let progress = RecordingSink<DownloadProgress>()
        let url = try await client(session: session).download(
            "/jobs/7/result",
            to: destination,
            chunkSize: 4,
            onProgress: { progress.record($0) }
        )

        XCTAssertEqual(url, destination)
        XCTAssertEqual(try Data(contentsOf: destination), Data("AAAABBBBCCCC".utf8))
        XCTAssertGreaterThanOrEqual(progress.values.count, 3, "应按块上报进度，而不是只在结束时报一次")
        XCTAssertEqual(progress.values.map(\.receivedBytes), progress.values.map(\.receivedBytes).sorted())
        XCTAssertEqual(progress.values.last?.receivedBytes, 12)
        XCTAssertEqual(progress.values.last?.expectedBytes, 12)
        XCTAssertEqual(progress.values.last?.fraction, 1.0)
        XCTAssertEqual(try leftoverPartialFiles(in: directory), [], "成功路径不该留下 .partial 文件")
    }

    func testDownloadReplacesExistingFile() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("report.csv")
        try Data("旧内容".utf8).write(to: destination)

        let session = StubURLProtocol.session(routes: [
            "/api/v1/monthly-reports/1/download": .stream(
                chunks: ["新内容"],
                contentType: "text/csv"
            ),
        ])

        try await client(session: session).download("/monthly-reports/1/download", to: destination)

        XCTAssertEqual(try Data(contentsOf: destination), Data("新内容".utf8))
        XCTAssertEqual(try leftoverPartialFiles(in: directory), [])
    }

    func testDownloadCreatesMissingDestinationDirectory() async throws {
        let root = try makeDestinationDirectory()
        let destination = root
            .appendingPathComponent("nested")
            .appendingPathComponent("deeper")
            .appendingPathComponent("file.bin")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .stream(chunks: ["x"], contentType: "application/octet-stream"),
        ])

        try await client(session: session).download("/jobs/7/result", to: destination)

        XCTAssertEqual(try Data(contentsOf: destination), Data("x".utf8))
    }

    /// 大文件不该整份进内存 —— 用「边下边写」的可观测形式断言：下载未完成时目标文件
    /// 尚不存在（内容只落在临时文件里），完成后才原子出现。
    func testDestinationAppearsOnlyAfterCompletion() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("big.bin")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .stream(
                chunks: ["1111", "2222", "3333"],
                contentType: "application/octet-stream",
                headers: ["Content-Length": "12"],
                chunkDelay: 0.05
            ),
        ])

        let existedBeforeCompletion = LockedBox(false)
        // 客户端在 `Task` 外先建好：`client(session:)` 是 XCTestCase 的实例方法，
        // 在 Task 闭包里调会把非 Sendable 的 self 捕进去（Swift 6 报 data race）。
        let api = client(session: session)
        let task = Task {
            try await api.download(
                "/jobs/7/result",
                to: destination,
                chunkSize: 4,
                onProgress: { progress in
                    if progress.receivedBytes < 12,
                       FileManager.default.fileExists(atPath: destination.path) {
                        existedBeforeCompletion.mutate { $0 = true }
                    }
                }
            )
        }
        _ = try await task.value

        XCTAssertFalse(
            existedBeforeCompletion.value,
            "下载过程中不该出现最终文件（应写临时文件再原子替换）"
        )
        XCTAssertEqual(try Data(contentsOf: destination), Data("111122223333".utf8))
    }

    // MARK: - 失败与错误分类

    func testAuthFailureIsCredentialProblemAndLeavesNoPartialFile() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("result.xlsx")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .json(403, #"{"detail":"Invalid API key"}"#),
        ])

        do {
            try await client(session: session).download("/jobs/7/result", to: destination)
            XCTFail("403 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized(status: 403, body: #"{"detail":"Invalid API key"}"#))
            XCTAssertTrue(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }

        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertEqual(try leftoverPartialFiles(in: directory), [], "失败后必须清掉半成品")
    }

    /// 409：任务还没跑完（后端 `jobs.py` 对未完成的任务返回 409）。这不是凭据问题。
    func testNotFinishedConflictIsHttpErrorWithBody() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("result.xlsx")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .json(409, #"{"detail":"Job not finished"}"#),
        ])

        do {
            try await client(session: session).download("/jobs/7/result", to: destination)
            XCTFail("409 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .http(status: 409, body: #"{"detail":"Job not finished"}"#))
            XCTAssertFalse(error.requiresCredentialFix, "任务没跑完 ≠ 凭据失效")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
        XCTAssertEqual(try leftoverPartialFiles(in: directory), [])
    }

    func testTransportFailureIsNotCredentialProblemAndCleansUp() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("result.xlsx")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": StubURLProtocol.Response(
                status: 0,
                body: "",
                failure: URLError(.timedOut)
            ),
        ])

        do {
            try await client(session: session).download("/jobs/7/result", to: destination)
            XCTFail("超时必须抛错")
        } catch let error as APIError {
            guard case .transport(let detail) = error else {
                return XCTFail("期望 .transport，实际 \(error)")
            }
            XCTAssertEqual(detail, "请求超时（-1001）")
            XCTAssertFalse(error.requiresCredentialFix, "传输失败不得让用户重登")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
        XCTAssertEqual(try leftoverPartialFiles(in: directory), [])
    }

    func testUnwritableDestinationDirectoryIsFileWriteError() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("sub").appendingPathComponent("result.xlsx")
        // 让「创建目录」失败：拿一个同名文件占住路径。
        try Data("占位".utf8).write(to: directory.appendingPathComponent("sub"))
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .stream(chunks: ["x"], contentType: "application/octet-stream"),
        ])

        do {
            try await client(session: session).download("/jobs/7/result", to: destination)
            XCTFail("目录不可创建时必须抛错")
        } catch let error as APIError {
            guard case .fileWrite = error else {
                return XCTFail("期望 .fileWrite（本地 I/O，不是网络），实际 \(error)")
            }
            XCTAssertFalse(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    func testDownloadUsesReportTierAndCarriesCredential() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("result.xlsx")
        let session = StubURLProtocol.session(routes: [
            "/api/v1/jobs/7/result": .stream(chunks: ["x"], contentType: "application/octet-stream"),
        ])

        try await client(session: session).download("/jobs/7/result", to: destination)

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.timeout, RequestTier.report.timeout, "文件传输走报表档（60s）")
        XCTAssertEqual(recorded.apiKey, "blf_test")
        XCTAssertEqual(recorded.method, "GET")
    }

    func testMissingCredentialFailsWithoutTouchingDisk() async throws {
        let directory = try makeDestinationDirectory()
        let destination = directory.appendingPathComponent("result.xlsx")
        let session = StubURLProtocol.session(routes: [:])

        do {
            try await client(apiKey: nil, session: session).download("/jobs/7/result", to: destination)
            XCTFail("缺凭据必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingCredential)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }
}
