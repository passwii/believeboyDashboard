// ExchangeRate — DTOs mirroring `backend/app/schemas/exchange_rate.py`.
//
// APIClient sets `keyDecodingStrategy = .convertFromSnakeCase`, so the
// Swift camelCase property names here are decoded from the snake_case
// JSON fields the backend emits (e.g. `currencyName` ← `currency_name`).
// `year_month` is decoded into `yearMonth` here because it's a single
// field on the wire (the web frontend splits it into `year` / `month`).

import Foundation

/// Image attached to a note on an exchange rate row.
/// Mirrors `ExchangeRateNoteImage`.
struct ExchangeRateNoteImage: Codable, Hashable, Identifiable {
    let id: String
    let url: String
    let thumbnailUrl: String?
    let r2Key: String?
    let thumbnailKey: String?
    let filename: String
    let contentType: String
    let size: Int
    let uploadedAt: String
}

/// One exchange rate row.
/// Mirrors `ExchangeRateItem`. The backend uses `year_month` (e.g. "2026-04");
/// we keep it as a single string and provide computed `year` / `month`
/// accessors so the UI doesn't have to re-parse on every render.
struct ExchangeRateItem: Codable, Hashable, Identifiable {
    let id: Int
    let currency: String
    let currencyName: String?
    let yearMonth: String
    let rate: Double
    let description: String?
    let noteImages: [ExchangeRateNoteImage]
    let createdAt: String
    let updatedAt: String

    var year: Int? {
        Int(yearMonth.split(separator: "-").first ?? "")
    }

    var month: Int? {
        Int(yearMonth.split(separator: "-").last ?? "")
    }
}

/// Paged list response.
/// Mirrors `ExchangeRateListResponse`.
struct ExchangeRateListResponse: Codable {
    let items: [ExchangeRateItem]
    let total: Int
    let page: Int
    let pageSize: Int

    var totalPages: Int {
        max(1, Int((Double(total) / Double(pageSize)).rounded(.up)))
    }
}

/// Response from `POST /api/v1/exchange-rates/upload-image`.
/// Mirrors `ExchangeRateUploadResponse`.
struct ExchangeRateUploadResponse: Codable {
    let id: String
    let url: String
    let thumbnailUrl: String?
    let r2Key: String
    let thumbnailKey: String
    let filename: String
    let contentType: String
    let size: Int
    let uploadedAt: String
}

/// Payload for `POST /api/v1/exchange-rates`. Mirrors `ExchangeRateCreate`.
struct ExchangeRateCreatePayload: Encodable {
    let currency: String
    let currencyName: String?
    let year: Int
    let month: Int
    let rate: Double
    let description: String?
    let noteImages: [ExchangeRateNoteImage]
}

/// Payload for `PUT /api/v1/exchange-rates/{id}`. Mirrors `ExchangeRateUpdate`.
struct ExchangeRateUpdatePayload: Encodable {
    let currency: String?
    let currencyName: String?
    let year: Int?
    let month: Int?
    let rate: Double?
    let description: String?
    let noteImages: [ExchangeRateNoteImage]?
}