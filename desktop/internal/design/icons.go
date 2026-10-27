package design

import "github.com/egoist/mygo/ui"

func svgPath(path string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` + path + `</svg>`))
}

var (
	IconHome     = svgPath(`<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11h5v-6h3v6h5V9"/>`)
	IconProjects = svgPath(`<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M8 5V3.5h8V5M3.5 10h17M9 14h6"/>`)
	IconOps      = svgPath(`<path d="M4 19V9m5 10V5m5 14v-7m5 7V8"/><path d="M2.5 19.5h19"/>`)
	IconReports  = svgPath(`<path d="M6 3.5h9l3 3V20H6z"/><path d="M15 3.5V7h3M9 11h6M9 14h6M9 17h4"/>`)
	IconAI       = svgPath(`<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M9 3.5V7m6-3.5V7M9 12h.01M15 12h.01M9 16h6"/>`)
	IconSystem   = svgPath(`<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.8.9-1.9-2.1-2.1-1.9.9-1.8-.7-.7-2h-3l-.7 2-1.8.7-1.9-.9-2.1 2.1.9 1.9-.7 1.8-2 .7v3l2 .7.7 1.8-.9 1.9 2.1 2.1 1.9-.9 1.8.7.7 2h3l.7-2 1.8-.7 1.9.9 2.1-2.1-.9-1.9.7-1.8z"/>`)
	IconRefresh  = svgPath(`<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8.5A7 7 0 0 1 18.8 7L20 12M4 12l1.2 5A7 7 0 0 0 17.9 15.5"/>`)
	IconChevron  = svgPath(`<path d="m8 10 4 4 4-4"/>`)
	IconClose    = svgPath(`<path d="m6 6 12 12M18 6 6 18"/>`)
	IconPulse    = svgPath(`<path d="M2.5 12h4l2.3-6 4.1 12 2.4-6h6.2"/>`)
	IconBell     = svgPath(`<path d="M18 9a6 6 0 0 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9"/><path d="M10 20h4"/>`)
	IconAlert    = svgPath(`<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5m0 3h.01"/>`)
	IconUser     = svgPath(`<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>`)
	IconDatabase = svgPath(`<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>`)
)
