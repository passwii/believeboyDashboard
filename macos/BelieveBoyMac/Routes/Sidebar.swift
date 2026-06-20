// Sidebar SwiftUI host. Mirrors `frontend/components/dashboard/sidebar-icon-rail.tsx`.

import SwiftUI

struct Sidebar: View {
    @Binding var selection: SidebarGroup.ID?
    @Environment(AppSession.self) private var session

    var body: some View {
        List(selection: $selection) {
            ForEach(SidebarGroup.visible(for: session.currentUser?.role)) { group in
                Label {
                    Text(group.title)
                        .font(.caption)
                        .lineLimit(2)
                } icon: {
                    Image(systemName: group.systemImage)
                        .foregroundStyle(.tint)
                }
                .tag(group.id as SidebarGroup.ID?)
                .help(group.title)
            }
        }
        .listStyle(.sidebar)
    }
}

struct GroupList: View {
    let group: SidebarGroup
    @Binding var selection: SidebarItem?
    @Environment(AppSession.self) private var session

    var body: some View {
        List(selection: $selection) {
            Section(group.title) {
                ForEach(group.itemsVisible(for: session.currentUser?.role)) { item in
                    Label {
                        Text(item.title)
                    } icon: {
                        Image(systemName: item.systemImage)
                    }
                    .tag(item as SidebarItem?)
                }
            }
        }
        .listStyle(.sidebar)
    }
}