// ToastCenter — global, app-wide toast notifications.
//
// BEL-147 stage 2 error handling: macOS 14 does not have a native
// `Banner` / `Toast` SwiftUI API, so we render a small list of floating
// banners at the top of the main window. Pages call `ToastCenter.shared`
// to surface network errors / 5xx / generic failures. 4xx validation
// errors stay inline next to the form input (handled per-page).
//
// Usage:
//
//   @Environment(ToastCenter.self) private var toasts
//   toasts.error("网络异常，请稍后重试")
//   toasts.warning("汇率即将过期")
//   toasts.success("保存成功")
//
// The `ToastHost` view is mounted once in `BelieveBoyMacApp` and observes
// the same singleton; banners auto-dismiss after `dismissAfter` seconds.

import SwiftUI

/// Severity drives the banner's color + SF Symbol.
enum ToastSeverity: String, Hashable {
    case info
    case success
    case warning
    case error

    var symbol: String {
        switch self {
        case .info:    return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error:   return "xmark.octagon.fill"
        }
    }

    var tint: Color {
        switch self {
        case .info:    return .accentColor
        case .success: return .green
        case .warning: return .orange
        case .error:   return .red
        }
    }
}

/// Single toast entry.
struct Toast: Identifiable, Equatable {
    let id: UUID
    let severity: ToastSeverity
    let title: String
    let detail: String?
    let dismissAfter: TimeInterval

    init(
        severity: ToastSeverity,
        title: String,
        detail: String? = nil,
        dismissAfter: TimeInterval = 3.0
    ) {
        self.id = UUID()
        self.severity = severity
        self.title = title
        self.detail = detail
        self.dismissAfter = dismissAfter
    }
}

/// Global toast queue. Inject into the SwiftUI environment so any view
/// can call `toasts.error(...)` without prop-drilling.
@Observable
@MainActor
final class ToastCenter {
    static let shared = ToastCenter()

    /// Most recently shown toasts (newest at the top). We cap to a small
    /// list so a flood of errors doesn't pile up over the toolbar.
    private(set) var toasts: [Toast] = []

    private init() {}

    func show(_ toast: Toast) {
        toasts.insert(toast, at: 0)
        if toasts.count > 5 {
            toasts.removeLast(toasts.count - 5)
        }
        // Schedule dismissal. SwiftUI's `task(id:)` on the banner view
        // is the canonical way; we keep this simple by letting the view
        // own the timer (see `ToastBanner`).
    }

    func dismiss(id: UUID) {
        toasts.removeAll { $0.id == id }
    }

    // MARK: - Convenience helpers (used by pages)

    func info(_ title: String, detail: String? = nil) {
        show(Toast(severity: .info, title: title, detail: detail))
    }

    func success(_ title: String, detail: String? = nil) {
        show(Toast(severity: .success, title: title, detail: detail))
    }

    func warning(_ title: String, detail: String? = nil) {
        show(Toast(severity: .warning, title: title, detail: detail))
    }

    func error(_ title: String, detail: String? = nil) {
        show(Toast(severity: .error, title: title, detail: detail))
    }
}

/// Backing view for one toast entry. Owns its own auto-dismiss timer so
/// the toast queue can stay passive.
struct ToastBanner: View {
    let toast: Toast
    var onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: toast.severity.symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(toast.severity.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title)
                    .font(.system(size: 13, weight: .semibold))
                if let detail = toast.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(toast.severity.tint.opacity(0.4), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .frame(maxWidth: 420)
        .task(id: toast.id) {
            try? await Task.sleep(nanoseconds: UInt64(toast.dismissAfter * 1_000_000_000))
            onDismiss()
        }
    }
}

/// Mount this view once near the top of the main window's hierarchy.
struct ToastHost: View {
    @Environment(ToastCenter.self) private var center

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.toasts) { toast in
                ToastBanner(toast: toast) {
                    center.dismiss(id: toast.id)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .animation(.easeInOut(duration: 0.2), value: center.toasts)
        .allowsHitTesting(!center.toasts.isEmpty)
    }
}