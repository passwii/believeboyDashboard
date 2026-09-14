// swift-tools-version: 6.0

// 工具链约束（详见 PLAN.md §9）：
// - 本机 `xcode-select -p` 指向 Command Line Tools，完整 Xcode 27.0（build 27A266a，
//   即 27.0 RC；macOS 27.0 SDK / Swift 6.4）装在 /Volumes/Rock/Xcode.app
//   （/Applications/Xcode.app 只是转发壳，不含 toolchain，不能 xcode-select 过去）。
//   两条工具链能力不同：
//   * CLT：SwiftUI 属性包装器宏（@State / @Bindable / @Environment）不可用，
//     XCTest / swift-testing 亦不可用（缺 SwiftUIMacros / TestingMacros 插件）；
//   * 完整 Xcode：上述宏与测试框架均可用，打包链路（notarytool / codesign）亦就绪 ——
//     跑 `swift test` 需 `DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test`
//     （或先 `sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer`）；
//     外置卷 Rock 未挂载时完整工具链不可用。
// - 由此，视图层刻意不用属性包装器（@Observable + 显式 Binding），引导层用 AppKit
//   （Sources/BelieveBoyMac/main.swift）：这份代码在两条工具链下都能 `swift build`，
//   不必为「本机装没装 Xcode」分叉。
// - testTarget 只在 `swift test` 时编译，不影响 CLT 下的 `swift build`。
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
        .testTarget(
            name: "BelieveBoyTests",
            dependencies: ["BelieveBoyKit", "BelieveBoyUI"],
            // `Fixtures/` 是真实后端响应快照（AdAnalysis / AdData / Insight …），由测试用
            // `#filePath` 按源码树路径读取，不做 SPM resource。显式 exclude 掉，否则
            // SwiftPM 每次加载 manifest 都会打印「found N file(s) which are unhandled」
            // （S5.1/S5.2 起的既有 warning，本批顺手消掉）。
            exclude: ["Fixtures"]
        ),
    ]
)
