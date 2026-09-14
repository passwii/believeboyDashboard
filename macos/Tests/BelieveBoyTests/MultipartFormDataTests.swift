import Foundation
import XCTest

@testable import BelieveBoyKit

/// multipart 上传：边界、中文文件名、流式产出、以及真实请求形状。
final class MultipartFormDataTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    // MARK: - 头部与文件名编码

    /// 中文文件名必须**两种形态都给**：原始 UTF-8（浏览器就这样发，后端 starlette
    /// 读的是它）+ RFC 5987 的 `filename*` 兜底。
    func testChineseFilenameIsSentRawUTF8AndRFC5987Encoded() {
        let form = MultipartFormData(boundary: "BOUND")
        let header = form.headerText(name: "file", filename: "中文报表.xlsx", mimeType: "application/vnd.ms-excel")

        XCTAssertTrue(
            header.contains(#"filename="中文报表.xlsx""#),
            "缺原始 UTF-8 文件名：后端 starlette 只认 filename，中文名会丢。实际：\(header)"
        )
        XCTAssertTrue(
            header.contains(#"filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%8A%A5%E8%A1%A8.xlsx"#),
            "缺 RFC 5987 编码：认这一套的解析器会拿不到中文名。实际：\(header)"
        )
        XCTAssertTrue(header.hasPrefix("--BOUND\r\nContent-Disposition: form-data; name=\"file\""))
        XCTAssertTrue(header.hasSuffix("\r\n\r\n"), "头部块必须以空行收尾")
    }

    /// 回归：Swift 里 `"\r\n"` 是**一个**扩展字形簇（一个 `Character` 含两个码位），
    /// 按 `Character` 遍历时 `case "\r"` 不会命中它 —— 曾经因此让 CRLF 原样进了
    /// `filename="…"`，即真的可注入请求头。
    func testCRLFIsStrippedEvenThoughItIsASingleGraphemeCluster() {
        XCTAssertEqual(MultipartFormData.sanitised("a\r\nb"), "ab")
        XCTAssertEqual(MultipartFormData.sanitised("a\rb"), "ab", "单独 CR 也要去掉")
        XCTAssertEqual(MultipartFormData.sanitised("a\nb"), "ab", "单独 LF 也要去掉")
        XCTAssertEqual(MultipartFormData.quoted("a\r\nb\"c\\d"), #"ab\"c\\d"#)
    }

    /// 两种文件名形态声明必须一致：一个带换行的值会让服务端存下的名字与界面显示的不同。
    func testBothFilenameFormsUseTheSameSanitisedValue() {
        let form = MultipartFormData(boundary: "BOUND")
        let header = form.headerText(name: "file", filename: "报\r\n表.xlsx", mimeType: nil)

        XCTAssertFalse(header.contains("\r\n表"), "换行必须被去掉")
        XCTAssertTrue(header.contains(#"filename="报表.xlsx""#), "实际：\(header.debugDescription)")
        XCTAssertTrue(
            header.contains(#"filename*=UTF-8''%E6%8A%A5%E8%A1%A8.xlsx"#),
            "filename* 也必须用清洗后的值。实际：\(header.debugDescription)"
        )
    }

    /// 文件名 / 字段名里的 CR/LF 会被去掉 —— 否则可以注入额外请求头。
    func testHeaderInjectionViaFilenameAndFieldNameIsNeutralised() {
        let form = MultipartFormData(boundary: "BOUND")
        let header = form.headerText(
            name: "file\r\nX-Evil: 1",
            filename: "a\"b\r\nX-Injected: 1\\.xlsx",
            mimeType: nil
        )

        XCTAssertFalse(header.contains("\r\nX-Injected"), "CRLF 必须被去掉")
        XCTAssertFalse(header.contains("\r\nX-Evil"), "字段名同样要防注入")
        XCTAssertTrue(header.contains(#"filename="a\"bX-Injected: 1\\.xlsx""#), "引号与反斜杠要转义。实际：\(header)")
    }

    // MARK: - 边界与 MIME 的头注入

    /// 回归：`boundary` 是**公开初始化参数**，它会同时进请求头 `Content-Type` 与请求体
    /// 的分隔行 —— 含 CR/LF 时既能污染请求头，也能在体里伪造分隔。必须在构造期归一化，
    /// 且头与体读同一个值（不存在「头干净、体脏」的分裂）。
    func testBoundaryWithCRLFIsNeutralisedBeforeItReachesHeaderOrBody() throws {
        var form = MultipartFormData(boundary: "BOUND\r\nX-Injected: 1")

        XCTAssertEqual(
            form.boundary,
            "BOUNDX-Injected:1",
            "CR/LF 与空格等非 bchars 字符应被剔除，其余合法字符保留"
        )
        XCTAssertFalse(form.contentType.contains("\r"))
        XCTAssertFalse(form.contentType.contains("\n"))
        XCTAssertEqual(form.contentType, "multipart/form-data; boundary=\(form.boundary)")

        form.addField("country", "US")
        let body = String(decoding: try readAll(form.makeBodyStream()), as: UTF8.self)
        XCTAssertTrue(body.hasPrefix("--\(form.boundary)\r\n"), "体里的分隔行必须用同一个值")
        XCTAssertTrue(body.hasSuffix("--\(form.boundary)--\r\n"), "结束段亦然")
        XCTAssertNoInjectedHeader(in: body)
        XCTAssertNoInjectedHeader(in: form.headerText(name: "file", filename: "a.csv", mimeType: nil))
    }

    /// 归一化后为空（或超长）时回落到随机分隔串：宁可换一个必然合法的值，也不发出一个
    /// 会让服务端「找不到结束段」的畸形边界。
    func testUnsalvageableOrOverlongBoundaryFallsBackToRandom() {
        let hosts = [
            "\r\n",
            "",
            "   ",
            String(repeating: "A", count: MultipartFormData.maxBoundaryLength + 1),
        ]
        for hostile in hosts {
            let form = MultipartFormData(boundary: hostile)
            XCTAssertFalse(form.boundary.isEmpty, "分隔串不能为空：\(hostile.debugDescription)")
            XCTAssertNotEqual(form.boundary, hostile)
            XCTAssertLessThanOrEqual(
                form.boundary.unicodeScalars.count,
                MultipartFormData.maxBoundaryLength,
                "RFC 2046 §5.1.1 的上限"
            )
            XCTAssertEqual(
                MultipartFormData.safeBoundary(form.boundary),
                form.boundary,
                "归一化必须幂等：已是安全值时不得再变"
            )
            XCTAssertFalse(form.contentType.contains("\r"))
            XCTAssertFalse(form.contentType.contains("\n"))
        }
    }

    /// 回归：`mimeType` 原样拼进 part 的 `Content-Type:` 行时，等于多一个头字段注入点。
    /// 含 CR/LF 的值必须先剔除换行，再因「形态不合法」回落到 `application/octet-stream`。
    func testMimeTypeHeaderInjectionIsNeutralised() {
        let form = MultipartFormData(boundary: "BOUND")
        let header = form.headerText(
            name: "file",
            filename: "a.csv",
            mimeType: "text/csv\r\nX-Injected: 1"
        )

        let lines = header.components(separatedBy: "\r\n")
        XCTAssertEqual(
            lines,
            [
                "--BOUND",
                #"Content-Disposition: form-data; name="file"; filename="a.csv"; filename*=UTF-8''a.csv"#,
                "Content-Type: application/octet-stream",
                "",
                "",
            ],
            "注入新行会让行数变多。实际：\(header.debugDescription)"
        )
        XCTAssertNoInjectedHeader(in: header)
    }

    /// 合法 MIME（含参数）照旧放行；不合法的一律回落 —— 不要为了保护「异常输入」而把
    /// 正常调用方的 `text/csv` 也改掉。
    func testValidMimeTypeIsPreservedAndMalformedOneFallsBack() {
        let preserved = [
            "text/csv",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "  text/csv; charset=utf-8  ",
            "text/plain; charset=\"utf-8\"",
            "text/plain; note=\"a;b\"",
        ]
        for value in preserved {
            XCTAssertTrue(MultipartFormData.isValidMediaType(MultipartFormData.sanitisedHeaderValue(value)))
            XCTAssertEqual(
                MultipartFormData.sanitisedMimeType(value),
                MultipartFormData.sanitisedHeaderValue(value),
                "合法值只去掉首尾空白，不改变内容"
            )
        }

        let rejected = [
            "text",
            "text/",
            "/csv",
            "not a mime",
            "\r\n",
            "",
            "text/csv\r\nX-Injected: 1",
            "text/plain; charset",
            "text/plain; charset=\"utf-8",
            "text/plain; note=a;b",
        ]
        for value in rejected {
            XCTAssertEqual(
                MultipartFormData.sanitisedMimeType(value),
                MultipartFormData.fallbackMimeType,
                "形态不合法必须回落而不是原样拼进头行：\(value.debugDescription)"
            )
        }

        // `FilePart` 在入口就归一化，公开属性本身可被信任为安全头值。
        let part = MultipartFormData.FilePart(
            name: "file",
            filename: "a.csv",
            mimeType: "text/csv\r\nX-Injected: 1",
            source: .data(Data("x".utf8))
        )
        XCTAssertEqual(part.mimeType, MultipartFormData.fallbackMimeType)
    }

    /// 回归（复核意见 ①）：`quoted-string` 参数里的分号（`note="a;b"`）与 quoted-pair
    /// 反斜杠转义（`note="a\"b"`）都是 RFC 7231 的**合法**内容。按 `;` 硬切、或一见 `\`
    /// 就判非法，都会把一个合法媒体类型误判成「不合法」而错误回落为
    /// `application/octet-stream` —— 调用方声明的类型被悄悄改掉，正是这条复核意见指出的
    /// 缺陷。此处逐值断言「原样保留」，并确认拼出的头行仍只有一行。
    func testQuotedStringMimeParametersArePreservedIntact() {
        let preserved = [
            #"text/plain; note="a;b""#,
            #"text/plain; note="a\"b""#,
            #"text/plain; note="a\\b""#,
            #"application/pdf; filename="a;b.csv"; charset="utf-8""#,
            #"application/vnd.ms-excel; name*=UTF-8''%E4%B8%AD; note="x;y""#,
        ]
        for value in preserved {
            XCTAssertTrue(
                MultipartFormData.isValidMediaType(value),
                "quoted-string 参数是合法形态：\(value.debugDescription)"
            )
            XCTAssertEqual(
                MultipartFormData.sanitisedMimeType(value),
                value,
                "合法 MIME 必须逐字符原样保留（含引号内的分号与转义反斜杠）：\(value.debugDescription)"
            )
        }

        // 引号未闭合 / 反斜杠悬空 / 参数值裸用分号：仍是不合法形态，必须回落。
        let rejected = [
            #"text/plain; note="a;b"#,
            #"text/plain; note="a\"#,
            #"text/plain; note=a;b"#,
        ]
        for value in rejected {
            XCTAssertFalse(
                MultipartFormData.isValidMediaType(value),
                "形态不合法不得被当成合法：\(value.debugDescription)"
            )
            XCTAssertEqual(
                MultipartFormData.sanitisedMimeType(value),
                MultipartFormData.fallbackMimeType,
                "形态不合法必须回落：\(value.debugDescription)"
            )
        }

        // 合法值拼进 part header 后仍是单独一行，且内容与声明一致。
        let form = MultipartFormData(boundary: "BOUND")
        let header = form.headerText(
            name: "file",
            filename: "a.csv",
            mimeType: #"text/plain; note="a;b""#
        )
        XCTAssertTrue(
            header.contains(#"Content-Type: text/plain; note="a;b""#),
            "quoted-string 里的分号不得被当成参数分隔符而改动内容：\(header.debugDescription)"
        )
        XCTAssertNoInjectedHeader(in: header)
    }

    // MARK: - 长度与流式产出

    func testContentLengthMatchesActualBodyBytes() throws {
        var form = MultipartFormData(boundary: "BOUND")
        form.addField("country", "US")
        form.addFile("file", filename: "报表.csv", mimeType: "text/csv", data: Data("a,b\n1,2\n".utf8))

        let declared = try form.contentLength()
        let actual = try readAll(form.makeBodyStream())

        XCTAssertEqual(declared, actual.count, "声明的 Content-Length 必须与实际字节数一致")
        XCTAssertTrue(String(decoding: actual, as: UTF8.self).hasSuffix("--BOUND--\r\n"))
    }

    /// 磁盘文件按块读出：内存占用与文件大小无关（`largestProducedChunk` 是这条约束的
    /// 可断言形式），而且内容必须逐字节正确。
    func testFileIsProducedInBoundedChunksAndContentIsIntact() throws {
        let fileURL = try makeTempFile(bytes: 200 * 1024)
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL) }

        var form = MultipartFormData(boundary: "BOUND")
        form.addFile("file", filename: "ledger.csv", contentsOf: fileURL)

        let chunkSize = 8 * 1024
        // 显式用小 chunkSize 构造：默认 64 KiB 的话，「块 ≤ 阈值」这条断言会退化
        // 成对默认值的复述。
        let stream = MultipartBodyStream(segments: form.bodySegments(), chunkSize: chunkSize)
        stream.open()
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            collected.append(buffer, count: read)
        }

        XCTAssertEqual(collected.count, try form.contentLength())

        // 逐字节校验：头部之后的 200 KiB 必须与磁盘文件完全一致，尾部是段结束标记。
        let separator = try XCTUnwrap(collected.range(of: Data("\r\n\r\n".utf8)))
        let payloadStart = separator.upperBound
        let fileData = try Data(contentsOf: fileURL)
        XCTAssertEqual(
            collected.subdata(in: payloadStart..<(payloadStart + fileData.count)),
            fileData,
            "流式读出的文件内容必须与磁盘上逐字节相同"
        )
        let tail = String(
            decoding: collected.subdata(in: (payloadStart + fileData.count)..<collected.count),
            as: UTF8.self
        )
        XCTAssertEqual(tail, "\r\n--BOUND--\r\n")

        XCTAssertLessThanOrEqual(
            stream.largestProducedChunk,
            chunkSize,
            "文件内容必须按块产出，不能整份一次性进内存"
        )
        XCTAssertLessThan(
            stream.largestProducedChunk,
            200 * 1024,
            "单块不得等于整个文件大小（那就是「整文件进内存」）"
        )
    }

    func testEmptyFileStillProducesValidBody() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("empty-\(UUID().uuidString).txt")
        try Data().write(to: fileURL)
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL) }

        var form = MultipartFormData(boundary: "BOUND")
        form.addFile("file", filename: "empty.txt", contentsOf: fileURL)

        let body = String(decoding: try readAll(form.makeBodyStream()), as: UTF8.self)
        XCTAssertEqual(try form.contentLength(), body.utf8.count)
        XCTAssertTrue(body.contains("filename=\"empty.txt\""), "空文件也要有头部")
        XCTAssertTrue(body.hasSuffix("--BOUND--\r\n"))
    }

    func testMissingFileFailsFastWithFileReadError() {
        let form = formWithFile(at: URL(fileURLWithPath: "/nonexistent/\(UUID().uuidString).csv"))

        do {
            _ = try form.contentLength()
            XCTFail("文件不存在必须提前失败")
        } catch let error as APIError {
            guard case .fileRead = error else {
                return XCTFail("期望 .fileRead，实际 \(error)")
            }
            XCTAssertFalse(error.requiresCredentialFix, "本地文件问题与凭据无关")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    // MARK: - 真实请求形状

    func testUploadSendsMultipartHeadersAndStreamsFileOverTheWire() async throws {
        let fileURL = try makeTempFile(bytes: 5 * 1024, seed: 0x41)
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL) }

        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/upload": .json(200, #"{"ok":true}"#),
        ])

        var form = MultipartFormData(boundary: "BOUND")
        form.addField("country", "US")
        form.addFile(
            "file",
            filename: "中文广告报表.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            contentsOf: fileURL
        )

        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)
        let reply: [String: Bool] = try await client.upload("/ad-upload/upload", form: form)

        XCTAssertEqual(reply["ok"], true)
        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "POST")
        XCTAssertEqual(recorded.apiKey, "blf_test")
        XCTAssertEqual(recorded.header("Content-Type"), "multipart/form-data; boundary=BOUND")
        XCTAssertEqual(
            recorded.header("Content-Length"),
            String(try form.contentLength()),
            "必须显式声明 Content-Length（否则退化为 chunked，网关行为不一致）"
        )
        XCTAssertEqual(
            recorded.timeout,
            RequestTier.report.timeout,
            "上传默认走报表档（60s），与 Web 代理对 report-upload 的口径一致"
        )

        let body = try XCTUnwrap(recorded.body)
        XCTAssertTrue(body.contains(#"Content-Disposition: form-data; name="country""#))
        XCTAssertTrue(body.contains("US"))
        XCTAssertTrue(body.contains("中文广告报表.xlsx"), "中文文件名要原样出现在请求体里")
        XCTAssertTrue(body.contains(String(repeating: "A", count: 5 * 1024)), "磁盘文件内容要真的传出去")
        XCTAssertTrue(body.hasSuffix("--BOUND--\r\n"))
    }

    func testUploadAuthFailureIsCredentialProblem() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/upload": .json(403, #"{"detail":"Invalid API key"}"#),
        ])

        var form = MultipartFormData(boundary: "BOUND")
        form.addFile("file", filename: "a.csv", data: Data("x".utf8))

        do {
            let _: [String: Bool] = try await APIClient(
                baseURL: baseURL,
                apiKey: "blf_test",
                session: session
            ).upload("/ad-upload/upload", form: form)
            XCTFail("403 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized(status: 403, body: #"{"detail":"Invalid API key"}"#))
            XCTAssertTrue(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    /// 真实请求上再验一次：恶意 boundary / mimeType 在网络上不得变成额外头行。
    func testUploadWithHostileBoundaryAndMimeTypeInjectsNoHeaderLine() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/ad-upload/upload": .json(200, #"{"ok":true}"#),
        ])

        var form = MultipartFormData(boundary: "BOUND\r\nX-Injected: 1")
        form.addFile(
            "file",
            filename: "a.csv",
            mimeType: "text/csv\r\nX-Injected: 2",
            data: Data("x".utf8)
        )

        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)
        let reply: [String: Bool] = try await client.upload("/ad-upload/upload", form: form)
        XCTAssertEqual(reply["ok"], true)

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        let contentType = try XCTUnwrap(recorded.header("Content-Type"))
        XCTAssertFalse(contentType.contains("\r"))
        XCTAssertFalse(contentType.contains("\n"))
        XCTAssertEqual(contentType, "multipart/form-data; boundary=\(form.boundary)")
        XCTAssertNoInjectedHeader(in: try XCTUnwrap(recorded.body))
    }

    // MARK: - 工具

    /// 断言文本里没有「凭空多出来的头行」：注入的载体是一行以字段名开头的新行，
    /// 而不是被过滤后仍可能残留在分隔串里的子串。
    private func XCTAssertNoInjectedHeader(
        in text: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let injected = text
            .components(separatedBy: "\r\n")
            .filter { $0.hasPrefix("X-Injected") || $0.hasPrefix("X-Evil") }
        XCTAssertTrue(injected.isEmpty, "文本里出现注入的头行：\(injected)", file: file, line: line)
    }

    private func formWithFile(at url: URL) -> MultipartFormData {
        var form = MultipartFormData(boundary: "BOUND")
        form.addFile("file", filename: url.lastPathComponent, contentsOf: url)
        return form
    }

    private func makeTempFile(bytes: Int, seed: UInt8 = 0) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("multipart-\(UUID().uuidString).bin")
        var data = Data(count: bytes)
        if seed == 0 {
            for index in 0..<bytes { data[index] = UInt8(index % 251) }
        } else {
            for index in 0..<bytes { data[index] = seed }
        }
        try data.write(to: url)
        return url
    }

    private func readAll(_ stream: InputStream) throws -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read < 0 { throw APIError.fileRead("流读取失败") }
            if read == 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
