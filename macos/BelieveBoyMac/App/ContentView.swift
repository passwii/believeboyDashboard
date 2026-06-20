// Root view: drives the main NavigationSplitView and the auth-gated login window.
//
// BEL-147 stage 1 — main navigation skeleton (placeholder pages). Real
// route implementations land in stages 2/3 per the BEL-147 evaluation.

import SwiftUI

struct ContentView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            if session.isAuthenticated {
                MainShell()
            } else {
                // The dedicated login window is opened by the App scene;
                // here we just present a friendly gate so the main window
                // does not flash a blank canvas.
                WelcomeView()
            }
        }
        .task {
            await session.bootstrap()
        }
    }
}

/// NavigationSplitView host: 7 top-level groups × 45 leaf items (BEL-147 §E).
/// The route table is defined in `Routes/RouteConfig.swift` (mirror of
/// `frontend/lib/sidebar-config.ts`); role-based filtering is handled
/// inside `getVisibleGroups(...)`.
struct MainShell: View {
    @Environment(AppSession.self) private var session
    @State private var selectedGroupID: SidebarGroup.ID?
    @State private var selectedItem: SidebarItem?

    var body: some View {
        NavigationSplitView {
            Sidebar(selection: $selectedGroupID)
                .navigationSplitViewColumnWidth(min: 68, ideal: 68, max: 96)
        } content: {
            if let groupID = selectedGroupID,
               let group = SidebarGroup.allGroups.first(where: { $0.id == groupID }) {
                GroupList(group: group, selection: $selectedItem)
                    .navigationSplitViewColumnWidth(min: 220, ideal: 260)
            } else {
                Text("Select a group")
                    .foregroundStyle(.secondary)
            }
        } detail: {
            if let item = selectedItem {
                RouteHost(item: item)
            } else {
                DashboardPlaceholder()
            }
        }
        .navigationTitle(selectedItem?.title ?? "BelieveBoy")
    }
}

/// Placeholder for routes that have not been implemented yet. Real pages
/// will replace these as we walk through the BEL-147 stage 3 backlog.
struct RouteHost: View {
    let item: SidebarItem

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: item.systemImage)
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(.tint)
            Text(item.title)
                .font(.title2)
            Text("This page is part of the macOS rewrite backlog.\nImplementation lands in stage 3.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// Dashboard placeholder shown when no leaf item is selected yet.
struct DashboardPlaceholder: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("运营总览与关键数据面板")
                .font(.largeTitle)
            Text("Pick a route from the sidebar to begin.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct WelcomeView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "macwindow")
                .font(.system(size: 48, weight: .ultraLight))
                .foregroundStyle(.tint)
            Text("BelieveBoy Mac")
                .font(.largeTitle)
            Text("Sign in via the auth window (⌘N or Window menu).")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            // Open the auth window if the user has no token yet.
            if !session.isAuthenticated {
                session.openAuthWindow()
            }
        }
    }
}

#Preview {
    ContentView()
        .environment(AppSession.preview)
}
