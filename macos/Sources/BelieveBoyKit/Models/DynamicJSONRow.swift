import Foundation

/// 一条**动态行**：形状由后端决定的 JSON 对象（`list[dict[str, object]]` 的元素）。
///
/// 覆盖两类后端响应：广告分析各 Tab 的明细行，以及广告数据页的 `ad-*-raw` 原始行。
/// 它们的共同点是 Pydantic 侧只声明成 `list[dict[str, object]]` —— 契约层面没有逐字段的
/// 名字与类型，硬写强类型模型等于把「我猜的字段名」当契约（字段改名时编译器与解码器都不
/// 报错，只会静默少一列）。所以这里照实保存后端给的名字与值，测试用**真实响应快照**钉住取值。
///
/// 键名不做 snake→camel 变换：`APIClient` 的 `convertFromSnakeCase` 只作用于**结构体属性**
/// 对应的键，`[String: JSONValue]` 这种字典型解码保留原样（实测，见
/// `AdAnalysisDecodingTests.testRowKeysKeepSnakeCaseInDictionaryDecoding`）—— 因此读的是
/// `sales_7d` / `budget_utilization_rate` 这类后端原字段名。
public struct DynamicJSONRow: Sendable, Equatable, Decodable {
    public let fields: [String: JSONValue]

    public init(fields: [String: JSONValue] = [:]) {
        self.fields = fields
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.fields = try container.decode([String: JSONValue].self)
    }

    public subscript(key: String) -> JSONValue? { fields[key] }

    public var keys: Set<String> { Set(fields.keys) }

    public func string(_ key: String) -> String? {
        guard let value = fields[key] else { return nil }
        if case .null = value { return nil }
        return value.text
    }

    /// 非空文本（空字符串视作缺位，与 Web 的 `x || '-'` 同口径）。
    public func nonEmptyString(_ key: String) -> String? {
        guard let text = string(key) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public func number(_ key: String) -> Double? {
        fields[key]?.number
    }

    public func int(_ key: String) -> Int? {
        guard let value = number(key) else { return nil }
        return Int(value.rounded())
    }

    /// 字符串列表（`evidence` 这类；单值也接受）。
    public func strings(_ key: String) -> [String] {
        guard let value = fields[key] else { return [] }
        switch value {
        case .array(let values): return values.compactMap(\.text)
        case .string(let text): return [text]
        case .number(let number): return [NumberText.plain(number)]
        case .bool, .object, .null: return []
        }
    }
}
