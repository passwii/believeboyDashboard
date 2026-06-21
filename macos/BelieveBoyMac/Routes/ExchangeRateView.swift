// ExchangeRateView — BEL-147 stage 2's data-table prototype.
//
// Wires the macOS shell to backend `/api/v1/exchange-rates`:
//   - GET /exchange-rates       → Table (currency, year_month, rate, description)
//   - GET /exchange-rates/{id}  → (not used in stage 2; row click could open it later)
//   - POST /exchange-rates/upload-image → image attachment via FileImporter
//
// The view model extends `PageViewModel<[ExchangeRateDTO]>` so it picks up
// the standard loading / error / empty states from `PageTemplate.swift`.
//
// Why DTO + mapping: `APIClient`'s default `JSONDecoder` uses
// `.convertFromSnakeCase`, but we still want a clean Swift struct for the
// view. The DTOs here mirror `backend/app/schemas/exchange_rate.py`.

import SwiftUI
import UniformTypeIdentifiers

struct ExchangeRateView: View {
    @State private var model = ExchangeRateModel()
    @State private var showImporter = false
    @State private var uploadError: String?
    @State private var uploadSuccess: String?
    @State private var editingItem: ExchangeRateDTO?

    var body: some View {
        VStack(spacing: 0) {
            toolbar
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            Divider()
            PageTemplate(state: model.state, retry: { await model.load() }) { rows in
                TableContent(rows: rows, onEdit: { editingItem = $0 })
            }
        }
        .navigationTitle("汇率信息")
        .task { await model.load() }
        .fileImporter(isPresented: $showImporter,
                      allowedContentTypes: [.image],
                      allowsMultipleSelection: false) { result in
            handleImport(result)
        }
        .sheet(item: $editingItem) { item in
            ExchangeRateEditSheet(item: item) { updated in
                Task { await model.applyLocalUpdate(updated) }
            }
        }
        .alert("Upload failed",
               isPresented: Binding(get: { uploadError != nil },
                                    set: { if !$0 { uploadError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(uploadError ?? "")
        }
        .alert("Uploaded",
               isPresented: Binding(get: { uploadSuccess != nil },
                                    set: { if !$0 { uploadSuccess = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(uploadSuccess ?? "")
        }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Text("\(model.totalCount) records")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Picker("Currency", selection: $model.currencyFilter) {
                Text("All").tag("")
                ForEach(model.currencies, id: \.self) { option in
                    Text(option.label).tag(option.value.description)
                }
            }
            .frame(width: 180)
            Button {
                showImporter = true
            } label: {
                Label("Upload image", systemImage: "arrow.up.doc")
            }
            Button {
                Task { await model.load() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: [.command])
        }
        .onChange(of: model.currencyFilter) { _, _ in
            Task { await model.load() }
        }
    }

    private func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            Task { await model.uploadImage(from: url,
                                           onError: { uploadError = $0 },
                                           onSuccess: { uploadSuccess = $0 }) }
        case .failure(let error):
            uploadError = error.localizedDescription
        }
    }
}

@MainActor
@Observable
final class ExchangeRateModel: PageViewModel<[ExchangeRateDTO]> {
    var totalCount: Int = 0
    var currencies: [ExchangeRateOptionDTO] = []
    var currencyFilter: String = ""

    override func load() async {
        state = .loading
        var query: [URLQueryItem] = [
            URLQueryItem(name: "page", value: "1"),
            URLQueryItem(name: "page_size", value: "100"),
        ]
        if !currencyFilter.isEmpty {
            query.append(URLQueryItem(name: "currency", value: currencyFilter))
        }
        do {
            let response: ExchangeRateListDTO = try await APIClient.shared.get(
                path: "/api/v1/exchange-rates",
                query: query
            )
            totalCount = response.total
            if currencies.isEmpty {
                await refreshOptions()
            }
            state = response.items.isEmpty ? .empty : .loaded(response.items)
        } catch {
            state = .error(translate(catch: error))
        }
    }

    /// Light refresh after a local edit: mutate the in-memory list only;
    /// no need to re-hit the full list endpoint.
    func applyLocalUpdate(_ updated: ExchangeRateDTO) async {
        if case .loaded(var rows) = state {
            if let idx = rows.firstIndex(where: { $0.id == updated.id }) {
                rows[idx] = updated
            }
            state = .loaded(rows)
        }
    }

    func refreshOptions() async {
        do {
            let opts: ExchangeRateOptionsDTO = try await APIClient.shared.get(
                path: "/api/v1/exchange-rates/options"
            )
            currencies = opts.currencies
        } catch {
            // Options are a convenience for the picker; ignore failures.
        }
    }

    func uploadImage(from fileURL: URL,
                     onError: @escaping (String) -> Void,
                     onSuccess: @escaping (String) -> Void) async {
        let didStart = fileURL.startAccessingSecurityScopedResource()
        defer { if didStart { fileURL.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: fileURL) else {
            onError("Couldn't read the selected file.")
            return
        }
        let filename = fileURL.lastPathComponent
        let mime = mimeType(for: fileURL.pathExtension)
        let boundary = "----bb-mac-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        do {
            let response: ExchangeRateUploadDTO = try await APIClient.shared.upload(
                path: "/api/v1/exchange-rates/upload-image",
                multipartBody: body,
                boundary: boundary
            )
            onSuccess("Uploaded \(response.filename) (\(formatBytes(response.size)))")
        } catch {
            onError(translate(catch: error))
        }
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png":         return "image/png"
        case "webp":        return "image/webp"
        case "gif":         return "image/gif"
        default:            return "application/octet-stream"
        }
    }

    private func formatBytes(_ n: Int) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: Int64(n))
    }
}

struct TableContent: View {
    let rows: [ExchangeRateDTO]
    let onEdit: (ExchangeRateDTO) -> Void

    var body: some View {
        Table(rows) {
            TableColumn("Currency") { row in
                HStack(spacing: 6) {
                    Text(row.currency).font(.body.monospaced())
                    if let name = row.currencyName, !name.isEmpty {
                        Text(name).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .width(min: 80, ideal: 110)

            TableColumn("Year-Month") { row in
                Text(row.yearMonth).font(.body.monospaced())
            }
            .width(min: 90, ideal: 100)

            TableColumn("Rate") { row in
                Text(String(format: "%.4f", row.rate))
                    .font(.body.monospaced())
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .width(min: 90, ideal: 110)

            TableColumn("Description") { row in
                Text(row.description ?? "—")
                    .foregroundStyle(row.description == nil ? .tertiary : .primary)
                    .lineLimit(1)
            }

            TableColumn("Updated") { row in
                Text(formatDate(row.updatedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .width(min: 140, ideal: 170)

            TableColumn("") { row in
                Button("Edit") { onEdit(row) }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            .width(50)
        }
    }

    private func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) {
            let display = DateFormatter()
            display.dateStyle = .short
            display.timeStyle = .short
            return display.string(from: d)
        }
        return iso
    }
}

struct ExchangeRateEditSheet: View {
    let item: ExchangeRateDTO
    let onSave: (ExchangeRateDTO) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var description: String
    @State private var rate: String

    init(item: ExchangeRateDTO, onSave: @escaping (ExchangeRateDTO) -> Void) {
        self.item = item
        self.onSave = onSave
        self._description = State(initialValue: item.description ?? "")
        self._rate = State(initialValue: String(item.rate))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(item.currency).font(.headline.monospaced())
                Text(item.yearMonth).font(.callout).foregroundStyle(.secondary)
            }
            Form {
                TextField("Rate", text: $rate)
                TextField("Description", text: $description, axis: .vertical)
                    .lineLimit(3...6)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    var updated = item
                    updated.description = description.isEmpty ? nil : description
                    if let r = Double(rate) { updated.rate = r }
                    onSave(updated)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 420)
    }
}

// MARK: - DTOs
//
// Wire-shape mirror of `backend/app/schemas/exchange_rate.py`. Field names
// are converted from snake_case to camelCase by `APIClient`'s decoder
// (`keyDecodingStrategy = .convertFromSnakeCase`).

struct ExchangeRateDTO: Identifiable, Hashable, Codable {
    var id: Int
    let currency: String
    let currencyName: String?
    let yearMonth: String
    var rate: Double
    var description: String?
    let noteImages: [ExchangeRateNoteImageDTO]
    let createdAt: String
    let updatedAt: String
}

struct ExchangeRateNoteImageDTO: Identifiable, Hashable, Codable {
    let id: String
    let url: String
    let thumbnailUrl: String?
    let filename: String
    let contentType: String
    let size: Int
    let uploadedAt: String
}

struct ExchangeRateListDTO: Decodable {
    let items: [ExchangeRateDTO]
    let total: Int
    let page: Int
    let pageSize: Int
}

struct ExchangeRateOptionDTO: Hashable, Decodable {
    let value: StringOrInt
    let label: String

    enum StringOrInt: Hashable, Decodable {
        case string(String)
        case int(Int)
        case bool(Bool)

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { self = .string(s); return }
            if let i = try? c.decode(Int.self) { self = .int(i); return }
            if let b = try? c.decode(Bool.self) { self = .bool(b); return }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Expected string|int|bool")
        }
        var description: String {
            switch self {
            case .string(let s): return s
            case .int(let i):    return String(i)
            case .bool(let b):   return String(b)
            }
        }
    }
}

struct ExchangeRateOptionsDTO: Decodable {
    let currencies: [ExchangeRateOptionDTO]
    let years: [ExchangeRateOptionDTO]
    let months: [ExchangeRateOptionDTO]
}

struct ExchangeRateUploadDTO: Decodable {
    let id: String
    let url: String
    let thumbnailUrl: String?
    let filename: String
    let size: Int
    let uploadedAt: String
}