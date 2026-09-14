import BelieveBoyKit
import CryptoKit
import Foundation
import XCTest

/// 「AI 洞察三页」6 条端点的**真实后端响应快照**（BLF-1062 抓取，见同目录 `manifest.json`）。
///
/// 为什么要真响应而不是手写最小 JSON（BLF-1062 §口径 1 的落点）：AI 产出文本不可复现，
/// 逐字比对没有意义；可比对物是 ① run detail 的**字段与状态机**、② SSE 的**事件类型序列**、
/// ③ summary 与数值型字段。这三样都只有在「后端真正吐出来的那串字节」上才立得住 ——
/// 手写 JSON 只能证明解码器能解我自己编的数据，字段改名（`content_sha256` 少了后缀之类）
/// 在 Swift 侧既不报错也不解码失败，只会静默变成 `nil`。
///
/// 两段来源（详见 `Fixtures/Insight/README.md`）：
/// - **A 段**（`ai-insights-*.json` / `ai-insights-stream-terminal.txt`）：生产快照库 `BLF`，
///   与 S5.1 / S5.2 同源；
/// - **B 段**（`insight-run-*.json` / `insight-run-stream-*.txt`）：隔离库 `BLF_test` 上的
///   真实终态 run（生产快照库的 `insight_runs` 一行都没有），响应仍由真实路由产出。
///
/// 快照按 `#filePath` 定位源目录，不做 SPM resource：`swift test` 在源码树里跑，路径必然
/// 存在；这样夹具也能直接被人工 `diff` / `jq` 复查（跨批次漂移时用得上）。
enum InsightFixtures {
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

    /// `manifest.json`（抓取元数据 + 逐文件 sha256）。
    struct Manifest: Decodable {
        struct Entry: Decodable {
            let endpoint: String
            let file: String
            let bytes: Int
            let sha256: String
            let note: String
        }

        struct Params: Decodable {
            let projectID: Int
            let country: String
            let limit: Int

            private enum CodingKeys: String, CodingKey {
                case country, limit
                case projectID = "project_id"
            }
        }

        struct Source: Decodable {
            let database: String
            let note: String
            let endpoints: [String]
        }

        let capturedAt: String
        let capturedBy: String
        let params: Params
        let files: [Entry]
        /// SSE 原文（不是 JSON）：`sha256` 同样逐份记录。
        let streams: [Entry]
        let sourceA: Source
        let sourceB: Source

        private enum CodingKeys: String, CodingKey {
            case capturedAt = "captured_at"
            case capturedBy = "captured_by"
            case params, files, streams
            case sourceA = "source_a"
            case sourceB = "source_b"
        }
    }

    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/Insight", isDirectory: true)
    }

    static func manifest() throws -> Manifest {
        let data = try data(fileName: "manifest.json")
        return try JSONDecoder().decode(Manifest.self, from: data)
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

    /// 与 `APIClient` 相同的解码策略（`snake_case` → camelCase）。
    static func apiDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    static func decode<T: Decodable>(_ type: T.Type, fileName: String) throws -> T {
        try apiDecoder().decode(T.self, from: try data(fileName: fileName))
    }

    /// manifest 里某个文件的登记项（用于按名字核对哈希）。
    static func entry(fileName: String) throws -> Manifest.Entry {
        let all = try manifest().files + (try manifest().streams)
        guard let entry = all.first(where: { $0.file == fileName }) else {
            throw FixtureError.unknownFile(fileName)
        }
        return entry
    }

    static func sha256(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 逐端点便捷入口（测试直接读这几个，不拼文件名）

    /// `GET /ai-insights?project_id=1&country=US&limit=20&offset=0`。
    static func insightList() throws -> InsightListResponse {
        try decode(InsightListResponse.self, fileName: "ai-insights-list.json")
    }

    /// 同上，但带 `insight_type=ad_analysis`（「AI 广告分析」页的历史列表口径）。
    static func adAnalysisList() throws -> InsightListResponse {
        try decode(InsightListResponse.self, fileName: "ai-insights-ad-analysis-list.json")
    }

    static func insightDetail() throws -> InsightDetail {
        try decode(InsightDetail.self, fileName: "ai-insights-detail.json")
    }

    static func schedules() throws -> InsightScheduleListResponse {
        try decode(InsightScheduleListResponse.self, fileName: "ai-insights-schedules.json")
    }

    /// 旧链路 SSE 原文（已终态 → 立即一帧 `status` 后关闭）。
    static func legacyStreamText() throws -> String {
        try text(fileName: "ai-insights-stream-terminal.txt")
    }

    static func runDetailCompleted() throws -> InsightRunDetail {
        try decode(InsightRunDetail.self, fileName: "insight-run-detail-completed.json")
    }

    static func runDetailFailed() throws -> InsightRunDetail {
        try decode(InsightRunDetail.self, fileName: "insight-run-detail-failed.json")
    }

    static func runStreamCompletedText() throws -> String {
        try text(fileName: "insight-run-stream-completed.txt")
    }

    static func runStreamCompletedResumeText() throws -> String {
        try text(fileName: "insight-run-stream-completed-resume.txt")
    }

    static func runStreamFailedText() throws -> String {
        try text(fileName: "insight-run-stream-failed.txt")
    }

    static func runStreamFailedResumeText() throws -> String {
        try text(fileName: "insight-run-stream-failed-resume.txt")
    }

    /// 非法 `Last-Event-ID` 的真实错误响应（400 typed `RESUME_CURSOR_INVALID`）。
    ///
    /// `body` 是 FastAPI 的错误信封 `{"detail": {code, message, ...}}`（**不是**字符串），
    /// 这里按真实形状解出来 —— 客户端要认的就是 `detail.code`。
    static func invalidCursorResponse() throws -> (status: Int, code: String, message: String) {
        struct Envelope: Decodable {
            struct Body: Decodable {
                struct Detail: Decodable {
                    let code: String
                    let message: String
                }
                let detail: Detail
            }
            let status: Int
            let body: Body
        }
        let envelope = try decode(Envelope.self, fileName: "insight-run-stream-invalid-cursor.json")
        return (
            status: envelope.status,
            code: envelope.body.detail.code,
            message: envelope.body.detail.message
        )
    }
}

/// 把 SSE 原文切成「帧序列」（`id:` + `data:` 两行，空行分帧）。
///
/// 复用的是**产品里那一个**解析器（`SSEFrameParser`），不是测试自己再写一遍：只要这里
/// 换成手写切分，「夹具里的帧形状」与「产品里认的帧形状」就会各自演化，夹具也就失去了
/// 拦截漂移的意义。
enum InsightSSEFixture {
    static func events(from text: String) -> [ServerSentEvent] {
        var parser = SSEFrameParser()
        var events = parser.feed(Data(text.utf8))
        events.append(contentsOf: parser.finish())
        return events
    }

    /// 事件类型序列（canonical 帧：`data:` 里是带 `type` 的信封 JSON）。
    static func eventTypes(from text: String) -> [String] {
        events(from: text).compactMap { event in
            try? event.decode(InsightRunEvent.self).type
        }
    }

    /// 帧上的 `id:` 游标序列（旧链路为空 —— 它根本不发 `id:`）。
    static func eventIDs(from text: String) -> [String] {
        events(from: text).compactMap(\.id)
    }
}
