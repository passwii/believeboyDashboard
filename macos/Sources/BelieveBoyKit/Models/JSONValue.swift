import Foundation

/// 任意 JSON 值。
///
/// 后端有不少「形状由调用方决定」的字段：长任务的 `params` / `payload_json`、
/// 动态筛选条件、以及广告两页的 `list[dict[str, object]]` 行
/// （`AdAnalysisValue` / 广告数据页的行值都收敛到本类型，见 `DynamicJSONRow`）。
/// Swift 侧没有 `Any` 的 `Codable` 通道，用具体模型接会把每批
/// 页面都卡住（模型对不上 = 解码失败 = 整页报错），故给一个显式的 JSON 值类型：
/// **能编码、能解码、能判等、可 `Sendable`**，同时不假装知道业务形状。
///
/// 有意不做 `ExpressibleBy*Literal` 便利构造：`let x: JSONValue = "abc"` 这种隐式
/// 转换在参数为 `[String: JSONValue]` 时会让调用点看不出发生了装箱，长任务参数
/// 又是要进请求体、要能被测试逐字段断言的东西 —— 显式 `.string("abc")` 更贵一点，
/// 但少一类「传错类型还能编过」的 bug。
public enum JSONValue: Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null
}

// MARK: - 取值（编码侧写入的实际形状）

public extension JSONValue {
    /// 字符串值；其它类型返回 `nil`（不隐式转换，见类型 doc）。
    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    /// `Double` 值。整数字面量在 JSON 里也是 number，故 `.number(3)` 也走这里。
    var doubleValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    /// 整数值 —— 仅当数值本身没有小数部分时返回，避免 `3.7` 被悄悄截成 `3`。
    var intValue: Int? {
        guard case .number(let value) = self, value.rounded() == value,
              value >= Double(Int.min), value <= Double(Int.max)
        else { return nil }
        return Int(value)
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    /// 对象值。`nil` 与「不是对象」都返回 `nil`（调用方判断形状错误即可）。
    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// 对象成员取值（非对象返回 `nil`）；用于逐层取 `payload_json` 里的字段。
    subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    // MARK: - 展示取值（表格单元格 / hover 提示用）

    /// 文本形态（`null` 与对象没有文本 → `nil`，由调用方决定显示成什么）。
    ///
    /// 数字走 `NumberText.plain`（`48.0 → "48"`、`0.3434 → "0.3434"`），数组按「 · 」拼接
    /// —— 与广告分析页原先的行内取值口径逐字一致（该类型就是从这里收敛过来的）。
    var text: String? {
        switch self {
        case .string(let value): return value
        case .number(let value): return NumberText.plain(value)
        case .bool(let value): return value ? "true" : "false"
        case .array(let values): return values.compactMap(\.text).joined(separator: " · ")
        case .object: return nil
        case .null: return nil
        }
    }

    /// 数值形态（数字、可解析的字符串；其余 `nil`）。
    ///
    /// 字符串分支是刻意保留的：后端偶有把数值写成字符串的行（CSV 直传字段），
    /// 表格按数值列排序 / 重算比率时按 `Double` 解读，拿不到就当缺位。
    var number: Double? {
        switch self {
        case .number(let value): return value
        case .string(let value): return Double(value)
        case .bool(let value): return value ? 1 : 0
        case .array, .object, .null: return nil
        }
    }
}

// MARK: - Codable

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            // Bool 必须排在 Int/Double 之前：JSON 的 `true` 在 Foundation 里也可能被
            // `decode(Double.self)` 命中（NSNumber 桥接），顺序反了会把布尔变数字。
            self = .bool(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "无法识别的 JSON 值（不是 null / 布尔 / 字符串 / 数字 / 数组 / 对象）"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public extension JSONValue {
    /// 「有值就带上、没有就不发」的字典构造：`nil` 一律不发，不做 `null` 占位。
    ///
    /// 后端 `params: dict = Field(default_factory=dict)` 对缺字段与显式 `null` 的
    /// 处理并不总是等价，省掉 `null` 才是稳的那一侧。
    static func compact(_ entries: [String: JSONValue?]) -> [String: JSONValue] {
        entries.compactMapValues { $0 }
    }
}
