// PageTemplate — standard scaffold for BEL-147 stage 2 pages.
//
// Every page in the macOS client follows the same skeleton:
//
//   - Header strip with title + optional actions
//   - Body that switches on LoadingState: loading / empty / error / loaded
//   - Inline error message + retry hook
//
// Pages built on top of this scaffold get a consistent loading / empty /
// error UX for free, and the route table (`Routes/ContentView.swift` ->
// `RouteHost`) can stay narrow.
//
// Reusable for BEL-147-S3 (page fan-out) — once a page fills in
// `viewModel`, `title`, `state`, and `content`, the rest is shared.

import SwiftUI

/// What the page is currently showing. Drives the scaffold body.
enum LoadingState: Equatable {
    /// Initial / idle — show a centered large progress view.
    case loading
    /// Data loaded but the list is empty — show `ContentUnavailableView`.
    case empty
    /// Page failed to load — show an error empty state with a Retry button
    /// that calls `onRetry` on tap.
    case error(message: String)
    /// Data is ready — render `content`.
    case loaded

    static func == (lhs: LoadingState, rhs: LoadingState) -> Bool {
        switch (lhs, rhs) {
        case (.loading, .loading): return true
        case (.empty, .empty):     return true
        case (.loaded, .loaded):   return true
        case (.error(let a), .error(let b)): return a == b
        default: return false
        }
    }
}

/// Standard page scaffold.
///
/// Use the static `PageScaffold(title:state:onRetry:)` constructor when
/// you don't need a header strip; use the `PageScaffold { header } content:`
/// form when you need toolbar / filter chips / search bar / etc.
struct PageScaffold<Header: View, Content: View>: View {
    let title: String
    let state: LoadingState
    let onRetry: (() -> Void)?
    @ViewBuilder var header: () -> Header
    @ViewBuilder var content: () -> Content

    init(
        title: String,
        state: LoadingState,
        onRetry: (() -> Void)? = nil,
        @ViewBuilder header: @escaping () -> Header = { EmptyView() },
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.state = state
        self.onRetry = onRetry
        self.header = header
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            header()
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            Divider()
            body(for: state)
        }
        .navigationTitle(title)
    }

    @ViewBuilder
    private func body(for state: LoadingState) -> some View {
        switch state {
        case .loading:
            VStack {
                ProgressView()
                    .controlSize(.large)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "暂无数据",
                systemImage: "tray",
                description: Text("稍后再来或检查筛选条件")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            ContentUnavailableView {
                Label("加载失败", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                if let onRetry {
                    Button("重试") { onRetry() }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded:
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}