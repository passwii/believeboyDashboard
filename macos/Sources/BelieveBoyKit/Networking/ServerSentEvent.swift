import Foundation

/// 一条 SSE 事件（WHATWG EventSource 的帧语义）。
///
/// 后端 5 个家族（`ai_chat_v2` / `ai_insight` / `crm` / `digital_office` /
/// `insight_runs`）都用 `text/event-stream`，帧形状是 `id: <cursor>\ndata: <json>\n\n`
/// 或 `event: <name>\ndata: ...\n\n`（`backend/app/services/ai/protocol/encoder.py`、
/// `insight_runs.py:_sse_frame`）。
public struct ServerSentEvent: Sendable, Equatable {
    /// `id:` 字段 —— 续传游标（后端 `Last-Event-ID` 认它）。
    public let id: String?
    /// `event:` 字段；后端多数把事件类型放在 `data` 的 JSON 里，这里是可选。
    public let event: String?
    /// `data:` 字段，多行按规范用 `\n` 连接。
    public let data: String
    /// `retry:` 字段（毫秒），后端目前不发，保留解析。
    public let retry: Int?

    public init(id: String? = nil, event: String? = nil, data: String, retry: Int? = nil) {
        self.id = id
        self.event = event
        self.data = data
        self.retry = retry
    }

    /// 把 `data` 解成模型（后端事件体是 JSON）。
    ///
    /// 复用与 `APIClient` 相同的 `snake_case` 解码策略，否则同一个字段在普通响应里
    /// 解得开、在流里解不开。
    public func decode<T: Decodable & Sendable>(_ type: T.Type = T.self) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(T.self, from: Data(data.utf8))
        } catch {
            throw APIError.decoding(APIClient.describe(error))
        }
    }
}

/// SSE 帧解析器：喂字节，出事件。
///
/// 独立于网络，因为帧规则本身就是最容易错的地方（空行才 dispatch、`data:` 多行要
/// 用 `\n` 连接、`:` 开头是注释、值前只去一个空格、`\r\n` 与 `\n` 都要认），而它
/// 又完全不需要真连接就能逐条钉住。
public struct SSEFrameParser: Sendable {
    /// 最近一次 `id:` —— 断线重连时作为 `Last-Event-ID` 回传（后端据此续传）。
    public private(set) var lastEventID: String?

    private var lineBuffer = Data()
    private var dataLines: [String] = []
    private var eventName: String?
    private var eventID: String?
    private var retryMilliseconds: Int?

    public init() {}

    /// 喂入一段字节，返回本次能够完整成帧的事件。
    public mutating func feed(_ data: Data) -> [ServerSentEvent] {
        var events: [ServerSentEvent] = []
        for byte in data {
            if byte == 0x0A { // \n
                if let line = takeLine() {
                    if line.isEmpty {
                        if let event = dispatch() { events.append(event) }
                    } else {
                        consume(line: line)
                    }
                }
            } else {
                lineBuffer.append(byte)
            }
        }
        return events
    }

    /// 流结束：把最后一条没有以空行收尾的帧也吐出来（后端正常都会收尾，但断流时
    /// 最后一条常常恰好卡在 `data:` 行之后）。
    public mutating func finish() -> [ServerSentEvent] {
        if let line = takeLine(), !line.isEmpty {
            consume(line: line)
        }
        return dispatch().map { [$0] } ?? []
    }

    // MARK: - 内部

    /// 取出一行（去掉结尾的 `\r`）。
    private mutating func takeLine() -> String? {
        var text = String(decoding: lineBuffer, as: UTF8.self)
        lineBuffer.removeAll(keepingCapacity: true)
        if text.hasSuffix("\r") { text.removeLast() }
        return text
    }

    private mutating func consume(line: String) {
        // `:` 开头是注释（后端心跳 / keep-alive 会用）。
        guard !line.hasPrefix(":") else { return }

        let (field, rawValue) = Self.split(line: line)
        let value = rawValue.hasPrefix(" ") ? String(rawValue.dropFirst()) : rawValue

        switch field {
        case "data":
            dataLines.append(value)
        case "event":
            eventName = value
        case "id":
            // 规范：含 NUL 的 id 必须忽略。
            guard !value.contains("\0") else { return }
            eventID = value
            if !value.isEmpty { lastEventID = value }
        case "retry":
            if let milliseconds = Int(value), milliseconds >= 0 { retryMilliseconds = milliseconds }
        default:
            // 未知字段按规范忽略（不是错误）。
            break
        }
    }

    /// 空行到达时成帧；`data` 为空则**不派发**（规范：data 缓冲为空串时直接丢弃）。
    ///
    /// 注意判空的是**拼接后**的结果，不是行数组：`data:`（值为空）也产出一行，
    /// 但那仍是空数据，不该成帧。
    private mutating func dispatch() -> ServerSentEvent? {
        defer {
            dataLines.removeAll(keepingCapacity: true)
            eventName = nil
            eventID = nil
            retryMilliseconds = nil
        }
        let data = dataLines.joined(separator: "\n")
        guard !data.isEmpty else { return nil }
        return ServerSentEvent(
            id: eventID,
            event: eventName,
            data: data,
            retry: retryMilliseconds
        )
    }

    /// `field: value` 拆成两半；没有冒号时整行是字段名、值为空串。
    static func split(line: String) -> (field: String, value: String) {
        guard let colon = line.firstIndex(of: ":") else { return (line, "") }
        return (String(line[line.startIndex..<colon]), String(line[line.index(after: colon)...]))
    }
}
