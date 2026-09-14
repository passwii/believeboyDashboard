import AppKit
import BelieveBoyKit
import BelieveBoyUI
import SwiftUI

/// 应用引导：建窗口、建菜单、装 SwiftUI 根视图。
///
/// 菜单不是装饰 —— 没有主菜单就没有 `⌘Q`（只能 kill 进程）与任何键盘快捷键。
/// SPM 可执行文件不会自带菜单栏，必须显式装配。
///
/// 窗口尺寸的**恢复**归这里：`NSWindow.frame` 是 AppKit 的东西，而「落盘坐标可能是
/// 屏幕外的旧值」这条规则在 Kit（`WindowFrame.clamped`，有单测）。本类只做翻译：
/// 取 `NSScreen` → 夹回可见屏幕 → `setFrame`，并在拖动 / 缩放结束后记回 store。
@MainActor
final class BelieveBoyAppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSWindowDelegate {
    private let model = AppModel()
    /// 外壳状态（选中项 / 侧栏折叠态 / 窗口尺寸）——两者都注入根视图，生命周期与会话
    /// 无关：登出只重置 `AppModel` 的会话态，窗口与导航位置留给下次登录。
    private let navigation = NavigationStore()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()

        // 尺寸口径（与 `WindowSizingProbe.Style` 同一份常量）：登录页紧凑，外壳宽敞。
        let initialStyle = ShellWindowStyle.forSession(isSignedIn: model.isSignedIn)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: initialStyle.contentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "BelieveBoy"
        window.contentMinSize = initialStyle.minimumContentSize
        window.delegate = self

        // 恢复上次的窗口尺寸。只在**登录态**取用：登录页本来就是窄栏居中的一间
        // 独立页面（PLAN §2.2），把一个宽窗口甩给它并不符合那个版式。
        let restoredFrame = model.isSignedIn ? restoredWindowFrame() : nil
        if let restoredFrame {
            window.setFrame(restoredFrame.nsRect, display: false)
        } else {
            window.center()
        }

        window.contentView = NSHostingView(
            rootView: RootView(
                model: model,
                navigation: navigation,
                adoptsRestoredWindowFrame: restoredFrame != nil
            )
        )
        window.makeKeyAndOrderFront(nil)
        self.window = window

        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - 窗口尺寸的恢复与记录

    /// 上次记录的 frame，已夹回可见屏幕：显示器拔掉 / 分辨率变了之后，落盘坐标可能完全
    /// 在屏幕外 —— 直接恢复会「启动了但看不见」，比不恢复更糟。
    private func restoredWindowFrame() -> WindowFrame? {
        guard let stored = navigation.windowFrame else { return nil }
        return stored.clamped(in: WindowFrame.visibleScreenFrames())
    }

    private func recordWindowFrame() {
        guard let window else { return }
        navigation.recordWindowFrame(WindowFrame(window.frame))
    }

    /// 程序化的 `setContentSize`（登录后自动放大）也会走到这里：`inLiveResize` 为假
    /// 时才记，否则拖动过程中会高频写盘。
    func windowDidResize(_ notification: Notification) {
        guard window?.inLiveResize != true else { return }
        recordWindowFrame()
    }

    /// 拖动结束的那一刻补记一次 —— 拖动中不写，结束时必须写。
    func windowDidEndLiveResize(_ notification: Notification) {
        recordWindowFrame()
    }

    func windowDidMove(_ notification: Notification) {
        recordWindowFrame()
    }

    // MARK: - 菜单

    private func installMainMenu() {
        let mainMenu = NSMenu()

        // 应用菜单：首个菜单的标题被系统忽略，但必须存在。
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "检查后端连接",
            action: #selector(checkConnection),
            keyEquivalent: "r"
        )
        // ⌘, —— 与工具栏的「偏好设置」是**同一个浮层**（后端地址 生产 / 本地）。
        // 不新增能力：那块 UI 自 S1 起就存在，这里只是给它补上 macOS 的惯例快捷键。
        appMenu.addItem(
            withTitle: "偏好设置…",
            action: #selector(openPreferences),
            keyEquivalent: ","
        )
        // `addItem(withTitle:action:keyEquivalent:)` 没有修饰键参数 —— 要 ⌘⇧L
        // 必须先生成 item 再设 `keyEquivalentModifierMask`（默认是仅 ⌘）。
        let signOutItem = NSMenuItem(
            title: "退出登录",
            action: #selector(signOut),
            keyEquivalent: "l"
        )
        signOutItem.keyEquivalentModifierMask = [.command, .shift]
        appMenu.addItem(signOutItem)
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "退出 BelieveBoy",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // 编辑菜单：SecureField / TextField 的 ⌘C / ⌘V / ⌘A 由系统菜单项驱动。
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        NSApplication.shared.mainMenu = mainMenu
    }

    @objc private func checkConnection() {
        Task { await model.checkConnection() }
    }

    @objc private func openPreferences() {
        // 命令式 set：偏好设置住在外壳（`ShellView` 的工具栏浮层），菜单只是第二个入口，
        // 两个入口共用一个 store 开关，不会各自维护一份展开态。
        navigation.setPreferencesPresented(true)
    }

    @objc private func signOut() {
        model.signOut()
    }

    /// 未登录时三个动作都没有意义：点「检查后端连接」只会印一个用户看不到的提示，
    /// 点「退出登录」则是在空登录态上重复清钥匙串，偏好设置里的后端地址也没有承载页。
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(checkConnection), #selector(signOut), #selector(openPreferences):
            return model.isSignedIn
        default:
            return true
        }
    }
}
