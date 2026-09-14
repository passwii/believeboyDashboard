import BelieveBoyKit
import CryptoKit
import Foundation
import XCTest

/// 「广告分析」10 个端点的**真实响应快照**（BLF-1056 抓取，见同目录 `manifest.json`）。
///
/// 为什么要真响应而不是手写最小 JSON：本批的验收口径是「与 Web 同源同值」，而这 10 个
/// 端点后端一律声明成 `list[dict[str, object]]`（`backend/app/schemas/ad_analysis.py`）
/// —— 契约层面没有逐字段的名字与类型，手写「看起来对」的 JSON 只能证明解码器能解我自己
/// 编的数据，解不了「后端这个 key 到底叫什么、这个比值是 0-1 还是百分数」。
///
/// 快照按 `#filePath` 定位源目录，不做 SPM resource：`swift test` 在源码树里跑，路径必然
/// 存在；并且这样夹具可以直接被人工 `diff` / `jq` 复查（跨批次漂移时用得上）。
enum AdAnalysisFixtures {
    enum FixtureError: Error, CustomStringConvertible {
        case missing(String)
        case unknownTab(String)
        case unknownSet(String)

        var description: String {
            switch self {
            case .missing(let path): return "快照文件不存在：\(path)"
            case .unknownTab(let tab): return "快照里没有这个 Tab：\(tab)"
            case .unknownSet(let set): return "manifest 里没有这个集合：\(set)"
            }
        }
    }

    /// `manifest.json`（抓取元数据 + 逐文件 sha256 + 行数统计）。
    struct Manifest: Decodable {
        struct Set: Decodable {
            struct File: Decodable {
                let tab: String
                let file: String
                let bytes: Int
                let sha256: String
                let counts: [String: Int]
            }

            let id: String
            let note: String
            let projectID: Int
            let country: String
            let dateFrom: String?
            let dateTo: String?
            let files: [File]

            private enum CodingKeys: String, CodingKey {
                case id, note, country, files
                case projectID = "project_id"
                case dateFrom = "date_from"
                case dateTo = "date_to"
            }
        }

        let capturedAt: String
        let capturedBy: String
        let backend: String
        let sets: [Set]

        private enum CodingKeys: String, CodingKey {
            case capturedAt = "captured_at"
            case capturedBy = "captured_by"
            case backend
            case sets
        }
    }

    /// 快照目录（`Tests/BelieveBoyTests/Fixtures/AdAnalysis/`）。
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/AdAnalysis", isDirectory: true)
    }

    static func manifest() throws -> Manifest {
        let data = try data(fileName: "manifest.json")
        return try JSONDecoder().decode(Manifest.self, from: data)
    }

    static func set(id: String) throws -> Manifest.Set {
        guard let set = try manifest().sets.first(where: { $0.id == id }) else {
            throw FixtureError.unknownSet(id)
        }
        return set
    }

    /// 全量历史口径（不传日期）的那一份快照。
    static func fullHistoryFile(forTabKey tabKey: String) throws -> Manifest.Set.File {
        try file(inSet: "full-history", forTabKey: tabKey)
    }

    static func file(inSet setId: String, forTabKey tabKey: String) throws -> Manifest.Set.File {
        let set = try set(id: setId)
        guard let file = set.files.first(where: { $0.tab == tabKey }) else {
            throw FixtureError.unknownTab("\(setId)/\(tabKey)")
        }
        return file
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

    static func payload(fileName: String) throws -> AdAnalysisPayload {
        try apiDecoder().decode(AdAnalysisPayload.self, from: try data(fileName: fileName))
    }

    /// 某个 Tab 的全量历史响应（不传 `date_from` / `date_to`）。
    static func payload(forTabKey tabKey: String) throws -> AdAnalysisPayload {
        try payload(fileName: try fullHistoryFile(forTabKey: tabKey).file)
    }

    /// 带日期区间的那一份（只有 `overview` / `time-trend`，用于覆盖 `comparison` 分支）。
    static func windowedPayload(forTabKey tabKey: String) throws -> AdAnalysisPayload {
        try payload(fileName: try file(inSet: "windowed", forTabKey: tabKey).file)
    }

    static func sha256(of data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// 快照文件名的完整列表（遍历用）。
    static func allFiles() throws -> [Manifest.Set.File] {
        try manifest().sets.flatMap(\.files)
    }
}
