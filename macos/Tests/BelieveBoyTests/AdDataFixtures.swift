import BelieveBoyKit
import CryptoKit
import Foundation
import XCTest

/// 「广告数据」11 个端点的**真实响应快照**（BLF-1057 抓取，见同目录 `manifest.json`）。
///
/// 为什么要真响应而不是手写最小 JSON：本批的验收口径是「与 Web 同源同值」。原始行的形状在
/// Pydantic 侧是 `list[dict[str, object]]`（每行还有一整列**中文**的 `raw_row`）—— 手写
/// 「看起来对」的 JSON 只能证明解码器能解我自己编的数据，证明不了「后端这个 key 到底叫什么」。
/// 键名写错在 Swift 侧既不报错也不解码失败，只会静默少一列。
///
/// 快照按 `#filePath` 定位源目录，不做 SPM resource：`swift test` 在源码树里跑，路径必然存在；
/// 这样夹具也能直接被人工 `diff` / `jq` 复查（跨批次漂移时用得上）。
enum AdDataFixtures {
    enum FixtureError: Error, CustomStringConvertible {
        case missing(String)
        case unknownEndpoint(String)
        case unknownReportType(String)

        var description: String {
            switch self {
            case .missing(let path): return "快照文件不存在：\(path)"
            case .unknownEndpoint(let endpoint): return "manifest 里没有这个端点：\(endpoint)"
            case .unknownReportType(let code): return "目录里没有这个报表类型：\(code)"
            }
        }
    }

    /// `manifest.json`（抓取元数据 + 逐文件 sha256 + 行数统计）。
    struct Manifest: Decodable {
        struct Params: Decodable {
            let projectID: Int
            let country: String
            let period: String
            let startDate: String
            let endDate: String
            let fixtureLimit: Int
            let pageLimit: Int

            private enum CodingKeys: String, CodingKey {
                case country, period
                case projectID = "project_id"
                case startDate = "start_date"
                case endDate = "end_date"
                case fixtureLimit = "fixture_limit"
                case pageLimit = "page_limit"
            }
        }

        struct File: Decodable {
            let endpoint: String
            let reportType: String
            let file: String
            let bytes: Int
            let sha256: String
            /// 夹具落盘时的行数（`FixtureLimit` 截断后）。
            let rows: Int
            /// 页面口径（`limit=10000`）下的**真实**行数 / 字节数 —— 只测量、不落盘。
            let fullRows: Int
            let fullBytes: Int

            private enum CodingKeys: String, CodingKey {
                case endpoint, file, bytes, sha256, rows
                case reportType = "report_type"
                case fullRows = "full_rows"
                case fullBytes = "full_bytes"
            }
        }

        struct UploadFiles: Decodable {
            let file: String
            let bytes: Int
            let sha256: String
            let items: Int
            let limit: Int
            let country: String
            /// 这份列表里出现过的 `report_type`（**截断**后的集合，见口径 3）。
            let reportTypes: [String]

            private enum CodingKeys: String, CodingKey {
                case file, bytes, sha256, items, limit, country
                case reportTypes = "report_types"
            }
        }

        let capturedAt: String
        let capturedBy: String
        let backend: String
        let params: Params
        let files: [File]
        let uploadFiles: UploadFiles

        private enum CodingKeys: String, CodingKey {
            case backend, params, files
            case capturedAt = "captured_at"
            case capturedBy = "captured_by"
            case uploadFiles = "upload_files"
        }
    }

    /// 快照目录（`Tests/BelieveBoyTests/Fixtures/AdData/`）。
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/AdData", isDirectory: true)
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

    /// 与 `APIClient` 一致的解码策略（`convertFromSnakeCase`）。
    static func apiDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    static func file(forEndpoint endpoint: String) throws -> Manifest.File {
        guard let file = try manifest().files.first(where: { $0.endpoint == endpoint }) else {
            throw FixtureError.unknownEndpoint(endpoint)
        }
        return file
    }

    /// 某个报表类型的全量窗口响应（哨兵窗口 + 夹具 limit）。
    static func payload(forReportTypeCode code: String) throws -> AdDataRawPayload {
        guard let type = AdDataCatalog.reportType(code: code) else {
            throw FixtureError.unknownReportType(code)
        }
        return try payload(forEndpoint: type.endpoint)
    }

    static func payload(forEndpoint endpoint: String) throws -> AdDataRawPayload {
        try apiDecoder().decode(
            AdDataRawPayload.self,
            from: try data(fileName: try file(forEndpoint: endpoint).file)
        )
    }

    /// `ad-upload-files` 的那一份（500 条 = 端点上限）。
    static func uploadFiles() throws -> [AdUploadFileItem] {
        try apiDecoder().decode(
            [AdUploadFileItem].self,
            from: try data(fileName: try manifest().uploadFiles.file)
        )
    }

    static func sha256(of data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
