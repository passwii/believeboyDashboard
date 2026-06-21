// ExchangeRateView — paged list, edit sheet, image upload.
//
// BEL-147 stage 2: full end-to-end exercise of the macOS client against
// the existing FastAPI exchange-rate endpoints. Mirrors
// `frontend/app/dashboard/data-management/exchange-rate/page.tsx`.
//
// Endpoints used:
//   - GET    /api/v1/exchange-rates?page=&page_size=&currency=&year_month=
//   - POST   /api/v1/exchange-rates                       (admin)
//   - PUT    /api/v1/exchange-rates/{id}                  (admin)
//   - DELETE /api/v1/exchange-rates/{id}                  (admin)
//   - POST   /api/v1/exchange-rates/upload-image          (multipart, admin)
//
// UX:
//   - List is paginated; rows are read-only for non-admins.
//   - Admins see "新增 / 编辑 / 删除" actions; edit / create open a sheet.
//   - Image upload uses `FileImporter` (macOS 11+) → multipart POST →
//     appended to the form's `noteImages`.
//   - 4xx (validation / 409) stay inline in the sheet; transport / 5xx
//     surface as a `ToastCenter` banner.

import SwiftUI
import UniformTypeIdentifiers

// MARK: - View

struct ExchangeRateView: View {
    @Environment(AppSession.self) private var session
    @Environment(ToastCenter.self) private var toasts

    @State private var viewModel = ExchangeRateViewModel()
    @State private var sheet: SheetKind?

    enum SheetKind: Identifiable {
        case create
        case edit(ExchangeRateItem)
        case delete(ExchangeRateItem)

        var id: String {
            switch self {
            case .create: return "create"
            case .edit(let item): return "edit-\(item.id)"
            case .delete(let item): return "delete-\(item.id)"
            }
        }
    }

    private var isAdmin: Bool { session.currentUser?.isAdmin == true }

    var body: some View {
        PageScaffold(
            title: "汇率信息",
            state: viewModel.state.asLoadingState,
            onRetry: { Task { await viewModel.load() } }
        ) {
            toolbar
        } content: {
            VStack(spacing: 0) {
                listSection
                pagination
            }
        }
        .task { await viewModel.load() }
        .sheet(item: $sheet) { kind in
            switch kind {
            case .create:
                ExchangeRateEditSheet(
                    mode: .create,
                    onSubmit: { payload in
                        switch payload {
                        case .create(let body):
                            await viewModel.create(payload: body, onSuccess: { toasts.success("汇率已添加") })
                        case .update:
                            break // unreachable
                        }
                    },
                    onUpload: { data, name, type in
                        try await viewModel.uploadImage(data: data, filename: name, contentType: type)
                    }
                )
            case .edit(let item):
                ExchangeRateEditSheet(
                    mode: .edit(item),
                    onSubmit: { payload in
                        switch payload {
                        case .update(let body):
                            await viewModel.update(id: item.id, payload: body, onSuccess: { toasts.success("汇率已更新") })
                        case .create:
                            break // unreachable
                        }
                    },
                    onUpload: { data, name, type in
                        try await viewModel.uploadImage(data: data, filename: name, contentType: type)
                    }
                )
            case .delete(let item):
                DeleteConfirmationSheet(item: item, onConfirm: {
                    await viewModel.delete(id: item.id, onSuccess: { toasts.success("汇率记录已删除") })
                })
            }
        }
    }

    // MARK: - Toolbar (filters)

    private var toolbar: some View {
        HStack(spacing: 12) {
            FilterPicker(
                label: "货币",
                options: viewModel.currencyOptions,
                selection: $viewModel.filterCurrency
            )
            FilterPicker(
                label: "年份",
                options: viewModel.yearOptions,
                selection: $viewModel.filterYear
            )
            FilterPicker(
                label: "月份",
                options: monthOptions,
                selection: $viewModel.filterMonth
            )
            Button {
                Task { await viewModel.reload() }
            } label: {
                Label("重置", systemImage: "arrow.counterclockwise")
                    .labelStyle(.titleOnly)
            }
            .help("重置筛选并刷新")
            Spacer()
            if isAdmin {
                Button {
                    sheet = .create
                } label: {
                    Label("新增汇率", systemImage: "plus")
                }
                .keyboardShortcut("n", modifiers: [.command])
            }
        }
        .onChange(of: viewModel.filterCurrency) { _, _ in Task { await viewModel.reload() } }
        .onChange(of: viewModel.filterYear) { _, _ in Task { await viewModel.reload() } }
        .onChange(of: viewModel.filterMonth) { _, _ in Task { await viewModel.reload() } }
    }

    private var monthOptions: [FilterOption] {
        (1...12).map { FilterOption(value: String(format: "%02d", $0), label: "\($0)月") }
    }

    // MARK: - List + pagination

    @ViewBuilder
    private var listSection: some View {
        if viewModel.items.isEmpty {
            ContentUnavailableView(
                "暂无汇率数据",
                systemImage: "dollarsign.arrow.circlepath",
                description: Text(isAdmin ? "点击右上角按钮新增汇率" : "稍后再来或检查筛选条件")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                ForEach(viewModel.items) { item in
                    ExchangeRateRow(item: item, isAdmin: isAdmin) {
                        sheet = .edit(item)
                    } onDelete: {
                        sheet = .delete(item)
                    }
                }
            }
            .listStyle(.inset)
        }
    }

    private var pagination: some View {
        HStack {
            Button {
                Task { await viewModel.prevPage() }
            } label: {
                Label("上一页", systemImage: "chevron.left")
            }
            .disabled(!viewModel.canGoPrev)
            Spacer()
            Text("第 \(viewModel.page) / \(viewModel.totalPages) 页 · 共 \(viewModel.total) 条")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                Task { await viewModel.nextPage() }
            } label: {
                Label("下一页", systemImage: "chevron.right")
            }
            .disabled(!viewModel.canGoNext)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

// MARK: - Row

private struct ExchangeRateRow: View {
    let item: ExchangeRateItem
    let isAdmin: Bool
    var onEdit: () -> Void
    var onDelete: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            currencyBadge
            VStack(alignment: .leading, spacing: 2) {
                Text(item.currencyName ?? item.currency)
                    .font(.system(size: 13, weight: .medium))
                if let year = item.year, let month = item.month {
                    Text("\(year)年\(month)月")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(String(format: "%.6f", item.rate))
                    .font(.system(size: 16, weight: .semibold, design: .monospaced))
                Text(item.description ?? "—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if !item.noteImages.isEmpty {
                Image(systemName: "photo.on.rectangle.angled")
                    .foregroundStyle(.secondary)
                    .help("\(item.noteImages.count) 张备注图片")
            }
            if isAdmin {
                Menu {
                    Button("编辑", systemImage: "pencil", action: onEdit)
                    Button("删除", systemImage: "trash", role: .destructive, action: onDelete)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 16))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
        .padding(.vertical, 4)
    }

    private var currencyBadge: some View {
        let meta = ExchangeRateStyling.badgeMeta(for: item.currency)
        return HStack(spacing: 4) {
            Text(meta.symbol).font(.system(size: 14, weight: .bold))
            Text(item.currency)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(meta.background, in: Capsule())
        .overlay(Capsule().strokeBorder(meta.border, lineWidth: 1))
        .foregroundStyle(meta.foreground)
    }
}

// MARK: - Filter picker

struct FilterOption: Hashable, Identifiable {
    let value: String
    let label: String
    var id: String { value }
}

private struct FilterPicker: View {
    let label: String
    let options: [FilterOption]
    @Binding var selection: String?

    var body: some View {
        Menu {
            Button("全部\(label)") { selection = nil }
            Divider()
            ForEach(options) { option in
                Button(option.label) { selection = option.value }
            }
        } label: {
            HStack(spacing: 4) {
                Text(currentLabel)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.separator, lineWidth: 0.5))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var currentLabel: String {
        if let sel = selection, let match = options.first(where: { $0.value == sel }) {
            return match.label
        }
        return "全部\(label)"
    }
}

// MARK: - Delete confirmation sheet

private struct DeleteConfirmationSheet: View {
    let item: ExchangeRateItem
    var onConfirm: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var isDeleting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("确认删除").font(.title3).fontWeight(.semibold)
            Text("此操作不可恢复。")
                .font(.callout)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                row(label: "货币", value: "\(item.currency) (\(item.currencyName ?? "—"))")
                if let year = item.year, let month = item.month {
                    row(label: "时间", value: "\(year)年\(month)月")
                }
                row(label: "汇率", value: String(format: "%.6f", item.rate))
            }
            .padding(12)
            .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(role: .destructive) {
                    Task {
                        isDeleting = true
                        await onConfirm()
                        isDeleting = false
                        dismiss()
                    }
                } label: {
                    if isDeleting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("确认删除")
                    }
                }
                .disabled(isDeleting)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 360)
    }

    private func row(label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.medium)
        }
        .font(.callout)
    }
}

// MARK: - Currency badge styling

enum ExchangeRateStyling {
    struct BadgeMeta {
        let symbol: String
        let background: Color
        let foreground: Color
        let border: Color
    }

    static func badgeMeta(for currency: String) -> BadgeMeta {
        switch currency.uppercased() {
        case "USD":
            return BadgeMeta(
                symbol: "$",
                background: Color.green.opacity(0.12),
                foreground: Color.green,
                border: Color.green.opacity(0.35)
            )
        case "EUR":
            return BadgeMeta(
                symbol: "€",
                background: Color.blue.opacity(0.12),
                foreground: Color.blue,
                border: Color.blue.opacity(0.35)
            )
        default:
            return BadgeMeta(
                symbol: "¤",
                background: Color.gray.opacity(0.10),
                foreground: Color.primary,
                border: Color.gray.opacity(0.30)
            )
        }
    }
}

#Preview {
    ExchangeRateView()
        .environment(AppSession.preview)
        .environment(ToastCenter.shared)
        .frame(width: 1000, height: 700)
}