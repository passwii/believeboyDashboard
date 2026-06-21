// Root view: drives the main NavigationSplitView and the auth-gated login window.
//
// BEL-147 stage 1 — main navigation wired to FastAPI auth. The view tree:
//
//   BelieveBoyMacApp
//     ├─ WindowGroup "main"  → ContentView → MainShell | WelcomeView
//     └─ Window "auth"       → LoginView
//
// `ContentView` is the bridge that opens/closes the auth window when
// `AppSession.phase` changes. Real route implementations still land in
// stages 2/3 per the BEL-147 evaluation; this stage ships the auth +
// sidebar skeleton only.

import SwiftUI

struct ContentView: View {
    @Environment(AppSession.self) private var session
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

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
        .onChange(of: session.phaseChangeToken) { _, _ in
            // React to any explicit sign-in / sign-out / bootstrap flip
            // by syncing the auth window's visibility.
            syncAuthWindow()
        }
        .onAppear {
            // Cover the cold-launch case where bootstrap() completes
            // before `.onChange` is wired up.
            syncAuthWindow()
        }
    }

    private func syncAuthWindow() {
        if session.isAuthenticated {
            dismissWindow(id: "auth")
        } else {
            openWindow(id: "auth")
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
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                AccountMenu()
            }
        }
        .overlay(alignment: .top) { ToastHost() }
    }
}

/// Route dispatch — maps `SidebarItem.id` (the route key) to the
/// concrete page view. BEL-147 stage 2 ships two real pages; the rest
/// of the 43 leaf items fall back to the stage-1 `RouteHost` placeholder
/// until stage 3 fans out the backlog.
struct RouteHost: View {
    let item: SidebarItem

    var body: some View {
        switch item.id {
        case "operations/site-navigation":
            SiteNavigationView()
        case "data-management/exchange-rate":
            ExchangeRateView()
        default:
            RoutePlaceholder(item: item)
        }
    }
}

/// Placeholder for routes that have not been implemented yet. Real pages
/// will replace these as we walk through the BEL-147 stage 3 backlog.
struct RoutePlaceholder: View {
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

/// Account menu in the toolbar — shows the current user, role, and a
/// Sign-out button. Used in stage 1 to verify role-based sidebar filtering
/// and to provide an in-app way to clear Keychain.
struct AccountMenu: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Menu {
            if let user = session.currentUser {
                Section(user.name) {
                    Text(user.email)
                    Text("Role: \(user.role.rawValue)")
                    if user.isAdmin { Text("Admin") }
                }
            }
            Divider()
            Button("Sign out", role: .destructive) {
                Task { await session.signOut() }
            }
        } label: {
            Label(session.currentUser?.name ?? "Account", systemImage: "person.crop.circle")
        }
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
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "macwindow")
                .font(.system(size: 48, weight: .ultraLight))
                .foregroundStyle(.tint)
            Text("BelieveBoy Mac")
                .font(.largeTitle)
            Text("Sign in via the auth window.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    ContentView()
        .environment(AppSession.preview)
        .environment(ToastCenter.shared)
}