// APIClient — typed HTTP client for the existing FastAPI backend.
//
// BEL-147 stage 1: macOS native client that talks to the existing FastAPI
// backend via Next.js-style header-based session auth. The contract here
// mirrors what the web frontend does via `frontend/lib/backend-auth.ts`:
//
//   - Every request carries `X-API-Key` (shared with the web frontend).
//   - Authenticated requests carry `X-User-Id` / `X-User-Email` /
//     `X-Operator` / `X-User-Name` / `X-Is-Admin` / `X-Role-Type` /
//     `X-Session-Id`. Those come from the `SessionContext` stored in
//     Keychain on login; they are NOT JWT bearer tokens.
//   - There is no `/api/v1/auth/refresh` — sessions are managed in Redis
//     with a sliding window. The only thing we can do on 401 is give up,
//     clear the Keychain, and bounce back to the login window.
//   - All errors surface as `APIError` so views can branch on a small enum.
//
// Stage 0 shipped the scaffolding + a couple of call sites (auth/me,
// auth/login) but assumed JWT bearer tokens; stage 1 rewrites it to match
// the real header contract. Auth DTOs reflect the backend response shape
// (`id` / `name` / `email` / `operator_name_zh` / `is_admin` / `is_active` /
// `role_type` / `session_id`).

import Foundation

actor APIClient {
    static let shared = APIClient()

    /// Default backend base URL. Mirrors the frontend's
    /// `BACKEND_API_BASE_URL` env var; overridable via UserDefaults
    /// `believeBoy.baseURL` for staging toggles.
    static let defaultBaseURL = URL(string: "http://127.0.0.1:8100")!

    /// Shared API key. Matches `BACKEND_API_KEY` / `API_KEY` on the web side.
    /// Stored in Keychain so it can rotate without code changes; for now we
    /// hardcode the dev default since the web frontend also uses an env-injected
    /// key and the macOS client is v1 internal-only.
    static let defaultAPIKey = "dev-shared-secret"

    let baseURL: URL
    private let apiKey: String
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let keychain: KeychainStore

    init(baseURL: URL = APIClient.defaultBaseURL,
         apiKey: String = APIClient.defaultAPIKey,
         session: URLSession = .shared,
         keychain: KeychainStore = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
        self.keychain = keychain
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        dec.dateDecodingStrategy = .iso8601
        self.decoder = dec
        let enc = JSONEncoder()
        enc.keyEncodingStrategy = .convertToSnakeCase
        enc.dateEncodingStrategy = .iso8601
        self.encoder = enc
    }

    // MARK: - High-level calls

    func login(email: String, password: String) async throws -> AuthResponse {
        struct Body: Encodable {
            let email: String
            let password: String
        }
        let body = Body(email: email, password: password)
        return try await post(path: "/api/v1/auth/login", body: body, authenticated: false)
    }

    func me() async throws -> MeResponse {
        try await get(path: "/api/v1/auth/me")
    }

    // MARK: - Request helpers

    func get<T: Decodable>(path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(method: "GET", path: path, query: query, body: Optional<Empty>.none, authenticated: true)
    }

    func post<B: Encodable, T: Decodable>(path: String, body: B, authenticated: Bool = true) async throws -> T {
        try await perform(method: "POST", path: path, query: [], body: body, authenticated: authenticated)
    }

    func put<B: Encodable, T: Decodable>(path: String, body: B, authenticated: Bool = true) async throws -> T {
        try await perform(method: "PUT", path: path, query: [], body: body, authenticated: authenticated)
    }

    /// DELETE that returns `EmptyResponse` (the standard 204 body).
    @discardableResult
    func delete(path: String, authenticated: Bool = true) async throws -> EmptyResponse {
        try await perform(method: "DELETE", path: path, query: [], body: Optional<Empty>.none, authenticated: authenticated)
    }

    /// Multipart upload of a single file. The backend (e.g.
    /// `/api/v1/exchange-rates/upload-image`) accepts `multipart/form-data`
    /// with a single `file` field; we construct the body manually because
    /// Swift's URLSession does not provide a built-in multipart helper.
    func uploadFile<T: Decodable>(
        path: String,
        fileData: Data,
        filename: String,
        contentType: String,
        fieldName: String = "file"
    ) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.invalidURL
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        if let ctx = await keychain.loadSession() {
            applySessionContext(ctx, to: &request)
        }

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }
        switch http.statusCode {
        case 200..<300: return try decoder.decode(T.self, from: data)
        case 401:       throw APIError.unauthorized
        case 403:       throw APIError.forbidden
        case 404:       throw APIError.notFound
        case 422:       throw APIError.validation(stripped(data))
        case 500..<600: throw APIError.server(http.statusCode)
        default:        throw APIError.unexpected(http.statusCode)
        }
    }

    private struct Empty: Codable {}

    private func perform<B: Encodable, T: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: B?,
        authenticated: Bool
    ) async throws -> T {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body, !(body is Empty) {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        // X-API-Key is mandatory on every backend route (see
        // `backend/app/core/security.py::require_api_key`).
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        if authenticated {
            if let ctx = await keychain.loadSession() {
                applySessionContext(ctx, to: &request)
            }
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport
        }
        switch http.statusCode {
        case 200..<300:
            if T.self == EmptyResponse.self {
                return EmptyResponse() as! T
            }
            return try decoder.decode(T.self, from: data)
        case 401:
            // No refresh endpoint exists; the session is gone. Throw so the
            // AppSession layer can clear Keychain and bounce back to login.
            throw APIError.unauthorized
        case 403: throw APIError.forbidden
        case 404: throw APIError.notFound
        case 422: throw APIError.validation(stripped(data))
        case 429:
            // Backend rate-limits login; surface the friendly detail.
            throw APIError.rateLimited(stripped(data))
        case 500..<600: throw APIError.server(http.statusCode)
        default: throw APIError.unexpected(http.statusCode)
        }
    }

    /// Mirror of `frontend/lib/backend-auth.ts::applySessionContextHeaders`.
    /// We pass the same header set the Next.js proxy injects after the user
    /// logs in, so backend code paths (which read `X-User-Id` etc. directly
    /// — see `backend/app/api/deps.py::get_request_user_id`) keep working.
    private func applySessionContext(_ ctx: SessionContext, to request: inout URLRequest) {
        request.setValue(ctx.userId, forHTTPHeaderField: "X-User-Id")
        let emailEncoded = ctx.email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ctx.email
        request.setValue(emailEncoded, forHTTPHeaderField: "X-User-Email")
        if let name = ctx.userName {
            let nameEncoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
            request.setValue(nameEncoded, forHTTPHeaderField: "X-User-Name")
        }
        if let op = ctx.operatorName {
            let opEncoded = op.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? op
            request.setValue(opEncoded, forHTTPHeaderField: "X-Operator")
        }
        request.setValue(ctx.roleType, forHTTPHeaderField: "X-Role-Type")
        if ctx.isAdmin {
            request.setValue("true", forHTTPHeaderField: "X-Is-Admin")
        }
        request.setValue(ctx.sessionId, forHTTPHeaderField: "X-Session-Id")
    }

    private func stripped(_ data: Data) -> String {
        String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - DTOs
//
// These mirror `backend/app/api/v1/endpoints/auth.py::LoginResponse` and
// `MeResponse`. We keep them as separate types so the wire-shape stays
// honest to the backend (snake_case fields, snake-or-camel decoding via
// `keyDecodingStrategy = .convertFromSnakeCase`) and the in-app `SessionUser`
// stays a clean Swift model.

// Backend's `LoginResponse` (`/api/v1/auth/login`).
struct AuthResponse: Decodable {
    let id: String
    let name: String
    let email: String
    let operatorNameZh: String?
    let isAdmin: Bool
    let isActive: Bool
    let roleType: String
    let sessionId: String

    func toSessionContext() -> SessionContext {
        SessionContext(
            userId: id,
            email: email,
            userName: name,
            operatorName: operatorNameZh,
            roleType: roleType,
            isAdmin: isAdmin,
            sessionId: sessionId
        )
    }
}

// Backend's `MeResponse` (`/api/v1/auth/me`).
struct MeResponse: Decodable {
    let id: String
    let email: String
    let name: String
    let operatorNameZh: String?
    let isAdmin: Bool
    let isActive: Bool
    let roleType: String
    let passwordChangedAt: String?

    func toSessionUser() -> SessionUser {
        SessionUser(
            id: id,
            name: name,
            email: email,
            operatorNameZh: operatorNameZh,
            isAdmin: isAdmin,
            role: SessionUser.Role(rawValue: roleType) ?? .operator
        )
    }
}

struct EmptyResponse: Decodable {}

enum APIError: Error, LocalizedError {
    case invalidURL
    case transport
    case unauthorized
    case forbidden
    case notFound
    case validation(String)
    case rateLimited(String)
    case server(Int)
    case unexpected(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:        return "Invalid backend URL"
        case .transport:         return "Network error — please check your connection"
        case .unauthorized:      return "Session expired — please sign in again"
        case .forbidden:         return "You don't have permission"
        case .notFound:          return "Resource not found"
        case .validation(let s): return s.isEmpty ? "Validation failed" : s
        case .rateLimited(let s): return s.isEmpty ? "Too many attempts — please wait and try again" : s
        case .server(let code): return "Server error (\(code))"
        case .unexpected(let code): return "Unexpected error (\(code))"
        }
    }
}