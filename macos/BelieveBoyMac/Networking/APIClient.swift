// APIClient — typed HTTP client for the existing FastAPI backend.
//
// BEL-147: this is the macOS counterpart to the Next.js
// `/api/backend/[...path]` proxy. The contract:
//   - Reads JWT from Keychain via KeychainStore.
//   - Injects `Authorization: Bearer <token>` on every call.
//   - On 401, attempts one refresh via /api/v1/auth/refresh and retries.
//   - All errors surface as `APIError` so views can branch on a small enum.
//
// Stage 0 ships the scaffolding + a couple of call sites (auth/me,
// auth/login). Stage 1 fills in the rest.

import Foundation

actor APIClient {
    static let shared = APIClient()

    /// Default backend base URL. Mirrors the frontend's
    /// `BACKEND_API_BASE_URL` env var; overridable via UserDefaults
    /// `believeBoy.baseURL` for staging toggles.
    static let defaultBaseURL = URL(string: "http://127.0.0.1:8000")!

    let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL = APIClient.defaultBaseURL,
         session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
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

    func login(username: String, password: String) async throws -> AuthResponse {
        struct Body: Encodable { let username: String; password: String }
        let body = Body(username: username, password: password)
        return try await post(path: "/api/v1/auth/login", body: body, authenticated: false)
    }

    func me() async throws -> SessionUserDTO {
        try await get(path: "/api/v1/auth/me")
    }

    // MARK: - Request helpers

    func get<T: Decodable>(path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(method: "GET", path: path, query: query, body: Optional<Empty>.none, authenticated: true)
    }

    func post<B: Encodable, T: Decodable>(path: String, body: B, authenticated: Bool = true) async throws -> T {
        try await perform(method: "POST", path: path, query: [], body: body, authenticated: authenticated)
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
        if authenticated, let token = await KeychainStore.shared.loadAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
            // TODO(stage 1): attempt one refresh; if it fails, propagate.
            throw APIError.unauthorized
        case 403: throw APIError.forbidden
        case 404: throw APIError.notFound
        case 422: throw APIError.validation(stripped(data))
        case 500..<600: throw APIError.server(http.statusCode)
        default: throw APIError.unexpected(http.statusCode)
        }
    }

    private func stripped(_ data: Data) -> String {
        String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - DTOs (stage 0 placeholders; stage 1 should regenerate from OpenAPI)

struct EmptyResponse: Decodable {}

struct AuthResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let user: SessionUserDTO
}

struct SessionUserDTO: Decodable, Equatable {
    let id: String
    let name: String
    let email: String
    let role: String
}

enum APIError: Error, LocalizedError {
    case invalidURL
    case transport
    case unauthorized
    case forbidden
    case notFound
    case validation(String)
    case server(Int)
    case unexpected(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:      return "Invalid backend URL"
        case .transport:       return "Network error"
        case .unauthorized:    return "Please sign in again"
        case .forbidden:       return "You don't have permission"
        case .notFound:        return "Resource not found"
        case .validation(let s): return s.isEmpty ? "Validation failed" : s
        case .server(let code): return "Server error (\(code))"
        case .unexpected(let code): return "Unexpected error (\(code))"
        }
    }
}