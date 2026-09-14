import Foundation

/// 下载进度。
public struct DownloadProgress: Sendable, Equatable {
    /// 已写入磁盘的字节数。
    public let receivedBytes: Int64
    /// `Content-Length`（未知时为 `nil` —— 分块编码的响应没有它）。
    public let expectedBytes: Int64?

    public init(receivedBytes: Int64, expectedBytes: Int64?) {
        self.receivedBytes = receivedBytes
        self.expectedBytes = expectedBytes
    }

    /// 完成比例；`expectedBytes` 未知或为 0 时为 `nil`（调用方退化成不确定进度条）。
    public var fraction: Double? {
        guard let expectedBytes, expectedBytes > 0 else { return nil }
        return min(1, Double(receivedBytes) / Double(expectedBytes))
    }
}

/// 文件下载（`FileResponse`）。
///
/// 后端有 4 处 `FileResponse`（`jobs` / `monthly_reports` ×2 /`product_analysis_reports`
/// / `category_research`），其中月报与长任务结果可能很大。所以这条路径必须是
/// **边收边落盘**：`session.download(for:)` 虽然也是落盘，但拿不到「写到哪一步」、
/// 也没法在测试里逐块观察；这里用 `bytes(for:)` + `FileHandle` 每 64 KiB 写一次，
/// 内存占用与文件大小无关。
///
/// 落盘策略：先写同目录下的临时文件，成功后再原子替换目标文件。这样中断 / 失败
/// 不会留下「看起来下载好了、其实是半个文件」的坑 —— 对报表文件来说，半个 xlsx
/// 比没有文件更难排查。
public extension APIClient {

    /// 下载到 `destination`，返回最终路径（= `destination`）。
    ///
    /// - Parameters:
    ///   - tier: 默认 `.report`（60s）—— 文件传输比普通 GET 慢一个量级，用 5s/10s
    ///     档会把大文件下载变成「必然超时」。
    ///   - onProgress: 每写一块回调一次（在后台线程调用，回调本身要轻）。
    @discardableResult
    func download(
        _ path: String,
        to destination: URL,
        query: [String: String] = [:],
        tier: RequestTier = .report,
        authenticated: Bool = true,
        chunkSize: Int = 64 * 1024,
        onProgress: (@Sendable (DownloadProgress) -> Void)? = nil
    ) async throws -> URL {
        let request = try makeRequest(
            method: "GET",
            path: path,
            query: query,
            body: nil,
            tier: tier,
            authenticated: authenticated
        )
        let (bytes, response) = try await transportStream(request)
        let http = try httpResponse(response, data: Data())
        guard (200..<300).contains(http.statusCode) else {
            throw Self.statusError(http.statusCode, data: try await Self.collect(bytes, limit: 4096))
        }

        let directory = destination.deletingLastPathComponent()
        try makeDirectoryIfNeeded(directory)
        let tempURL = directory.appendingPathComponent(
            ".\(destination.lastPathComponent).partial-\(UUID().uuidString)"
        )
        guard FileManager.default.createFile(atPath: tempURL.path, contents: nil) else {
            throw APIError.fileWrite("无法创建临时文件：\(tempURL.lastPathComponent)")
        }

        let expected = http.expectedContentLength >= 0 ? http.expectedContentLength : nil
        var handle: FileHandle?
        var completed = false
        defer {
            try? handle?.close()
            if !completed {
                try? FileManager.default.removeItem(at: tempURL)
            }
        }

        do {
            let fileHandle = try FileHandle(forWritingTo: tempURL)
            handle = fileHandle
            var buffer = Data()
            buffer.reserveCapacity(max(chunkSize, 1))
            var received: Int64 = 0

            for try await byte in bytes {
                try Task.checkCancellation()
                buffer.append(byte)
                if buffer.count >= chunkSize {
                    try fileHandle.write(contentsOf: buffer)
                    received += Int64(buffer.count)
                    buffer.removeAll(keepingCapacity: true)
                    onProgress?(DownloadProgress(receivedBytes: received, expectedBytes: expected))
                }
            }
            if !buffer.isEmpty {
                try fileHandle.write(contentsOf: buffer)
                received += Int64(buffer.count)
                onProgress?(DownloadProgress(receivedBytes: received, expectedBytes: expected))
            }
            try fileHandle.close()
            handle = nil

            try replaceItem(at: destination, with: tempURL)
            completed = true
            return destination
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as APIError {
            throw error
        } catch let error as URLError {
            throw APIError.transport(Self.describe(error))
        } catch {
            throw APIError.fileWrite("写入 \(destination.lastPathComponent) 失败：\(error.localizedDescription)")
        }
    }

    // MARK: - 内部

    private func transportStream(
        _ request: URLRequest
    ) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do {
            return try await session.bytes(for: request)
        } catch let error as URLError {
            throw APIError.transport(Self.describe(error))
        } catch {
            throw APIError.transport(Self.describe(error))
        }
    }

    /// 目标已存在则原子替换，否则直接搬过去（两者都在同一目录，属同一卷）。
    private func replaceItem(at destination: URL, with tempURL: URL) throws {
        let manager = FileManager.default
        if manager.fileExists(atPath: destination.path) {
            _ = try manager.replaceItemAt(destination, withItemAt: tempURL)
        } else {
            try manager.moveItem(at: tempURL, to: destination)
        }
    }

    private func makeDirectoryIfNeeded(_ directory: URL) throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw APIError.fileWrite("无法创建目录 \(directory.path)：\(error.localizedDescription)")
        }
    }

    private static func collect(_ bytes: URLSession.AsyncBytes, limit: Int) async throws -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= limit { break }
            }
        } catch {
            return data
        }
        return data
    }
}
