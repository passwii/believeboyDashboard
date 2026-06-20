// BelieveBoyMac — main entry point.
//
// BEL-147: macOS native client that talks to the existing FastAPI backend.
// All UI lives in `ContentView`; this file is the @main bootstrap.

import SwiftUI

@main
struct BelieveBoyMacApp: App {
    @State private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(session)
                .frame(minWidth: 1100, minHeight: 720)
        }
        .windowResizability(.contentSize)
        .windowToolbarStyle(.unified(showsTitle: true))
        .commands {
            SidebarCommands()
            ToolbarCommands()
            // Hook up global ⌘K command palette here in a later milestone.
        }

        // Login window shown when no token is in Keychain.
        Window("Sign in", id: "auth") {
            LoginView()
                .environment(session)
                .frame(minWidth: 420, minHeight: 520)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }
}
