// SiteNavigationView — BEL-147 stage 2's "two pages for the price of one":
// a 跨境平台书签导航 grid that opens external links in the user's
// default browser via NSWorkspace.
//
// Backend reality check: the backend has no `/api/v1/operations/site-navigation`
// endpoint. The web side (`frontend/app/dashboard/operations/site-navigation/page.tsx`)
// hardcodes the platform list. We mirror that same hardcoded list as the
// source of truth (see `BakedPlatforms` below) so the two UIs stay aligned
// without inventing a backend contract. Stage 3 may extract this into the
// backend; for stage 2 we deliberately keep parity with the web.

import AppKit
import SwiftUI

struct SiteNavigationView: View {
    @State private var model = SiteNavigationModel()

    var body: some View {
        PageTemplate(state: model.state, retry: { await model.load() }) { platforms in
            PlatformGrid(platforms: platforms, onOpen: { url in
                NSWorkspace.shared.open(url)
            })
        }
        .navigationTitle("跨境平台书签导航")
        .task { await model.load() }
    }
}

@MainActor
@Observable
final class SiteNavigationModel: PageViewModel<[Platform]> {
    override func load() async {
        state = .loading
        // No backend endpoint yet — render the baked list immediately. If
        // a real endpoint lands later, swap this for an APIClient call.
        state = BakedPlatforms.all.isEmpty ? .empty : .loaded(BakedPlatforms.all)
    }
}

struct Platform: Identifiable, Hashable {
    let id: String
    let name: String
    let href: String
    let region: String
    let category: String
    let tone: PlatformTone
    let group: Group

    enum Group: String { case platform, forum }

    enum PlatformTone {
        case orange, blue, green, slate, rose, fuchsia, sky, indigo

        var gradient: [Color] {
            switch self {
            case .orange:  return [Color(red: 1.0, green: 0.6, blue: 0.0).opacity(0.25),
                                  Color(red: 1.0, green: 0.72, blue: 0.30).opacity(0.10),
                                  Color.clear]
            case .blue:    return [Color(red: 0.0, green: 0.44, blue: 0.81).opacity(0.25),
                                  Color(red: 0.29, green: 0.63, blue: 0.94).opacity(0.10),
                                  Color.clear]
            case .green:   return [Color(red: 0.13, green: 0.77, blue: 0.37).opacity(0.20),
                                  Color(red: 0.53, green: 0.94, blue: 0.67).opacity(0.10),
                                  Color.clear]
            case .slate:   return [Color(red: 0.07, green: 0.09, blue: 0.15).opacity(0.25),
                                  Color(red: 0.42, green: 0.45, blue: 0.50).opacity(0.10),
                                  Color.clear]
            case .rose:    return [Color(red: 0.96, green: 0.25, blue: 0.37).opacity(0.25),
                                  Color(red: 0.98, green: 0.44, blue: 0.52).opacity(0.10),
                                  Color.clear]
            case .fuchsia: return [Color(red: 0.97, green: 0.45, blue: 0.65).opacity(0.20),
                                  Color(red: 0.99, green: 0.73, blue: 0.45).opacity(0.10),
                                  Color.clear]
            case .sky:     return [Color(red: 0.06, green: 0.09, blue: 0.16).opacity(0.25),
                                  Color(red: 0.20, green: 0.26, blue: 0.33).opacity(0.10),
                                  Color.clear]
            case .indigo:  return [Color(red: 0.20, green: 0.22, blue: 0.55).opacity(0.25),
                                  Color(red: 0.45, green: 0.50, blue: 0.85).opacity(0.10),
                                  Color.clear]
            }
        }
    }
}

struct PlatformGrid: View {
    let platforms: [Platform]
    let onOpen: (URL) -> Void

    private let columns = [GridItem(.adaptive(minimum: 220, maximum: 320), spacing: 16)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(platforms) { platform in
                    PlatformCard(platform: platform, onOpen: onOpen)
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct PlatformCard: View {
    let platform: Platform
    let onOpen: (URL) -> Void

    @State private var isHovered = false

    var body: some View {
        Button {
            if let url = URL(string: platform.href) { onOpen(url) }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(platform.name)
                        .font(.headline)
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Text(platform.region)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(platform.category)
                    .font(.caption2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.primary.opacity(0.08), in: Capsule())
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(.background)
                    LinearGradient(colors: platform.tone.gradient,
                                   startPoint: .topLeading,
                                   endPoint: .bottomTrailing)
                        .blendMode(.normal)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isHovered ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.08),
                                  lineWidth: isHovered ? 1.5 : 1)
            }
            .shadow(color: isHovered ? Color.accentColor.opacity(0.18) : Color.clear,
                    radius: 10, x: 0, y: 4)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

/// Source of truth: mirror of `frontend/app/dashboard/operations/site-navigation/page.tsx`.
///
/// Stage 2 keeps the list baked in (no backend endpoint exists). When the
/// backend exposes a list endpoint later, replace `SiteNavigationModel.load()`
/// with an `APIClient.shared.get(...)` call and delete this struct.
enum BakedPlatforms {
    static let all: [Platform] = [
        Platform(id: "amazon", name: "Amazon", href: "https://www.amazon.com",
                 region: "Global", category: "Marketplace",
                 tone: .orange, group: .platform),
        Platform(id: "walmart", name: "Walmart", href: "https://www.walmart.com",
                 region: "United States", category: "Marketplace",
                 tone: .blue, group: .platform),
        Platform(id: "amz123", name: "AMZ123", href: "https://www.amz123.com",
                 region: "China", category: "Media & Tools",
                 tone: .green, group: .forum),
        Platform(id: "shein", name: "SHEIN", href: "https://us.shein.com",
                 region: "Global", category: "Fashion",
                 tone: .slate, group: .platform),
        Platform(id: "temu", name: "TEMU", href: "https://www.temu.com",
                 region: "Global", category: "Marketplace",
                 tone: .rose, group: .platform),
        Platform(id: "etsy", name: "Etsy", href: "https://www.etsy.com",
                 region: "Global", category: "Niche",
                 tone: .fuchsia, group: .platform),
        Platform(id: "tiktok-shop", name: "TikTok Shop", href: "https://www.tiktok.com/shop",
                 region: "Global", category: "Social Commerce",
                 tone: .sky, group: .platform),
    ]
}
