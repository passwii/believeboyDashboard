import AppKit
import BelieveBoyKit

/// `NSRect` ↔ `WindowFrame` 桥接 + 屏幕可见区域的取值。
///
/// 放在 UI 层：`WindowFrame` 自己（Kit）只懂数字，不懂 AppKit 的坐标空间与屏幕拓扑；
/// 「把落盘坐标夹回可见屏幕」的纯逻辑在 Kit（可离线测），这里只负责把 AppKit 的
/// `NSScreen` 与 `NSWindow` 翻译成那两个纯函数的输入输出。
extension WindowFrame {
    /// `NSWindow.frame` / `NSScreen.visibleFrame` 都是这种屏幕坐标（左下角原点）。
    public init(_ rect: NSRect) {
        self.init(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
    }

    public var nsRect: NSRect {
        NSRect(x: x, y: y, width: width, height: height)
    }
}

extension WindowFrame {
    /// 当前所有屏幕的**可见区域**（已扣掉菜单栏 / Dock）。
    ///
    /// 拿不到屏幕信息时返回空数组 —— `clamped(in:)` 对空输入原样返回，宁可不挪窗口也
    /// 不要把它丢到一个猜出来的位置上。
    @MainActor
    public static func visibleScreenFrames() -> [WindowFrame] {
        NSScreen.screens.map { WindowFrame($0.visibleFrame) }
    }
}
