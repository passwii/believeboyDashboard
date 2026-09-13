import AppKit
import BelieveBoyUI
import SwiftUI

/// 应用引导：建窗口、建菜单、装 SwiftUI 根视图。
///
/// 菜单不是装饰 —— 没有主菜单就没有 `⌘Q`（只能 kill 进程）与任何键盘快捷键。
/// SPM 可执行文件不会自带菜单栏，必须显式装配。
@MainActor
final class BelieveBoyAppDelegate: NSObject, NSApplicationDelegate {
    private let model = AppModel()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "BelieveBoy"
        window.minSize = NSSize(width: 640, height: 520)
        window.contentView = NSHostingView(rootView: RootView(model: model))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window

        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
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
}
