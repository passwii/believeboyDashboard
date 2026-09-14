import BelieveBoyKit
import CryptoKit
import Foundation
import XCTest

/// 「AI 会话片」的真实响应快照（BLF-1065 抓取，见同目录 `manifest.json` 与 `README.md`）。
///
/// 为什么必须是真响应而不是手写最小 JSON：
/// - 会话 / 消息的键名由 Pydantic 模型决定（`ConversationItem` / `MessageItem`），写错一个
///   键名在 Swift 侧**既不报错也不解码失败** —— 属性是 Optional 就静默 nil，不是就整条报错；
/// - `search_sources` 声明成 `list[dict[str, str | float | None]]`（**声明宽、实际窄**），
///   手写只能证明「能解我自己编的形状」；
/// - SSE 帧的 `id:` 游标是 Redis Stream entry id（`<ms>-<seq>`），线与线之间的格式一致性
///   只有在真帧上才谈得上。
///
/// 快照按 `#filePath` 定位源目录，不做 SPM resource：`swift test` 在源码树里跑，路径必然
/// 存在；夹具也能被人工 `diff` / `jq` 复查（跨批次漂移时用得上）。
enum AIChatFixtures {
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

    /// `manifest.json`（抓取元数据 + 逐文件 sha256 / 字节数）。
    struct Manifest: Decodable {
        struct Databases: Decodable {
            let sourceReadOnly: String
            let targetReadWrite: String

            private enum CodingKeys: String, CodingKey {
                case sourceReadOnly = "source_read_only"
                case targetReadWrite = "target_read_write"
            }
        }

        struct Params: Decodable {
            let userID: Int
            let usageRange: String
            let conversationID: Int
            let conversationTitle: String
            let cursorSource: String

            private enum CodingKeys: String, CodingKey {
                case usageRange = "usage_range"
                case conversationID = "conversation_id"
                case conversationTitle = "conversation_title"
                case cursorSource = "cursor_source"
                case userID = "user_id"
            }
        }

        struct File: Decodable {
            let file: String
            let endpoint: String
            let note: String
            let bytes: Int
            let sha256: String
        }

        let capturedAt: String
        let capturedBy: String
        let backend: String
        let databases: Databases
        let params: Params
        let providerConfigured: Bool
        let files: [File]

        private enum CodingKeys: String, CodingKey {
            case backend, databases, params, files
            case capturedAt = "captured_at"
            case capturedBy = "captured_by"
            case providerConfigured = "provider_configured"
        }
    }

    /// 快照目录（`Tests/BelieveBoyTests/Fixtures/AIChat/`）。
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/AIChat", isDirectory: true)
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

    static func file(named name: String) throws -> Manifest.File {
        guard let file = try manifest().files.first(where: { $0.file == name }) else {
            throw FixtureError.unknownFile(name)
        }
        return file
    }

    // MARK: - 解码入口

    static func config() throws -> AIChatConfig {
        try apiDecoder().decode(AIChatConfig.self, from: try data(fileName: "ai-config.json"))
    }

    static func conversations() throws -> [AIChatConversation] {
        try apiDecoder().decode(
            [AIChatConversation].self,
            from: try data(fileName: "ai-conversations.json")
        )
    }

    static func messages() throws -> [AIChatMessage] {
        try apiDecoder().decode(
            [AIChatMessage].self,
            from: try data(fileName: "ai-conversation-messages.json")
        )
    }

    static func usageStats() throws -> AIChatUsageStats {
        try apiDecoder().decode(
            AIChatUsageStats.self,
            from: try data(fileName: "ai-usage-stats-30d.json")
        )
    }

    /// 一次完整生成的 SSE 帧序列（已按空行切好的 `data:` 文本行，交给 `SSEFrameParser`）。
    static func streamTurn() throws -> String {
        try text(fileName: "ai-chat-stream-turn.txt")
    }

    static func streamResume() throws -> String {
        try text(fileName: "ai-chat-stream-resume.txt")
    }

    static func streamError() throws -> String {
        try text(fileName: "ai-chat-stream-error.txt")
    }

    // MARK: - 解析工具

    /// 把一份 SSE 文本喂进**真实**解析器（与被测链路同一个 `SSEFrameParser`）。
    ///
    /// 逐字节喂：一帧跨分片 / 一个分片多帧的两种情况都由真实解析器处理，用例不替它切帧 ——
    /// 否则「解析器对不对」就成了「用例切得对不对」。
    static func parse(frames text: String) -> [ServerSentEvent] {
        var parser = SSEFrameParser()
        var events: [ServerSentEvent] = []
        for byte in Array(text.utf8) {
            events.append(contentsOf: parser.feed(Data([byte])))
        }
        events.append(contentsOf: parser.finish())
        return events
    }

    /// 快照的 SSE 文本 → 领域事件序列（真实解码入口）。
    static func decodedStreamEvents(_ text: String) -> [AIChatStreamEvent] {
        parse(frames: text).map(AIChatStreamDecoder.decode)
    }

    static func sha256(of data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
