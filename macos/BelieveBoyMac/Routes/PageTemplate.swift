// PageTemplate — reusable View skeleton for BEL-147 stage 2 pages.
//
// Every leaf page in the macOS rewrite shares the same scaffolding:
//
//   1. A small `@Observable` view model that owns loading / error / data
//      state and exposes a single `load() async` method.
//   2. A `.task { await vm.load() }` modifier on the root view, so the
//      load runs as soon as the page appears AND cancels if it disappears.
//   3. A standard set of "view states":
//        - `.idle` / `.loading` -> centered ProgressView
//        - `.error(msg)` -> .alert(...) with the friendly APIError text
//        - `.empty` -> ContentUnavailableView (macOS 14+)
//        - `.loaded(data)` -> caller-supplied viewBuilder
//
// Stage 2 wires up two pages (SiteNavigationView, ExchangeRateView) on top
// of this; stage 3 will reuse it for the 45-page rollout. The template is
// intentionally tiny — it is NOT a router / store / dependency container.
// Page-specific state lives in the per-page view model; the template only
// owns the cross-cutting "loading | error | empty | loaded" presentation
// language.

import SwiftUI

/// Generic page state machine.
enum PageState<Element> {
    case idle
    case loading
    case empty
    case loaded(Element)
    case error(String)
}

/// The view-model protocol every page-specific view model conforms to.
///
/// `Element` is the page's primary data type (e.g. `[ExchangeRateItem]`).
/// The default `load()` does nothing — pages override it. State lives in
/// `state`; views observe it via `@Observable` semantics (Swift 5.9+).
@MainActor
@Observable
class PageViewModel<Element> {
    var state: PageState<Element> = .idle

    /// Override in subclasses. Default is a no-op so `#Preview` can use
    /// a default-initialised view model without firing any network call.
    func load() async {
        // Subclasses override.
    }

    /// Helper for catching the common `do { ... } catch let e as APIError`
    /// pattern and translating it into a `.error(...)` page state.
    func translate(catch error: Error) -> String {
        if let apiError = error as? APIError {
            return apiError.errorDescription ?? "Unknown error"
        }
        return error.localizedDescription
    }
}

/// The standard view layout. Pages do NOT need to subclass this; they
/// just supply a content builder for the `.loaded` branch.
struct PageTemplate<Element, Content: View>: View {
    let state: PageState<Element>
    let retry: () async -> Void
    @ViewBuilder let content: (Element) -> Content

    var body: some View {
        switch state {
        case .idle, .loading:
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No data yet",
                systemImage: "tray",
                description: Text("There is nothing to show for the current filters.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let element):
            content(element)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't load", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") {
                    Task { await retry() }
                }
                .controlSize(.large)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
