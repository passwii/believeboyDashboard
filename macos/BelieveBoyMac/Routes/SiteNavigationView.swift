// SiteNavigationView — cross-border platform bookmark navigation.
//
// BEL-147 stage 2: this page is the lightest one in the sidebar — pure
// hardcoded list of cross-border platforms with external links. Clicking
// a card hands the URL off to `NSWorkspace.shared.open(...)`, which is
// the macOS-native equivalent of `<a target="_blank">` on web.
//
// Reference: `frontend/app/dashboard/operations/site-navigation/page.tsx`
// (mirror, not shared).
//
// No backend call — the data is static; this exercises the SwiftUI card
// layout, NavigationSplitView sizing, and `NSWorkspace` interaction.

import SwiftUI

/// One platform bookmark.
struct Platform: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let url: URL
    let region: String
    let category: String
    /// Drives the gradient on the card's accent layer (mirrors web tones).
    let tone: String
    let group: Group

    enum Group: String, Hashable {
        case platform
        case forum
    }
}

extension Platform {
    /// Hardcoded list — mirrors the web `page.tsx` array so the two clients
    /// stay in lock-step without sharing code.
    static let all: [Platform] = [
        Platform(
            name: "Amazon",
            url: URL(string: "https://www.amazon.com")!,
            region: "Global",
            category: "Marketplace",
            tone: "from-[#ff9900]/25 via-[#ffb84d]/10 to-transparent",
            group: .platform
        ),
        Platform(
            name: "Walmart",
            url: URL(string: "https://www.walmart.com")!,
            region: "United States",
            category: "Marketplace",
            tone: "from-[#0071ce]/25 via-[#4aa2ef]/10 to-transparent",
            group: .platform
        ),
        Platform(
            name: "AMZ123",
            url: URL(string: "https://www.amz123.com")!,
            region: "China",
            category: "Media & Tools",
            tone: "from-[#22c55e]/20 via-[#86efac]/10 to-transparent",
            group: .forum
        ),
        Platform(
            name: "SHEIN",
            url: URL(string: "https://us.shein.com")!,
            region: "Global",
            category: "Fashion",
            tone: "from-[#111827]/25 via-[#6b7280]/10 to-transparent",
            group: .platform
        ),
        Platform(
            name: "TEMU",
            url: URL(string: "https://www.temu.com")!,
            region: "Global",
            category: "Marketplace",
            tone: "from-[#f43f5e]/25 via-[#fb7185]/10 to-transparent",
            group: .platform
        ),
        Platform(
            name: "Etsy",
            url: URL(string: "https://www.etsy.com")!,
            region: "Global",
            category: "Niche",
            tone: "from-[#f97316]/20 via-[#fdba74]/10 to-transparent",
            group: .platform
        ),
        Platform(
            name: "TikTok Shop",
            url: URL(string: "https://www.tiktok.com/shop")!,
            region: "Global",
            category: "Social Commerce",
            tone: "from-[#0f172a]/25 via-[#334155]/10 to-transparent",
            group: .platform
        ),
    ]

    static var platforms: [Platform] { all.filter { $0.group == .platform } }
    static var forums: [Platform]    { all.filter { $0.group == .forum } }
}

struct SiteNavigationView: View {
    @Environment(ToastCenter.self) private var toasts

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                section(title: "平台", subtitle: "核心运营入口", items: Platform.platforms)
                section(title: "资讯论坛", subtitle: "行业信息与工具导航", items: Platform.forums)
            }
            .padding(20)
        }
        .navigationTitle("跨境平台书签导航")
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("运营导航 · 站点导航")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.tint)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.tint.opacity(0.10), in: Capsule())
                    Text("聚合主流跨境电商平台与运营入口，一键直达高频站点。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                statsGrid
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var statsGrid: some View {
        HStack(spacing: 12) {
            stat(label: "平台总数", value: "\(Platform.platforms.count)", icon: "globe")
            stat(label: "资讯论坛", value: "\(Platform.forums.count)", icon: "newspaper")
            stat(label: "平台类型", value: "平台/资讯", icon: "tag")
        }
    }

    private func stat(label: String, value: String, icon: String) -> some View {
        VStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(.tint)
            Text(value)
                .font(.system(size: 14, weight: .semibold))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(width: 80, height: 56)
        .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
    }

    // MARK: - Section + grid

    private func section(title: String, subtitle: String, items: [Platform]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .lastTextBaseline) {
                Text(title).font(.title3).fontWeight(.semibold)
                Spacer()
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 200, maximum: 260), spacing: 12)],
                spacing: 12
            ) {
                ForEach(items) { platform in
                    PlatformCard(platform: platform) { open(platform) }
                }
            }
        }
    }

    private func open(_ platform: Platform) {
        let opened = NSWorkspace.shared.open(platform.url)
        if !opened {
            toasts.error("无法打开链接", detail: platform.url.absoluteString)
        }
    }
}

/// One platform card. Mirrors the web card: gradient overlay, region pill,
/// category footer, hover lift. macOS 14 SwiftUI doesn't have web's
/// `target="_blank"`; we hand off to `NSWorkspace.open`.
private struct PlatformCard: View {
    let platform: Platform
    let onTap: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(platform.name)
                            .font(.headline)
                        HStack(spacing: 4) {
                            Image(systemName: "building.2")
                                .font(.system(size: 9))
                            Text(platform.region)
                                .font(.system(size: 11))
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.background.opacity(0.5), in: Capsule())
                        .overlay(Capsule().strokeBorder(.separator, lineWidth: 0.5))
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(6)
                        .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.separator, lineWidth: 0.5))
                }
                Spacer(minLength: 4)
                Text(platform.category)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Divider()
                HStack {
                    Text(platform.category)
                        .font(.system(size: 11))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.background.opacity(0.5), in: Capsule())
                        .overlay(Capsule().strokeBorder(.separator, lineWidth: 0.5))
                    Spacer()
                    Text("点击直达")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.tint)
                }
            }
            .padding(12)
            .frame(height: 140)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(isHovering ? Color.accentColor.opacity(0.45) : Color.gray.opacity(0.25), lineWidth: 1)
            )
            .shadow(color: .black.opacity(isHovering ? 0.12 : 0.04), radius: isHovering ? 8 : 2, y: isHovering ? 4 : 1)
            .scaleEffect(isHovering ? 1.02 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(platform.url.absoluteString)
    }
}

#Preview {
    SiteNavigationView()
        .environment(ToastCenter.shared)
        .frame(width: 900, height: 700)
}