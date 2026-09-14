import Foundation

/// `multipart/form-data` 请求体：字段 + 文件，**文件按块流式读出，不整份进内存**。
///
/// 为什么不是 `Data` 拼接：`backend/app/api/v1/endpoints/` 有 12 个端点吃
/// `UploadFile`，其中 `report-upload/commit` 明说要扛 30–50k 行的月报台账。把整个
/// 上传体拼成一个 `Data` 会让峰值内存随文件大小线性上涨（一份 200MB 的台账 = 200MB
/// 常驻 + 一份拷贝交给 URLSession），用户第一次传大文件就会触发。
///
/// 因此本类型的**唯一产出通道**是 `makeBodyStream()`：一个按需产出的 `InputStream`，
/// 逐块（默认 64 KiB）从磁盘读文件。`contentLength()` 由文件系统元数据算出，不必读
/// 一遍文件 —— 这既是「流式」的证据，也是能提前设 `Content-Length` 的前提。
///
/// 边界与文件名编码：
/// - 段间用 `\r\n` 分隔，结束段 `--<boundary>--\r\n`（RFC 7578 §4.1）；
/// - 文件名同时给两种形态：`filename="中文.xlsx"`（原始 UTF-8 —— **浏览器就是这么发
///   的**，后端 `starlette/formparsers.py` 读的正是这个参数，用 utf-8 解）与
///   `filename*=UTF-8''%E4%B8%AD...`（RFC 5987，给认这一套的解析器兜底）。只发
///   `filename*` 反而危险：`python-multipart 0.0.17` 只认 `filename`，中文名会丢。
public struct MultipartFormData: Sendable {
    /// 普通文本字段（如 `country=US`）。
    public struct Field: Sendable, Equatable {
        public let name: String
        public let value: String

        public init(name: String, value: String) {
            self.name = name
            self.value = value
        }
    }

    /// 文件段。`source` 决定数据来自内存还是磁盘。
    public struct FilePart: Sendable, Equatable {
        public enum Source: Sendable, Equatable {
            /// 小体量内容（如内存里生成的 CSV）。
            case data(Data)
            /// 磁盘文件 —— 按块读取，不进内存。
            case file(URL)
        }

        public let name: String
        public let filename: String
        public let mimeType: String
        public let source: Source

        public init(name: String, filename: String, mimeType: String, source: Source) {
            self.name = name
            self.filename = filename
            // `mimeType` 会被拼进 part 的 `Content-Type:` 头行，故在**入口**就归一化
            // （拼装处还会再兜一次，幂等）。属性因此可被信任为「安全头值」。
            self.mimeType = MultipartFormData.sanitisedMimeType(mimeType)
            self.source = source
        }
    }

    /// 分隔串。测试可注入固定值，生产用随机值（同一请求体内须唯一）。
    ///
    /// 该值同时出现在请求头 `Content-Type`（`contentType`）与请求体的分隔行里，
    /// 原样接收调用方字符串等于开一条头注入通道（`boundary` 完全可能来自文件名、
    /// 上传批次号这类外部数据）。故构造期即按 RFC 2046 §5.1.1 的 `bchars` 归一化，
    /// 见 `safeBoundary(_:)`。归一化只有一个出口 —— `boundary` 是 `let`，`contentType`
    /// 与请求体读的都是它，天然同值，不存在「头干净、体脏」的分裂。
    public let boundary: String
    public private(set) var fields: [Field] = []
    public private(set) var fileParts: [FilePart] = []

    public init(boundary: String = MultipartFormData.randomBoundary()) {
        self.boundary = MultipartFormData.safeBoundary(boundary)
    }

    // MARK: - 组装

    public mutating func addField(_ name: String, _ value: String) {
        fields.append(Field(name: name, value: value))
    }

    /// 追加磁盘文件（按块读取）。
    public mutating func addFile(
        _ name: String,
        filename: String,
        mimeType: String = "application/octet-stream",
        contentsOf url: URL
    ) {
        fileParts.append(
            FilePart(name: name, filename: filename, mimeType: mimeType, source: .file(url))
        )
    }

    /// 追加内存内容（同样是流式吐出，只是源头在内存）。
    public mutating func addFile(
        _ name: String,
        filename: String,
        mimeType: String = "application/octet-stream",
        data: Data
    ) {
        fileParts.append(
            FilePart(name: name, filename: filename, mimeType: mimeType, source: .data(data))
        )
    }

    /// 请求头 `Content-Type` 的值。`boundary` 已在构造期归一化（`safeBoundary(_:)`），
    /// 故此处不含任何 CR / LF。
    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    /// 上传体总字节数 —— 由文件系统元数据算出，**不读文件内容**。
    ///
    /// 抛错意味着这个上传体根本构造不出来（文件被删 / 路径是目录 / 读不到属性）。
    /// 提前失败比让 URLSession 传一半再断更好定位。
    public func contentLength() throws -> Int {
        var total = 0
        for segment in bodySegments() {
            total += try byteCount(of: segment)
        }
        return total
    }

    /// 产出按需读取的上传体（URLSession 边读边发）。
    public func makeBodyStream() -> InputStream {
        MultipartBodyStream(segments: bodySegments(), chunkSize: MultipartBodyStream.defaultChunkSize)
    }

    // MARK: - 段序列

    /// 上传体被拆成的段序列 —— 头部/分隔符是内存里的小段，文件是「URL + 长度」描述符。
    func bodySegments() -> [MultipartBodyStream.Segment] {
        var segments: [MultipartBodyStream.Segment] = []

        for field in fields {
            segments.append(.bytes(Data(headerText(name: field.name, filename: nil, mimeType: nil).utf8)))
            segments.append(.bytes(Data(field.value.utf8)))
            segments.append(.bytes(Self.segmentTerminator))
        }

        for part in fileParts {
            segments.append(.bytes(Data(headerText(
                name: part.name,
                filename: part.filename,
                mimeType: part.mimeType
            ).utf8)))
            switch part.source {
            case .data(let data):
                segments.append(.bytes(data))
            case .file(let url):
                segments.append(.file(url: url))
            }
            segments.append(.bytes(Self.segmentTerminator))
        }

        segments.append(.bytes(Data("--\(boundary)--\r\n".utf8)))
        return segments
    }

    /// 段的头部文本（不含数据本体）：分隔行 + `Content-Disposition`（+ 文件名的
    /// RFC 5987 兜底）+ 可选 `Content-Type` + 结束空行。
    ///
    /// 单独抽成 `String`，让「头部长什么样」可以被逐字符断言（含中文文件名），
    /// 而不用去读整个上传体。
    func headerText(name: String, filename: String?, mimeType: String?) -> String {
        var lines = ["--\(boundary)"]
        var disposition = "Content-Disposition: form-data; name=\"\(Self.quoted(name))\""
        if let filename {
            disposition += "; filename=\"\(Self.quoted(filename))\""
            // `filename*` 走百分号编码，本身已无头注入风险；但用**同一个**清洗后的值，
            // 两种形态声明的文件名才会一致（否则服务端读到的与展示的差一个换行）。
            disposition += "; filename*=UTF-8''\(Self.rfc5987Encoded(Self.sanitised(filename)))"
        }
        lines.append(disposition)
        if let mimeType {
            // 再兜一次（`FilePart.init` 已归一化过，幂等）：`headerText` 是模块内可直调的
            // 拼装点，头值的净化不能只依赖上游某一处记得清洗。
            lines.append("Content-Type: \(Self.sanitisedMimeType(mimeType))")
        }
        // 两个空串 → 头部块之后正好一个空行（`\r\n\r\n` 收尾）。
        lines.append("")
        lines.append("")
        return lines.joined(separator: "\r\n")
    }

    private func byteCount(of segment: MultipartBodyStream.Segment) throws -> Int {
        switch segment {
        case .bytes(let data):
            return data.count
        case .file(let url):
            return try MultipartBodyStream.fileSize(of: url)
        }
    }

    private static let segmentTerminator = Data("\r\n".utf8)

    // MARK: - 转义

    /// 去掉 CR / LF（头注入的唯一入口）。
    ///
    /// 必须按 `unicodeScalars` 遍历，**不能**按 `Character`：Swift 里 `"\r\n"` 是一个
    /// 扩展字形簇（一个 `Character` 含两个码位），`case "\r"` 根本不会命中它 ——
    /// 实测「按 Character 遍历」会把 CRLF 原样放进 `filename="…"`，即真的可注入。
    static func sanitised(_ raw: String) -> String {
        var out = ""
        out.unicodeScalars.reserveCapacity(raw.unicodeScalars.count)
        for scalar in raw.unicodeScalars where scalar != "\r" && scalar != "\n" {
            out.unicodeScalars.append(scalar)
        }
        return out
    }

    /// multipart 分隔串的安全形态。
    ///
    /// RFC 2046 §5.1.1 规定 boundary 是 1–70 个 `bchars`（数字 / 字母 / `'()+_,-./:=?`），
    /// 该集合**不含** CR、LF、空格、`"`、`;` —— 这正是它不能被头注入利用的原因。
    /// 过滤后为空或超过 70 字符时回落到随机分隔串：与其发出一个畸形边界让服务端按
    /// 「找不到结束段」整请求失败，不如换一个必然合法的值（`contentType` 与请求体同源，
    /// 不会因此失配）。
    static func safeBoundary(_ raw: String) -> String {
        var out = ""
        out.unicodeScalars.reserveCapacity(raw.unicodeScalars.count)
        for scalar in raw.unicodeScalars where boundaryCharacters.contains(scalar) {
            out.unicodeScalars.append(scalar)
        }
        guard !out.isEmpty, out.unicodeScalars.count <= maxBoundaryLength else {
            return randomBoundary()
        }
        return out
    }

    /// multipart 分隔串合法字符集（RFC 2046 `bcharsnospace`）。
    private static let boundaryCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'()+_,-./:=?"
    )

    /// 分隔串长度上限（RFC 2046 §5.1.1）。
    static let maxBoundaryLength = 70

    /// 头值的安全形态：先剔除 CR / LF 与其余控制字符（头注入的载体），再去掉首尾空白。
    ///
    /// 与 `sanitised(_:)` 同样按 `unicodeScalars` 遍历 —— Swift 里 `"\r\n"` 是**一个**
    /// 扩展字形簇，按 `Character` 遍历时 `case "\r"` 根本不会命中它（本 PR 的 filename
    /// 修复就是踩到这个）。
    static func sanitisedHeaderValue(_ raw: String) -> String {
        var out = ""
        out.unicodeScalars.reserveCapacity(raw.unicodeScalars.count)
        for scalar in raw.unicodeScalars where !isHeaderControl(scalar) {
            out.unicodeScalars.append(scalar)
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /// 控制字符（含 CR / LF / NUL / DEL）：头字段值里一律不允许出现。
    private static func isHeaderControl(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "\r" || scalar == "\n" || scalar.value < 0x20 || scalar.value == 0x7F
    }

    /// `Content-Type` 头值的安全形态。
    ///
    /// 两道防线：① 剔除 CR / LF 与其余控制字符；② 校验它确实是
    /// `type/subtype[; 参数]` 这一 RFC 7231 媒体类型形态（字符集按 RFC 7230 的 `token`）。
    /// 不合形态一律回落到 `application/octet-stream`。
    ///
    /// 只做 ① 不够：`"text/csv\r\nX-Evil: 1"` 剔掉换行后会拼成
    /// `Content-Type: text/csvX-Evil: 1` —— 不再是注入，但仍是一个谁也解析不了的垃圾
    /// media type，把 part header 的语义搅坏。
    static func sanitisedMimeType(_ raw: String) -> String {
        let cleaned = sanitisedHeaderValue(raw)
        return isValidMediaType(cleaned) ? cleaned : fallbackMimeType
    }

    /// 形态不合法的 MIME 回落值。
    static let fallbackMimeType = "application/octet-stream"

    /// `type/subtype[; 参数]` 形态校验（不解析语义，只保证「拼进头行是安全的、可解析的」）。
    ///
    /// 按 RFC 7231 §3.1.1.1 的 `media-type = type "/" subtype *( OWS ";" OWS parameter )`
    /// **扫描**，而不是 `split(separator: ";")` 硬切：参数值可以是 `quoted-string`，分号与
    /// 反斜杠转义在其中都是合法内容（`text/plain; note="a;b"`、`text/plain; note="a\"b"`），
    /// 硬切会把一个合法值切成碎片后误判为非法，错误回落到 `application/octet-stream`。
    static func isValidMediaType(_ value: String) -> Bool {
        var scanner = MediaTypeScanner(value)
        return scanner.parse()
    }

    /// 媒体类型的**结构**扫描器：只有 `quoted-string` 之外的分号才算参数分隔符。
    ///
    /// 逐码位推进，引号内的分号、引号内的转义反斜杠都不会影响切分。合法性判据取自
    /// RFC 7230：`quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )` —— 反斜杠转义是
    /// 合法内容，不是可疑字符；`quoted-string` 未闭合才是非法。
    private struct MediaTypeScanner {
        private let scalars: [Unicode.Scalar]
        private var index = 0

        init(_ value: String) {
            scalars = Array(value.unicodeScalars)
        }

        /// `media-type = type "/" subtype *( OWS ";" OWS parameter )`。
        mutating func parse() -> Bool {
            guard parseToken(), consume("/"), parseToken() else { return false }
            skipWhitespace()
            while !isAtEnd {
                guard consume(";") else { return false }
                skipWhitespace()
                guard parseToken() else { return false }
                skipWhitespace()
                guard consume("=") else { return false }
                skipWhitespace()
                guard parseParameterValue() else { return false }
                skipWhitespace()
            }
            return true
        }

        /// `parameter = token "=" ( token / quoted-string )`。
        private mutating func parseParameterValue() -> Bool {
            if isAt("\"") { return parseQuotedString() }
            return parseToken()
        }

        /// `quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE`。
        private mutating func parseQuotedString() -> Bool {
            guard consume("\"") else { return false }
            while let scalar = current {
                if scalar == "\"" {
                    index += 1
                    return true
                }
                if scalar == "\\" {
                    index += 1
                    guard let escaped = current, isQuotedPairCharacter(escaped) else { return false }
                    index += 1
                    continue
                }
                guard isQuotedTextCharacter(scalar) else { return false }
                index += 1
            }
            return false  // 引号未闭合
        }

        /// `token`：1 个以上 RFC 7230 token 字符。
        private mutating func parseToken() -> Bool {
            let start = index
            while let scalar = current, Self.tokenCharacters.contains(scalar) { index += 1 }
            return index > start
        }

        /// `qdtext = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text`（VCHAR 去掉 `"` 与 `\`）。
        private func isQuotedTextCharacter(_ scalar: Unicode.Scalar) -> Bool {
            if scalar == "\t" || scalar == " " { return true }
            if scalar.value >= 0x80 { return true }
            return scalar.value >= 0x21 && scalar.value <= 0x7E && scalar != "\"" && scalar != "\\"
        }

        /// `quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )`。
        private func isQuotedPairCharacter(_ scalar: Unicode.Scalar) -> Bool {
            if scalar == "\t" || scalar == " " { return true }
            if scalar.value >= 0x80 { return true }
            return scalar.value >= 0x21 && scalar.value <= 0x7E
        }

        private var current: Unicode.Scalar? { index < scalars.count ? scalars[index] : nil }

        private var isAtEnd: Bool { index >= scalars.count }

        private func isAt(_ scalar: Unicode.Scalar) -> Bool { current == scalar }

        private mutating func consume(_ scalar: Unicode.Scalar) -> Bool {
            guard isAt(scalar) else { return false }
            index += 1
            return true
        }

        /// `OWS = *( SP / HTAB )`。
        private mutating func skipWhitespace() {
            while let scalar = current, scalar == " " || scalar == "\t" { index += 1 }
        }

        /// RFC 7230 `token` 字符集。
        private static let tokenCharacters = CharacterSet(
            charactersIn: "!#$%&'*+-.^_`|~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        )
    }

    /// `quoted-string` 里的安全形态：先去 CR/LF（头注入），再转义 `\` 与 `"`。
    static func quoted(_ raw: String) -> String {
        var out = ""
        let sanitised = sanitised(raw)
        out.reserveCapacity(sanitised.count)
        for character in sanitised {
            switch character {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            default: out.append(character)
            }
        }
        return out
    }

    /// RFC 5987 `attr-char` 集合的百分号编码（`A-Za-z0-9!#$&+-.^_\`|~` 之外全编码）。
    ///
    /// 不能用 `CharacterSet.alphanumerics`：中文汉字也是「字母」，会被原样放行，
    /// 而 `filename*` 的值必须是纯 ASCII。
    static func rfc5987Encoded(_ raw: String) -> String {
        let allowed = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~"
        )
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }

    /// 随机分隔串。公开是为了让调用方能自行构造带边界的表单（测试用固定值）。
    public static func randomBoundary() -> String {
        "BelieveBoy-" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
}

/// 上传体流：把 `MultipartFormData` 的段序列按需吐给 URLSession。
///
/// 关键约束是**内存不随文件大小增长**：文件段以 `FileHandle` 逐块读取（`chunkSize`），
/// 任何时刻只持有一个块的字节。`largestProducedChunk` 把这条约束变成可断言的事实
/// （测试对 1 MiB 文件断言它 ≤ `chunkSize`），而不是靠注释自证。
///
/// 只能读一次（`InputStream` 没有 rewind），故只适合「一条请求体用一次」。若将来需要
/// 重定向重发体，得改用 `URLSessionTaskDelegate.needNewBodyStream` 重建 —— 当前后端
/// 不重定向，不做无谓复杂度。
final class MultipartBodyStream: InputStream {
    enum Segment: Sendable, Equatable {
        /// 内存里的小段：分隔行 / 头部 / 字段值 / 段尾 `\r\n`。
        case bytes(Data)
        /// 磁盘文件：长度在打开时由文件系统给出（构造期不读内容）。
        case file(url: URL)
    }

    static let defaultChunkSize = 64 * 1024

    /// 文件块上限。测试用小值验证「分块产出」。
    let chunkSize: Int

    /// 迄今单次产出的最大块字节数（测试断言用）。
    private(set) var largestProducedChunk = 0

    private var remainingSegments: [Segment]
    private var current = Data()
    private var currentOffset = 0
    private var fileCursor: FileCursor?
    private var opened = false
    private let lock = NSLock()
    private var storedStatus: Stream.Status = .notOpen
    private var storedError: Error?

    private struct FileCursor {
        let handle: FileHandle
        var remaining: Int
    }

    init(segments: [Segment], chunkSize: Int = MultipartBodyStream.defaultChunkSize) {
        self.remainingSegments = segments
        self.chunkSize = max(1, chunkSize)
        super.init(data: Data())
    }

    // MARK: - Stream

    override var streamStatus: Stream.Status { withLock { storedStatus } }

    override var streamError: Error? { withLock { storedError } }

    override func open() {
        withLock {
            guard !opened else { return }
            opened = true
            storedStatus = .open
        }
    }

    override func close() {
        withLock {
            fileCursor?.handle.closeFile()
            fileCursor = nil
            storedStatus = .closed
        }
    }

    override var hasBytesAvailable: Bool {
        withLock { !current.isEmpty || fileCursor != nil || !remainingSegments.isEmpty }
    }

    override func read(_ buffer: UnsafeMutablePointer<UInt8>, maxLength len: Int) -> Int {
        guard len > 0 else { return 0 }
        guard withLock({ opened }) else {
            fail(with: APIError.transport("上传体流未打开即被读取"))
            return -1
        }

        // 空段（如空字段值）不产出字节，循环推进到有内容的段或 EOF。
        while currentOffset >= current.count {
            if withLock({ storedError != nil }) { return -1 }
            guard loadNextSegment() else { return 0 }
        }
        if withLock({ storedError != nil }) { return -1 }

        let count = min(current.count - currentOffset, len)
        current.withUnsafeBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            buffer.update(from: base.advanced(by: currentOffset), count: count)
        }
        currentOffset += count
        return count
    }

    override func getBuffer(
        _ buffer: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
        length len: UnsafeMutablePointer<Int>
    ) -> Bool {
        // 不走零拷贝：文件块本来就只保留到被读走，暴露指针会让生命周期失控。
        false
    }

    // MARK: - 内部

    /// 载入下一块内容；返回 `false` = 段已耗尽（EOF，不是错误）。
    private func loadNextSegment() -> Bool {
        current = Data()
        currentOffset = 0

        if let cursor = withLock({ fileCursor }) {
            do {
                let chunk = try cursor.handle.read(upToCount: min(chunkSize, cursor.remaining)) ?? Data()
                guard !chunk.isEmpty else {
                    throw APIError.fileRead("待上传文件提前结束（剩余 \(cursor.remaining) 字节）")
                }
                let left = cursor.remaining - chunk.count
                withLock {
                    if left <= 0 {
                        fileCursor?.handle.closeFile()
                        fileCursor = nil
                    } else {
                        fileCursor?.remaining = left
                    }
                }
                return setCurrent(chunk)
            } catch {
                fail(with: error)
                return false
            }
        }

        guard let segment = withLock({ remainingSegments.isEmpty ? nil : remainingSegments.removeFirst() }) else {
            return false
        }

        switch segment {
        case .bytes(let data):
            return setCurrent(data)
        case .file(let url):
            do {
                let size = try Self.fileSize(of: url)
                let handle = try FileHandle(forReadingFrom: url)
                withLock { fileCursor = FileCursor(handle: handle, remaining: size) }
                if size == 0 {
                    withLock {
                        fileCursor?.handle.closeFile()
                        fileCursor = nil
                    }
                }
                // 空文件没有块可读，直接推进到下一段（段尾 `\r\n`）。
                return loadNextSegment()
            } catch {
                fail(with: error)
                return false
            }
        }
    }

    private func setCurrent(_ data: Data) -> Bool {
        current = data
        currentOffset = 0
        withLock {
            largestProducedChunk = max(largestProducedChunk, data.count)
        }
        return true
    }

    private func fail(with error: Error) {
        withLock {
            storedError = error
            storedStatus = .error
        }
    }

    static func fileSize(of url: URL) throws -> Int {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard let size = attributes[.size] as? NSNumber else {
                throw APIError.fileRead("读不到文件大小：\(url.lastPathComponent)")
            }
            return size.intValue
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.fileRead("读取待上传文件失败（\(url.lastPathComponent)）：\(error.localizedDescription)")
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
