import BelieveBoyKit
import CryptoKit
import Foundation
import XCTest

/// 「报表中心 · 上传与分析簇」7 条端点的**真实响应快照**（BLF-1068 抓取，见同目录
/// `manifest.json` 与 `README.md`）。
///
/// 为什么要真响应而不是手写最小 JSON：本批的验收口径是「与 Web 同源同值」，而 RPA 状态是
/// 后端跨多张表的聚合（15 列 × 每项目、`latest_date` 来自 `period_end_date` /
/// `snapshot_at` 两种来源）、识别响应又是**两个端点两套形状** —— 手写一份「看起来对」的
/// JSON 只能证明解码器能解我自己编的数据，证明不了「后端这个 key 到底叫什么」。
/// 键名写错在 Swift 侧既不报错也不解码失败，只会静默少一个字段。
///
/// 快照按 `#filePath` 定位源目录，不做 SPM resource：`swift test` 在源码树里跑，路径必然
/// 存在；这样夹具也能直接被人工 `diff` / `jq` 复查（跨批次漂移时用得上）。
enum ReportFixtures {
    enum FixtureError: Error, CustomStringConvertible {
        case missing(String)
        case unknownFile(String)

        var description: String {
            switch self {
            case .missing(let path): return "快照文件不存在：\(path)"
            case .unknownFile(let name): return "manifest 里没有这个文件：\(name)"
            }
        }
    }

    /// `manifest.json`（抓取元数据 + 逐文件 sha256 + 端点到文件的索引）。
    struct Manifest: Decodable {
        struct Params: Decodable {
            struct SyntheticReport: Decodable {
                let filename: String
                let reportType: String
                let sku: String
                let asin: String
                let project: String

                private enum CodingKeys: String, CodingKey {
                    case filename, sku, asin, project
                    case reportType = "report_type"
                }
            }

            let country: String
            let rpaReportDate: String
            let adUploadStatusLimit: Int
            let syntheticAdReport: SyntheticReport

            private enum CodingKeys: String, CodingKey {
                case country
                case rpaReportDate = "rpa_report_date"
                case adUploadStatusLimit = "ad_upload_status_limit"
                case syntheticAdReport = "synthetic_ad_report"
            }
        }

        struct File: Decodable {
            let endpoint: String
            let file: String
            let bytes: Int
            let sha256: String
            let note: String
        }

        let capturedAt: String
        let capturedBy: String
        let params: Params
        let files: [File]

        private enum CodingKeys: String, CodingKey {
            case params, files
            case capturedAt = "captured_at"
            case capturedBy = "captured_by"
        }
    }

    /// 快照目录（`Tests/BelieveBoyTests/Fixtures/Report/`）。
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/Report", isDirectory: true)
    }

    static func manifest() throws -> Manifest {
        try JSONDecoder().decode(Manifest.self, from: try data(fileName: "manifest.json"))
    }

    static func data(fileName: String) throws -> Data {
        let url = directory.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else {
            throw FixtureError.missing(url.path)
        }
        return data
    }

    static func text(fileName: String) throws -> String {
        guard let text = String(data: try data(fileName: fileName), encoding: .utf8) else {
            throw FixtureError.missing(fileName)
        }
        return text
    }

    static func sha256Hex(fileName: String) throws -> String {
        SHA256.hash(data: try data(fileName: fileName))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// 与 `APIClient` 一致的解码策略（`convertFromSnakeCase`）—— 断言的必须是**线上那条**
    /// 解码路径，不是测试自己另配的一条。
    static func apiDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    static func file(named name: String) throws -> Manifest.File {
        guard let file = try manifest().files.first(where: { $0.file == name }) else {
            throw FixtureError.unknownFile(name)
        }
        return file
    }

    static func rawJSON(fileName: String) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: try data(fileName: fileName))
        guard let dictionary = object as? [String: Any] else {
            throw FixtureError.missing("\(fileName) 不是 JSON 对象")
        }
        return dictionary
    }

    // MARK: - 逐端点解码

    /// `GET /rpa-reports/status`（生产快照库，`report_date=2026-09-14` / `country=US`）。
    static func rpaStatus() throws -> RpaReportStatusResponse {
        try apiDecoder().decode(RpaReportStatusResponse.self, from: try data(fileName: "rpa-status.json"))
    }

    static func adUploadStatus() throws -> AdUploadStatusResponse {
        try apiDecoder().decode(
            AdUploadStatusResponse.self,
            from: try data(fileName: "ad-upload-status.json")
        )
    }

    static func adUploadStatusFiltered() throws -> AdUploadStatusResponse {
        try apiDecoder().decode(
            AdUploadStatusResponse.self,
            from: try data(fileName: "ad-upload-status-filtered.json")
        )
    }

    /// `POST /ad-upload/recognize` 的真实响应（合成 CSV → `ad_promoted_product_report`）。
    static func recognition() throws -> AdUploadRecognition {
        try apiDecoder().decode(
            AdUploadRecognition.self,
            from: try data(fileName: "ad-upload-recognize.json")
        )
    }

    /// `POST /ad-upload/commit`（`dry_run=true`）的真实响应。
    static func commitResult() throws -> AdUploadCommitResult {
        try apiDecoder().decode(
            AdUploadCommitResult.self,
            from: try data(fileName: "ad-upload-commit-dry-run.json")
        )
    }

    static func productAnalysisTicket() throws -> ProductAnalysisReportTicket {
        try apiDecoder().decode(
            ProductAnalysisReportTicket.self,
            from: try data(fileName: "product-analysis-report-create.json")
        )
    }

    /// 真实 failed 终态（缺文件 → `FileNotFoundError`）。
    static func failedTaskStatus() throws -> ProductAnalysisTaskStatus {
        try apiDecoder().decode(
            ProductAnalysisTaskStatus.self,
            from: try data(fileName: "product-analysis-task-failed.json")
        )
    }

    /// 真实错误响应（`{"detail": ...}` + HTTP 状态码）。
    struct ErrorEnvelope: Decodable, Equatable {
        let status: Int
        let detail: String

        private struct Body: Decodable {
            let detail: String
        }

        private enum CodingKeys: String, CodingKey {
            case status, body
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            status = try container.decode(Int.self, forKey: .status)
            detail = try container.decode(Body.self, forKey: .body).detail
        }
    }

    static func errorEnvelope(fileName: String) throws -> ErrorEnvelope {
        try apiDecoder().decode(ErrorEnvelope.self, from: try data(fileName: fileName))
    }
}
