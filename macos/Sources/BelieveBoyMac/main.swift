import AppKit
import SwiftUI

// 为什么不是 `@main struct …: App`：
//
// `@State` / `@Bindable` / `@Environment` 与 `App` 属性包装器在当前工具链下是
// **外部宏**，其实现在 `SwiftUIMacros` 插件里，只有完整 Xcode 才提供
// （Command Line Tools 只带 `libObservationMacros` / `libSwiftMacros`）。
// 本包要求「CLT-only 也能 build + run」，因此：
//   1. 引导层用 AppKit（`NSApplication` + `NSHostingView`）——顺带解决 SPM
//      可执行文件默认不是前台 App 的问题；
//   2. 视图层不使用属性包装器宏，改用 `@Observable`（CLT 可用）+ 显式 `Binding`。
//
// 装了 Xcode 之后可以切回 `@main App` + `@State`，视图文件本身无需重写
// （见 PLAN.md §9「工具链约束」）。

let application = NSApplication.shared
application.setActivationPolicy(.regular)

let delegate = BelieveBoyAppDelegate()
application.delegate = delegate
application.run()
