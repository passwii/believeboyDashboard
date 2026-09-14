import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

// 离屏渲染的共用脚手架：广告分析页（S5.1）与广告数据页（S5.2）的渲染用例都要「把真模块挂进
// 窗口 → 等状态机落地 → 取位图核对」。这些助手与**被测模块无关**（只跟 AppKit / XCTest 打交道），
// 放在这里一份，避免两个 suite 各抄一份之后判据悄悄分叉（例如「空态提示画出来了没有」这种
// 位图结构判据，改在一处就该两处同时生效）。

/// 常驻离屏宿主：**视图必须在等待期间一直活着** —— `NSHostingView` 一释放，视图的
/// `.task` 就被取消，加载永远到不了「已就绪」（S4 踩过的坑，PLAN §3 ③）。
/// `@MainActor`：AppKit 的布局 / 取位图都在主 actor 上，非隔离方法会被严格并发拒绝。
@MainActor
final class HostedView {
    private let window: NSWindow
    private let hosting: NSHostingView<AnyView>

    init(view: some View, size: NSSize) {
        hosting = NSHostingView(rootView: AnyView(view))
        hosting.frame = NSRect(origin: .zero, size: size)
        window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.layoutIfNeeded()
        hosting.layoutSubtreeIfNeeded()
    }

    func pump(_ seconds: TimeInterval = 0.2) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
        hosting.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
    }

    func bitmap() throws -> NSBitmapImageRep {
        hosting.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let bounds = hosting.bounds
        let rep = try XCTUnwrap(
            hosting.bitmapImageRepForCachingDisplay(in: bounds),
            "离屏渲染应能拿到位图"
        )
        hosting.cacheDisplay(in: bounds, to: rep)
        return rep
    }
}

/// 空态 / 警告提示（`NoticeRow(.warning)`）是否**真的被画到了位图上**。
///
/// 判据是该提示条的两件固定特征，二者都要满足：
/// ① 橙色提示底 —— 横向铺满内容区（`NoticeRow` 的 `Spacer` 把它撑宽）的橙色条带；
/// ② 条带里真的有文案 —— 近似中性色的字形像素（见 `isNoticeText`）。
///
/// 只查橙色不够（页面别处也可能出现暖色），所以加 ②；而 ② 不能拿「与页面底色对比」
/// 来判 —— 离屏宿主没有窗口背景，`cacheDisplay` 出来的底色是**透明**的。
///
/// 为什么不查辅助功能树：无头进程里 `NSHostingView.accessibilityChildren()` 返回空
/// （实测 `count = 0`），拿不到文本，只能退到位图结构。
@MainActor
func warningNoticeIsPainted(_ rep: NSBitmapImageRep) -> Bool {
    // 2× 屏下 1280×800 的窗口约 2560×1664 像素，隔 4 采样。
    let stepX = max(1, rep.pixelsWide / 640)
    let stepY = max(1, rep.pixelsHigh / 400)

    var minX = Int.max, maxX = Int.min, minY = Int.max, maxY = Int.min
    for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
        for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
            guard let color = rep.colorAt(x: x, y: y), isWarningOrange(color) else { continue }
            minX = min(minX, x)
            maxX = max(maxX, x)
            minY = min(minY, y)
            maxY = max(maxY, y)
        }
    }
    // 提示条要成「条」：横向铺开、且有高度（不是 1px 描边、也不是一个小图标）。
    guard minX <= maxX, minY <= maxY, maxX - minX > 300, maxY - minY > 20 else { return false }

    var textXs: [Int] = []
    for x in stride(from: minX, through: maxX, by: stepX) {
        for y in stride(from: minY, through: maxY, by: stepY) {
            guard let color = rep.colorAt(x: x, y: y) else { continue }
            if isNoticeText(color) {
                textXs.append(x)
            }
        }
    }
    guard let leftmost = textXs.min(), let rightmost = textXs.max() else { return false }
    return rightmost - leftmost > 100
}

/// 饱和橙：系统橙 `#FF9500`（浅色）/ `#FF9F0A`（深色）都命中，蓝色强调色与红色横幅都不命中。
@MainActor
private func isWarningOrange(_ color: NSColor) -> Bool {
    let red = color.redComponent
    let green = color.greenComponent
    let blue = color.blueComponent
    return red > 0.5 && red - blue > 0.25 && red >= green && green > blue
}

/// 提示条里的文案像素：近似中性色（浅色外观的黑字 / 深色外观的白字）。
///
/// 用「中性」而不是「与底色对比高」：离屏位图没有窗口背景（提示底的橙色是半透明、
/// `colorAt` 会把它的颜色解到饱和橙），所以底色对比量不出来；而橙色底与橙色图标
/// 天然高饱和，中性的字形像素只可能来自文案本身。
@MainActor
private func isNoticeText(_ color: NSColor) -> Bool {
    let channels = [color.redComponent, color.greenComponent, color.blueComponent]
    return (channels.max() ?? 0) - (channels.min() ?? 0) < 0.12
}

@MainActor
func opaqueSampleCount(_ rep: NSBitmapImageRep) -> Int {
    let stepX = max(1, rep.pixelsWide / 40)
    let stepY = max(1, rep.pixelsHigh / 40)
    var count = 0
    for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
        for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
            if let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.01 {
                count += 1
            }
        }
    }
    return count
}

/// 等状态机落地（最多 `timeout` 秒，超时即失败）。
///
/// `@MainActor`：判定闭包读的是 `@MainActor` store 的状态，闭包本身必须留在主 actor 上
/// （非隔离的全局函数会让严格并发把闭包当成「跨域发送的 `() -> Bool`」而报错）。
@MainActor
func waitUntil(
    timeout: TimeInterval = 5,
    _ condition: () -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    XCTFail("等待条件超时（\(timeout)s）")
}

/// 记录当前打桩日志长度，用来断言「之后没有新增请求」（不依赖全局日志从头干净）。
@MainActor
func logBaseline() -> Int { StubURLProtocol.log.count }

@MainActor
func loggedPaths(since baseline: Int) -> [String] {
    Array(StubURLProtocol.loggedPaths.dropFirst(baseline))
}

// MARK: - 测试卫生

/// 收起一组任务作用域并等它们的收尾落地。
///
/// 为什么需要：`NSHostingView` 一释放，视图的 `.task` 就取消，但**已经登记进
/// `ModuleTaskScope` 的非结构化任务不会跟着死** —— 残留的加载会跑到下一个用例的打桩日志里，
/// 把「本页零请求」这类断言变成随机失败（S5.1 实测踩到）。
@MainActor
func cancelScopes(_ scopes: [ModuleTaskScope]) async {
    for scope in scopes { scope.cancelAll() }
    try? await Task.sleep(nanoseconds: 30_000_000)
}
