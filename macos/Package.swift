// swift-tools-version: 6.0

// 工具链说明（详见 PLAN.md §9；2026-09-13 复核更新）：
// - Xcode 27.0（27A266a）已安装在 /Volumes/Rock/Xcode.app（macOS 27.0 SDK / Swift 6.4）。
//   注意 /Applications/Xcode.app 只是 416K 跳转壳，不含 toolchain；且本机 xcode-select 仍指向
//   CommandLineTools，因此纯净 shell 下 `swift build` 走 CLT，完整工具链需显式指定：
//       export DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer
//   （或 sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer）
// - 本包在「仅 CLT」与「完整 Xcode」两种环境下都能 `swift build` 通过：
//   * 视图层用 @Observable + 显式 Binding、引导层用 AppKit（见 Sources/BelieveBoyMac/main.swift）
//     —— 这是仅 CLT 时期的定型，在完整 Xcode 下同样可编译，故保留不加区分；
//   * 本包暂无 testTarget。完整 Xcode 下 swift-testing 可用，可补 Tests/BelieveBoyKitTests/。
//
// 分三层：Kit（纯 Foundation 逻辑，可无 UI 验证）→ UI（SwiftUI 视图，可离屏渲染）
// → Mac（进程引导）。UI 独立成 target 的价值：视图可在无窗口环境下渲染/校验，
// 不必启动 GUI 进程。

import PackageDescription

let package = Package(
    name: "BelieveBoy",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "BelieveBoyMac", targets: ["BelieveBoyMac"]),
        .library(name: "BelieveBoyKit", targets: ["BelieveBoyKit"]),
        .library(name: "BelieveBoyUI", targets: ["BelieveBoyUI"]),
    ],
    targets: [
        .target(name: "BelieveBoyKit"),
        .target(name: "BelieveBoyUI", dependencies: ["BelieveBoyKit"]),
        .executableTarget(name: "BelieveBoyMac", dependencies: ["BelieveBoyUI"]),
    ]
)
