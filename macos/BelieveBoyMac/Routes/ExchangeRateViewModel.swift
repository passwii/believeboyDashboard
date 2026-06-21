// ExchangeRateViewModel + Edit Sheet — model layer + create/update UI.
//
// Splitting the view model and the edit sheet into their own file keeps
// `ExchangeRateView.swift` readable: that file is the page composition
// (toolbar + list + pagination + sheet dispatch), this file owns the
// data loading and the form UI.
//
// View-model state machine:
//   .idle → .loading → .loaded(items, pagination)
//                  ↘ .empty
//                  ↘ .error(message)

import SwiftUI
import UniformTypeIdentifiers

// MARK: - View model

@MainActor
@Observable
final class ExchangeRateViewModel {
    enum State: Equatable {
        case idle
        case loading
        case loaded
        case empty
        case error(String)
    }

    // Paged list
    private(set) var state: State = .idle
    private(set) var items: [ExchangeRateItem] = []
    private(set) var total: Int = 0
    private(set) var page: Int = 1
    private(set) var totalPages: Int = 1
    let pageSize: Int = 12

    // Filters
    var filterCurrency: String?
    var filterYear: String?
    var filterMonth: String?

    // Cached dropdown options (currencies / years) — populated from the
    // `/options` endpoint so the UI matches the backend's taxonomy.
    private(set) var currencyOptions: [FilterOption] = []
    private(set) var yearOptions: [FilterOption] = []

    private let api: APIClient
    private let toasts: ToastCenter?

    init(api: APIClient = .shared, toasts: ToastCenter? = nil) {
        self.api = api
        self.toasts = toasts
    }

    var canGoPrev: Bool { page > 1 }
    var canGoNext: Bool { page < totalPages }

    // MARK: - Public actions

    func load() async {
        if currencyOptions.isEmpty { await loadOptions() }
        await fetch(replace: true)
    }

    func reload() async {
        if page != 1 { page = 1 }
        await fetch(replace: true)
    }

    func prevPage() async {
        guard canGoPrev else { return }
        page -= 1
        await fetch(replace: true)
    }

    func nextPage() async {
        guard canGoNext else { return }
        page += 1
        await fetch(replace: true)
    }

    func create(payload: ExchangeRateCreatePayload, onSuccess: @MainActor () -> Void) async {
        do {
            _ = try await api.post(
                path: "/api/v1/exchange-rates",
                body: payload
            ) as ExchangeRateItem
            onSuccess()
            await load()
        } catch APIError.validation(let msg) {
            toasts?.warning("保存失败", detail: msg)
        } catch APIError.unauthorized {
            // 401 is handled by AppSession.bootstrap elsewhere; surface
            // a single info toast so the user knows something happened.
            toasts?.info("会话已过期", detail: "请重新登录")
        } catch let error as APIError {
            toasts?.error("网络异常，请重试", detail: error.errorDescription)
        } catch {
            toasts?.error("未知错误", detail: error.localizedDescription)
        }
    }

    func update(id: Int, payload: ExchangeRateUpdatePayload, onSuccess: @MainActor () -> Void) async {
        do {
            _ = try await api.put(
                path: "/api/v1/exchange-rates/\(id)",
                body: payload
            ) as ExchangeRateItem
            onSuccess()
            await fetch(replace: true)
        } catch APIError.validation(let msg) {
            toasts?.warning("保存失败", detail: msg)
        } catch APIError.unauthorized {
            toasts?.info("会话已过期", detail: "请重新登录")
        } catch let error as APIError {
            toasts?.error("网络异常，请重试", detail: error.errorDescription)
        } catch {
            toasts?.error("未知错误", detail: error.localizedDescription)
        }
    }

    func delete(id: Int, onSuccess: @MainActor () -> Void) async {
        do {
            _ = try await api.delete(path: "/api/v1/exchange-rates/\(id)")
            onSuccess()
            await fetch(replace: true)
        } catch APIError.notFound {
            toasts?.warning("记录已不存在")
            await fetch(replace: true)
        } catch APIError.unauthorized {
            toasts?.info("会话已过期", detail: "请重新登录")
        } catch let error as APIError {
            toasts?.error("删除失败", detail: error.errorDescription)
        } catch {
            toasts?.error("未知错误", detail: error.localizedDescription)
        }
    }

    /// Multipart upload — returns the resulting image record so the
    /// edit sheet can append it to its `noteImages` array.
    func uploadImage(data: Data, filename: String, contentType: String) async throws -> ExchangeRateNoteImage {
        do {
            let response = try await api.uploadFile(
                path: "/api/v1/exchange-rates/upload-image",
                fileData: data,
                filename: filename,
                contentType: contentType
            ) as ExchangeRateUploadResponse
            return ExchangeRateNoteImage(
                id: response.id,
                url: response.url,
                thumbnailUrl: response.thumbnailUrl,
                r2Key: response.r2Key,
                thumbnailKey: response.thumbnailKey,
                filename: response.filename,
                contentType: response.contentType,
                size: response.size,
                uploadedAt: response.uploadedAt
            )
        } catch let error as APIError {
            toasts?.error("上传失败", detail: error.errorDescription)
            throw error
        } catch {
            toasts?.error("上传失败", detail: error.localizedDescription)
            throw error
        }
    }

    // MARK: - Private fetch

    private func loadOptions() async {
        // Best-effort: if `/options` 404s or errors we still render the
        // table; just leave the dropdowns empty so the user can fall back
        // to typing / non-filtered browsing.
        struct OptionsResponse: Decodable {
            struct Option: Decodable { let value: String; let label: String }
            let currencies: [Option]
            let years: [Option]
            let months: [Option]
        }
        do {
            let resp = try await api.get(
                path: "/api/v1/exchange-rates/options"
            ) as OptionsResponse
            currencyOptions = resp.currencies.map { FilterOption(value: $0.value, label: $0.label) }
            yearOptions = resp.years.map { FilterOption(value: String($0.value), label: $0.label) }
        } catch {
            // ignore — fall back to no dropdown options
        }
    }

    private func fetch(replace: Bool) async {
        state = .loading
        var query: [URLQueryItem] = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "page_size", value: String(pageSize)),
        ]
        if let c = filterCurrency { query.append(URLQueryItem(name: "currency", value: c)) }
        if let y = filterYear, let m = filterMonth {
            let mm = String(format: "%02d", Int(m) ?? 0)
            query.append(URLQueryItem(name: "year_month", value: "\(y)-\(mm)"))
        }
        do {
            let response = try await api.get(
                path: "/api/v1/exchange-rates",
                query: query
            ) as ExchangeRateListResponse
            items = response.items
            total = response.total
            page = response.page
            totalPages = response.totalPages
            state = response.items.isEmpty ? .empty : .loaded
        } catch APIError.unauthorized {
            state = .error("会话已过期，请重新登录")
        } catch let error as APIError {
            state = .error(error.errorDescription ?? "网络异常")
            if case .transport = error {
                toasts?.error("网络异常，请重试", detail: error.errorDescription)
            } else if case .server = error {
                toasts?.error("服务器开小差了", detail: error.errorDescription)
            }
        } catch {
            state = .error(error.localizedDescription)
            toasts?.error("网络异常，请重试", detail: error.localizedDescription)
        }
    }
}

// MARK: - LoadingState bridge

extension ExchangeRateViewModel.State {
    /// Bridges the view-model state to the generic `PageScaffold` state.
    /// `.idle` is treated as `.loading` for the scaffold's purposes —
    /// the first paint after `.task` is in flight either way.
    var asLoadingState: LoadingState {
        switch self {
        case .idle, .loading: return .loading
        case .loaded:         return .loaded
        case .empty:          return .empty
        case .error(let msg): return .error(message: msg)
        }
    }
}

// MARK: - Edit sheet

enum ExchangeRateEditMode {
    case create
    case edit(ExchangeRateItem)

    var title: String {
        switch self {
        case .create: return "新增汇率"
        case .edit:   return "编辑汇率"
        }
    }

    var submitLabel: String {
        switch self {
        case .create: return "确认创建"
        case .edit:   return "保存修改"
        }
    }
}

/// Tagged payload so the view can dispatch to the right view-model
/// action without `Any`. `Encodable` lets us pass it through the closure
/// cleanly while still keeping the type narrow at the call site.
enum ExchangeRateSubmitPayload {
    case create(ExchangeRateCreatePayload)
    case update(ExchangeRateUpdatePayload)
}

struct ExchangeRateEditSheet: View {
    let mode: ExchangeRateEditMode
    var onSubmit: (ExchangeRateSubmitPayload) async -> Void
    var onUpload: (Data, String, String) async throws -> ExchangeRateNoteImage

    @Environment(\.dismiss) private var dismiss
    @Environment(ToastCenter.self) private var toasts

    @State private var currency: String = "USD"
    @State private var currencyName: String = ""
    @State private var year: Int = Calendar.current.component(.year, from: Date())
    @State private var month: Int = Calendar.current.component(.month, from: Date())
    @State private var rateText: String = ""
    @State private var description: String = ""
    @State private var noteImages: [ExchangeRateNoteImage] = []
    @State private var inlineError: String?
    @State private var isSubmitting = false
    @State private var isUploading = false
    @State private var hasInitialized = false
    @State private var showingImporter = false

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private static let currencies: [(code: String, name: String)] = [
        ("USD", "美元"), ("EUR", "欧元"), ("CNY", "人民币"),
        ("JPY", "日元"), ("GBP", "英镑"), ("HKD", "港币"),
        ("AUD", "澳元"), ("CAD", "加元"), ("KRW", "韩元"),
        ("SGD", "新加坡元"),
    ]

    private static let yearRange = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(mode.title).font(.title3).fontWeight(.semibold)
            form
            if let inlineError {
                Text(inlineError)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    submit()
                } label: {
                    if isSubmitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(mode.submitLabel)
                    }
                }
                .disabled(!isFormValid || isSubmitting)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear(perform: initializeOnce)
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: Self.allowedImageTypes,
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
        }
    }

    private static let allowedImageTypes: [UTType] = [.png, .jpeg, .gif, UTType("org.webmproject.webp") ?? .data]

    @ViewBuilder
    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                currencyField
                currencyNameField
            }
            HStack {
                yearField
                monthField
            }
            rateField
            descriptionField
            imagesField
        }
    }

    private var currencyField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("货币代码").font(.caption).foregroundStyle(.secondary)
            Menu {
                ForEach(Self.currencies, id: \.code) { item in
                    Button("\(item.code) - \(item.name)") {
                        currency = item.code
                        if currencyName.isEmpty { currencyName = item.name }
                    }
                }
            } label: {
                HStack {
                    Text(currency).fontWeight(.medium)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator, lineWidth: 0.5))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isEditing)
        }
    }

    private var currencyNameField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("货币名称").font(.caption).foregroundStyle(.secondary)
            TextField("如：美元", text: $currencyName)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var yearField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("年份").font(.caption).foregroundStyle(.secondary)
            Menu {
                ForEach(availableYears, id: \.self) { y in
                    Button("\(y)年") { year = y }
                }
            } label: {
                HStack {
                    Text("\(year)年").fontWeight(.medium)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator, lineWidth: 0.5))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isEditing)
        }
    }

    private var monthField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("月份").font(.caption).foregroundStyle(.secondary)
            Menu {
                ForEach(1...12, id: \.self) { m in
                    Button("\(m)月") { month = m }
                }
            } label: {
                HStack {
                    Text("\(month)月").fontWeight(.medium)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator, lineWidth: 0.5))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isEditing)
        }
    }

    private var rateField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("汇率值（1 单位外币对应多少人民币）").font(.caption).foregroundStyle(.secondary)
            TextField("如：7.234500", text: $rateText)
                .textFieldStyle(.roundedBorder)
                .monospacedDigit()
        }
    }

    private var descriptionField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("备注").font(.caption).foregroundStyle(.secondary)
            TextField("可选", text: $description)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var imagesField: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("备注图片").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    showingImporter = true
                } label: {
                    if isUploading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("上传图片", systemImage: "photo.badge.plus")
                    }
                }
                .disabled(isUploading)
            }
            if !noteImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(noteImages) { image in
                            imageThumb(image)
                        }
                    }
                }
            }
        }
    }

    private func imageThumb(_ image: ExchangeRateNoteImage) -> some View {
        VStack(spacing: 2) {
            AsyncImage(url: URL(string: image.thumbnailUrl ?? image.url)) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    Color.gray.opacity(0.15)
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            Button("删除") { removeImage(image.id) }
                .font(.caption2)
                .buttonStyle(.borderless)
                .foregroundStyle(.red)
        }
    }

    private var availableYears: [Int] {
        let now = Calendar.current.component(.year, from: Date())
        return Array((now - Self.yearRange)...(now + Self.yearRange))
    }

    // MARK: - Validation + submit

    private var isFormValid: Bool {
        guard !currency.isEmpty, !currencyName.isEmpty else { return false }
        guard let rate = Double(rateText), rate > 0 else { return false }
        return true
    }

    private func initializeOnce() {
        guard !hasInitialized else { return }
        hasInitialized = true
        if case .edit(let item) = mode {
            currency = item.currency
            currencyName = item.currencyName ?? ""
            if let y = item.year { year = y }
            if let m = item.month { month = m }
            rateText = String(format: "%.6f", item.rate)
            description = item.description ?? ""
            noteImages = item.noteImages
        }
    }

    private func submit() {
        guard !isSubmitting else { return }
        guard let rate = Double(rateText), rate > 0 else {
            inlineError = "汇率必须是正数"
            return
        }
        if currency.isEmpty || currencyName.isEmpty {
            inlineError = "请填写货币代码和名称"
            return
        }
        inlineError = nil
        isSubmitting = true
        Task {
            let payload: ExchangeRateSubmitPayload
            switch mode {
            case .create:
                payload = .create(ExchangeRateCreatePayload(
                    currency: currency,
                    currencyName: currencyName,
                    year: year,
                    month: month,
                    rate: rate,
                    description: description.isEmpty ? nil : description,
                    noteImages: noteImages
                ))
            case .edit:
                payload = .update(ExchangeRateUpdatePayload(
                    currency: nil, // currency not editable per backend
                    currencyName: currencyName,
                    year: nil,
                    month: nil,
                    rate: rate,
                    description: description.isEmpty ? nil : description,
                    noteImages: noteImages
                ))
            }
            await onSubmit(payload)
            isSubmitting = false
            dismiss()
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            // Sandbox off (per entitlements) — we can read directly.
            let needsAccess = url.startAccessingSecurityScopedResource()
            defer { if needsAccess { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                toasts.error("无法读取文件", detail: url.lastPathComponent)
                return
            }
            let mime = mimeType(for: url.pathExtension)
            Task {
                isUploading = true
                defer { isUploading = false }
                do {
                    let uploaded = try await onUpload(data, url.lastPathComponent, mime)
                    noteImages.append(uploaded)
                    toasts.success("图片已上传")
                } catch {
                    // toast already surfaced by onUpload
                }
            }
        case .failure(let error):
            toasts.error("选择文件失败", detail: error.localizedDescription)
        }
    }

    private func removeImage(_ id: String) {
        noteImages.removeAll { $0.id == id }
    }

    private func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp":        return "image/webp"
        case "gif":         return "image/gif"
        default:            return "application/octet-stream"
        }
    }
}