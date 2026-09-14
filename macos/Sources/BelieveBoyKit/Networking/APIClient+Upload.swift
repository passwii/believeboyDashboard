import Foundation

/// multipart 上传。
///
/// 12 个后端端点吃 `UploadFile`（`ad_upload` / `ai_file_upload` / `category_research`
/// / `exchange_rates` / `inspections` / `page_render` / `platform_revenues` / `profile`
/// / `report_reconciliation` / `shipment_schedules` / `sku_info` / `uploads`），而
/// `backend/` 用的是 FastAPI 的 `Form` + `File`（如
/// `ad_upload.py: file: UploadFile = File(...), country: str = Form(default='US')`）。
/// 请求体必须是标准 `multipart/form-data`，字段名与端点签名一一对应。
///
/// 默认走 `.report` 档（60s）：文件传输比普通 GET 慢一个量级，Web 端代理对
/// `report-upload/commit` 也正是给 60s（`backend-proxy-timeout-policy.ts` 的
/// report 档），沿用同一张表避免两端行为割裂。
public extension APIClient {

    /// 上传并解码响应。
    @discardableResult
    func upload<T: Decodable & Sendable>(
        _ path: String,
        form: MultipartFormData,
        method: HTTPMethod = .post,
        query: [String: String] = [:],
        tier: RequestTier = .report,
        authenticated: Bool = true
    ) async throws -> T {
        let request = try multipartRequest(
            method: method,
            path: path,
            form: form,
            query: query,
            tier: tier,
            authenticated: authenticated
        )
        return try await send(request)
    }

    /// 上传并忽略响应体（只看状态码）。
    func uploadIgnoringResponse(
        _ path: String,
        form: MultipartFormData,
        method: HTTPMethod = .post,
        query: [String: String] = [:],
        tier: RequestTier = .report,
        authenticated: Bool = true
    ) async throws {
        let request = try multipartRequest(
            method: method,
            path: path,
            form: form,
            query: query,
            tier: tier,
            authenticated: authenticated
        )
        try await sendIgnoringResponse(request)
    }

    /// 构造 multipart 请求。
    ///
    /// 两个关键点：
    /// - `Content-Length` 显式写上：`contentLength()` 从文件系统元数据算出，不必读文件。
    ///   不写的话 URLSession 会退化成 chunked 传输，而部分网关 / 中间件对
    ///   chunked 上传体的处理并不一致。
    /// - 体是 `httpBodyStream`（自定义流），**不是** `httpBody`（`Data`）——
    ///   后者要求整个上传体先在内存里成型。
    func multipartRequest(
        method: HTTPMethod,
        path: String,
        form: MultipartFormData,
        query: [String: String],
        tier: RequestTier,
        authenticated: Bool
    ) throws -> URLRequest {
        var request = try makeRequest(
            method: method.rawValue,
            path: path,
            query: query,
            body: nil,
            tier: tier,
            authenticated: authenticated
        )
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(try form.contentLength()), forHTTPHeaderField: "Content-Length")
        request.httpBodyStream = form.makeBodyStream()
        return request
    }
}
