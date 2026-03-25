# BelieveBoy Dashboard UI Upgrade Blueprint

## Summary

This project should keep the current frontend stack and upgrade the UI through a stronger design system, not through a library rewrite.

- Keep: `Next.js 14`, `React 18`, `Tailwind CSS v3`, `Radix UI`, `shadcn/ui`, `TanStack Table`, `Recharts`, `Framer Motion`
- Fix: token inconsistency, over-rounded components, scattered chart styling, page-by-page visual drift
- Govern the product as 6 page types instead of a single generic dashboard

## Project Page Types

### 1. Workbench Overview

Representative pages:

- `frontend/app/dashboard/page.tsx`

Characteristics:

- summary hero
- KPI row
- decision signals
- chart + task list + data table

### 2. Analysis Console

Representative pages:

- `frontend/app/dashboard/data-analysis/daily-analysis/page.tsx`
- `frontend/app/dashboard/data-analysis/ad-analysis/page.tsx`
- `frontend/app/dashboard/data-analysis/financial-data/page.tsx`
- `frontend/app/dashboard/data-analysis/inventory-analysis/page.tsx`
- `frontend/app/dashboard/data-analysis/inventory-replenishment/page.tsx`
- `frontend/app/dashboard/tools/research-analysis/page.tsx`

Characteristics:

- filters
- KPI cards
- charts
- detailed data table

### 3. Upload Pipeline

Representative pages:

- `frontend/app/dashboard/data-management/report-upload/page.tsx`
- report-generation pages under `data-reporting`

Characteristics:

- file upload
- recognition / validation
- processing state
- export result

### 4. Data Management Table

Representative pages:

- `frontend/app/dashboard/data-management/sku-cost/page.tsx`
- `frontend/app/dashboard/data-management/exchange-rate/page.tsx`
- `frontend/app/dashboard/system-management/account-management/page.tsx`
- `frontend/app/dashboard/system-management/logs/page.tsx`

Characteristics:

- high-density tables
- toolbar
- filters
- row actions
- dialogs / detail panels

### 5. Configuration Workspace

Representative pages:

- `frontend/app/dashboard/system-management/project-info/page.tsx`
- `frontend/app/dashboard/system-management/commission-overview/page.tsx`
- `frontend/app/dashboard/change-password/page.tsx`

Characteristics:

- settings forms
- state summaries
- risk notices

### 6. Navigation Hub

Representative pages:

- `frontend/app/dashboard/operations/site-navigation/page.tsx`
- `frontend/app/dashboard/operations/store-navigation/page.tsx`
- `frontend/app/dashboard/changelog/page.tsx`

Characteristics:

- categorized navigation
- card grid or list
- low-density scanning

## Main UI Problems

### 1. Radius system is out of control

The codebase currently mixes:

- `rounded-md`
- `rounded-lg`
- `rounded-xl`
- `rounded-2xl`
- `rounded-3xl`
- `rounded-full`
- arbitrary values like `rounded-[1.35rem]`

This makes the interface feel inconsistent and overly soft for a data-heavy enterprise dashboard.

### 2. Design direction exists, but implementation is scattered

The codebase already points toward:

- tonal surfaces
- low-noise layout
- editorial data hierarchy

But actual page code still contains:

- local one-off styles
- hard-coded chart colors
- inconsistent card and table shells
- too much reliance on per-page visual decisions

### 3. Charts have infrastructure but not a true system

`frontend/components/ui/chart.tsx` provides a base abstraction, but we still need:

- chart tokens
- unified tooltip / axis / grid / legend rules
- reusable chart cards
- consistent semantic chart colors

## Library Strategy

### Keep the current component stack

- Base interaction: `Radix UI`
- App component layer: `shadcn/ui`
- Styling: `Tailwind CSS v3`
- Charts: `Recharts`

Why:

- the stack is already integrated
- replacing it with Ant Design or MUI would create a large, low-value rewrite
- the real issue is system governance, not missing component packages

### Chart library decision

Use `Recharts` as the default chart system for now.

Use it for:

- line charts
- area charts
- bar charts
- composed charts
- KPI trend visuals

Only consider adding `ECharts` later for:

- heatmaps
- treemaps
- map-based charts
- more advanced linked interactions

## Design System Layers

### Layer 1. Foundation tokens

Unify:

- color
- radius
- surface hierarchy
- shadow
- stroke opacity
- spacing
- typography
- motion
- chart palettes

Suggested token groups:

- `--radius-xs`
- `--radius-sm`
- `--radius-md`
- `--radius-lg`
- `--radius-xl`
- `--surface-base`
- `--surface-subtle`
- `--surface-raised`
- `--surface-overlay`
- `--stroke-soft`
- `--stroke-strong`
- `--data-positive`
- `--data-warning`
- `--data-negative`
- `--data-neutral`

### Layer 2. Primitive components

Unify variants for:

- `Button`
- `Input`
- `Select`
- `Tabs`
- `Badge`
- `Dialog`
- `Popover`
- `Tooltip`
- `Table`
- `Card`
- `DatePicker`
- `ScrollArea`

### Layer 3. Composite components

Build or standardize:

- `PageHeader`
- `FilterBar`
- `SectionHeader`
- `MetricTile`
- `StatusChip`
- `TrendDelta`
- `InsightCallout`
- `ChartCard`
- `ChartToolbar`
- `DataTableShell`
- `UploadStatusPanel`
- `FormSectionCard`
- `EmptyState`

### Layer 4. Page shells

Build:

- `OverviewShell`
- `AnalysisShell`
- `ManagementTableShell`
- `UploadPipelineShell`
- `ConfigWorkspaceShell`
- `NavigationHubShell`

## Radius Policy

This needs a hard reset.

Recommended scale:

- `xs = 6px`
- `sm = 8px`
- `md = 10px`
- `lg = 12px`
- `xl = 16px`

Mapping:

- small controls: `8px`
- standard buttons / compact cards: `10px`
- cards / dialogs / tables: `12px`
- hero and major overview surfaces: `16px`
- `rounded-full` only for dots, avatars, tiny pills

Avoid by default:

- `rounded-2xl`
- `rounded-3xl`
- arbitrary rem-based radius values

## Color and Surface Strategy

Keep the existing direction centered on:

- strong primary blue
- secondary blue-gray
- success teal
- danger ruby
- soft neutral surfaces

Rules:

- primary is for CTA, active state, key emphasis
- success is for positive growth and healthy states
- danger is for destructive and risk signals
- use surface differences before adding borders
- avoid pure black text and heavy dirty shadows

## Chart Rules

Standardize around:

- weak grid lines
- low-contrast axis text
- unified tooltip shell
- limited high-saturation series count
- fixed semantics for positive / warning / negative trends

Preferred chart mapping:

- time trend: line / area
- comparison: grouped bar
- mix of spend vs output: composed chart
- composition: horizontal bars before pies
- risk distribution: ranked bars / heat-style strips

## Execution Plan

### Phase 1. Foundation

- update `frontend/app/globals.css`
- unify surface, radius, shadow, stroke, chart tokens
- refactor `Button`, `Input`, `Card`, `Badge`, `Table`, `Tabs`
- redesign sidebar and top header

### Phase 2. Shared shells

- build `PageHeader`
- build `FilterBar`
- build `MetricTile`
- build `ChartCard`
- build `DataTableShell`
- establish page shell patterns

### Phase 3. High-impact pages

Start with:

- dashboard overview
- daily analysis
- ad analysis
- financial analysis

### Phase 4. Upload and management pages

- report upload
- sku cost
- exchange rates
- shipment management
- account management

### Phase 5. Polish

- empty states
- loading states
- hover / focus / active
- responsive cleanup
- dark mode consistency
