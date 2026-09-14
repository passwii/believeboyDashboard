import Foundation
import XCTest

@testable import BelieveBoyKit

/// `JSONValue`：任意 JSON 形状的编码 / 解码 / 取值。
///
/// 它存在的理由是后端把一部分字段的形状交给调用方（`params` / `payload_json`），
/// 所以最要紧的两条是「布尔不会被当成数字」与「未知形状不会让整条响应解码失败」。
final class JSONValueTests: XCTestCase {
    private func decode(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    func testDecodesEveryJSONShape() throws {
        XCTAssertEqual(try decode("\"abc\""), .string("abc"))
        XCTAssertEqual(try decode("true"), .bool(true))
        XCTAssertEqual(try decode("false"), .bool(false))
        XCTAssertEqual(try decode("120"), .number(120))
        XCTAssertEqual(try decode("1.5"), .number(1.5))
        XCTAssertEqual(try decode("null"), .null)
        XCTAssertEqual(try decode("[1,\"a\",null]"), .array([.number(1), .string("a"), .null]))
        XCTAssertEqual(
            try decode(#"{"a":{"b":[true]}}"#),
            .object(["a": .object(["b": .array([.bool(true)])])])
        )
    }

    /// 布尔与数字都来自 `NSNumber`：解码顺序错了就会把 `true` 变成 `1`。
    func testBooleansAreNotDecodedAsNumbers() throws {
        let value = try decode(#"{"ok":true,"count":1}"#)

        XCTAssertEqual(value["ok"], .bool(true))
        XCTAssertEqual(value["ok"]?.boolValue, true)
        XCTAssertNil(value["ok"]?.doubleValue, "布尔不得被当成数字")
        XCTAssertEqual(value["count"], .number(1))
        XCTAssertNil(value["count"]?.boolValue)
    }

    func testEncodesBackToTheSameJSON() throws {
        let value = try decode(#"{"a":[1,2],"b":{"c":"中文"},"d":null,"e":false}"#)
        let data = try JSONEncoder().encode(value)
        let reDecoded = try JSONDecoder().decode(JSONValue.self, from: data)

        XCTAssertEqual(reDecoded, value, "编码 / 解码必须往返一致（否则发给后端的 params 会变形）")
    }

    func testIntegerAccessorRefusesToTruncate() throws {
        XCTAssertEqual(try decode("120").intValue, 120)
        XCTAssertNil(try decode("3.7").intValue, "3.7 不能被悄悄截成 3")
        XCTAssertEqual(try decode("3.0").intValue, 3, "3.0 是整数形态，可以取整")
        XCTAssertNil(try decode("\"3\"").intValue, "字符串不做隐式转换")
        XCTAssertEqual(try decode("1.5").doubleValue, 1.5)
    }

    func testSubscriptWalksNestedObjectsAndReturnsNilForWrongShape() throws {
        let value = try decode(#"{"payload_json":{"file_id":"f-1"}}"#)

        XCTAssertEqual(value["payload_json"]?["file_id"], .string("f-1"))
        XCTAssertNil(value["payload_json"]?["missing"])
        XCTAssertNil(value["nope"]?["file_id"], "对非对象取下标返回 nil，而不是崩")
        XCTAssertNil(value["payload_json"]?["file_id"]?.objectValue)
    }

    func testCompactDropsNilEntriesWithoutEmittingNulls() {
        let params = JSONValue.compact([
            "keep": .string("x"),
            "drop": nil,
            "zero": .number(0),
        ])

        XCTAssertEqual(Set(params.keys), ["keep", "zero"], "缺字段与显式 null 在后端不等价，一律不发")
        XCTAssertEqual(params["zero"], .number(0))
    }

    func testNestedJobParamsSurviveAFullRoundTrip() throws {
        // 长任务参数常是「标量 + 嵌套对象 + 数组」混排，这里钉住它不会在途中走形。
        let params: [String: JSONValue] = [
            "report_date": .string("2026-09-13"),
            "country": .string("US"),
            "options": .object(["trim": .bool(true), "batch": .number(500)]),
            "tags": .array([.string("monthly"), .null]),
        ]
        let data = try JSONEncoder().encode(params)
        let decoded = try JSONDecoder().decode([String: JSONValue].self, from: data)

        XCTAssertEqual(decoded, params)
        XCTAssertEqual(decoded["options"]?["trim"]?.boolValue, true)
        XCTAssertEqual(decoded["tags"]?.arrayValue?.count, 2)
    }

    func testUnsupportedShapeThrowsInsteadOfSilentlyBecomingNull() {
        struct Wrapper: Decodable { let value: JSONValue }
        // 用一段非法 JSON：解码必须报错，而不是给出一个「看起来是 null」的值。
        XCTAssertThrowsError(try JSONDecoder().decode(Wrapper.self, from: Data(#"{"value":}"#.utf8)))
    }
}
