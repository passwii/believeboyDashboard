import AppKit
import BelieveBoyKit
import SwiftUI

/// 显式双向绑定（替代 `@Bindable`）。
///
/// 视图层不使用属性包装器宏（`@State` / `@Bindable` / `@Environment`）—— 它们的宏
/// 实现在仅完整 Xcode 提供的 `SwiftUIMacros` 插件里，而本包要求 CLT 下也能构建
/// （见 Package.swift 顶部与 PLAN.md §9）。`@Observable` 的 setter 会在赋值时
/// 通知观察者，因此手写 `Binding` 与属性包装器生成的绑定行为一致。
///
/// 放在 `AppModel` 的扩展上而不是各处私有方法：S2 起登录页与主界面都要绑定同一批
/// 字段，复制两份 `binding(for:)` 只会让两者各自漂移。
extension AppModel {
    func binding<T>(for keyPath: ReferenceWritableKeyPath<AppModel, T>) -> Binding<T> {
        Binding(
            get: { self[keyPath: keyPath] },
            set: { self[keyPath: keyPath] = $0 }
        )
    }
}

/// 应用标记（图标瓦片）。登录页与主界面共用，保证换页面时视觉基线不跳。
struct BrandMark: View {
    var size: CGFloat = 44

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [Color.accentColor, Color.accentColor.opacity(0.7)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .overlay(
                Image(systemName: "square.grid.2x2.fill")
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            )
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.18), radius: size * 0.07, y: size * 0.03)
            .accessibilityLabel("BelieveBoy")
    }
}

/// 主界面顶栏：图标 + 名称 + stage 徽标。
///
/// 登录页不用它 —— 那一页是居中的窄栏（见 `LoginView`），不长这样。
struct AppBrandHeader: View {
    let subtitle: String

    var body: some View {
        HStack(spacing: 10) {
            BrandMark(size: 30)
            Text("BelieveBoy")
                .font(.title3.weight(.semibold))
            Text(subtitle)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.quaternary, in: Capsule())
            Spacer()
        }
    }
}

/// 带标签的输入项（标签在上、字段在下）。
///
/// 用它而不是在字段旁塞一句 hint：hint 是「说明文字」，而登录表单的每一句说明都在
/// 稀释主操作（`LoginView` 的版式约束）。
struct LabeledField<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            content
        }
    }
}

/// 状态行（错误 / 提示）—— 图标 + 文案的浅色横幅。
///
/// 只承载**必须说**的信息（凭据为什么失效、请求为什么没发出去），不做常规说明文案。
struct NoticeRow: View {
    enum Kind {
        case failure
        case warning
        case success

        var symbol: String {
            switch self {
            case .failure: return "xmark.octagon.fill"
            case .warning: return "exclamationmark.triangle.fill"
            case .success: return "checkmark.seal.fill"
            }
        }

        var color: Color {
            switch self {
            case .failure: return .red
            case .warning: return .orange
            case .success: return .green
            }
        }
    }

    let kind: Kind
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: kind.symbol)
                .foregroundStyle(kind.color)
            Text(message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(kind.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// 窗口尺寸口径：登录页紧凑（贴近 macOS 登录窗口的观感），外壳宽敞（装得下三栏）。
///
/// 独立成一个公开类型而不是藏在探针里：进程引导（`BelieveBoyMac`）在**建窗口时**就要
/// 用同一份尺寸，两处各写一套数字必然漂移。尺寸常量同时与
/// `ShellPreferences.WindowFrame`（恢复用）对齐。
public enum ShellWindowStyle: Equatable {
    case compact
    case regular

    /// 按登录态取口径（登录页 / 外壳）。
    public static func forSession(isSignedIn: Bool) -> ShellWindowStyle {
        isSignedIn ? .regular : .compact
    }

    public var contentSize: NSSize {
        switch self {
        case .compact: return NSSize(width: 440, height: 540)
        case .regular: return NSSize(width: WindowFrame.Size.regular.width, height: WindowFrame.Size.regular.height)
        }
    }

    public var minimumContentSize: NSSize {
        switch self {
        case .compact: return NSSize(width: 420, height: 480)
        case .regular: return NSSize(width: WindowFrame.minimum.width, height: WindowFrame.minimum.height)
        }
    }
}

/// 按登录态调整承载窗口的尺寸。
///
/// 只在「紧凑 ↔ 宽敞」真正切换时动一次窗口 —— 每次重绘都 `setContentSize` 会把用户
/// 手动拉伸过的窗口弹回去。窗口被拉得比目标更宽时也不再缩（尊重用户的选择），
/// 折叠态（登录页）除外：那一页本来就窄，拉宽的窗口里只会多出一圈空白。
struct WindowSizingProbe: NSViewRepresentable {
    let style: ShellWindowStyle
    /// 启动时窗口已按**恢复的**尺寸就位 → 首次渲染不按登录态改尺寸。
    let skipsFirstApplication: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }

    func updateNSView(_ view: NSView, context: Context) {
        // `applied` 只在真正设过尺寸后才置位：首次 `updateNSView` 时 view 还没挂进
        // 窗口（`view.window == nil`），此时不该把这次机会用掉。
        guard context.coordinator.applied != style, let window = view.window else { return }
        // 恢复过的窗口尺寸优先于「按登录态设尺寸」：把这次机会标记为已用，
        // 但只补齐最小尺寸约束，不动用户上次的窗口大小。
        if context.coordinator.applied == nil, skipsFirstApplication {
            context.coordinator.applied = style
            window.contentMinSize = style.minimumContentSize
            return
        }
        guard style == .compact || window.frame.width < style.contentSize.width else {
            context.coordinator.applied = style
            return
        }
        context.coordinator.applied = style

        window.contentMinSize = style.minimumContentSize
        let previousHeight = window.frame.height
        window.setContentSize(style.contentSize)
        // `setContentSize` 以左下角为基准，直接改会让标题栏往上跳；把窗口原点下移
        // 同样的差值，保持顶部边不动。
        var frame = window.frame
        frame.origin.y -= frame.height - previousHeight
        window.setFrame(frame, display: true)
    }

    final class Coordinator {
        /// 已实际应用的样式；`nil` = 还没成功设过尺寸。
        var applied: ShellWindowStyle?
    }
}
