// swift-tools-version: 6.0

// 工具链约束（详见 PLAN.md §9）：
// - 本机只有 Command Line Tools，没有完整 Xcode，因此：
//   * SwiftUI 的属性包装器宏（@State / @Bindable / @Environment）不可用 —— 视图层
//     用 @Observable + 显式 Binding，引导层用 AppKit（见 Sources/BelieveBoyMac/main.swift）；
//   * XCTest / swift-testing 均不可用（缺 TestingMacros 插件）—— 本包不设 testTarget。
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
