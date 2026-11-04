export default function FinanceLoading() {
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-[var(--warm-ledger-space-4)] text-[color:var(--warm-ledger-color-text)] [font-family:var(--warm-ledger-font-sans)]"
      data-warm-finance-loading="true"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        正在加载财务数据
      </span>
      <section
        className="overflow-hidden rounded-[var(--warm-ledger-radius-panel)] border border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] shadow-[var(--warm-ledger-highlight-rest)]"
        data-warm-finance-loading-panel="true"
        aria-hidden="true"
      >
        <div className="flex min-h-16 items-center justify-between gap-4 border-b border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-5 py-3">
          <div className="flex items-baseline gap-3">
            <span className="h-4 w-24 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
            <span className="h-3 w-14 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
          </div>
          <div className="flex gap-2">
            <span className="h-8 w-24 rounded-[var(--warm-ledger-radius-control)] bg-[var(--warm-ledger-color-raised)]" />
            <span className="h-8 w-20 rounded-[var(--warm-ledger-radius-control)] bg-[var(--warm-ledger-color-raised)]" />
          </div>
        </div>
        <div className="p-5">
          <div
            className="grid gap-3 border-b border-[color:var(--warm-ledger-color-hairline)] pb-3"
            style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}
          >
            {Array.from({ length: 6 }, (_, index) => (
              <span
                className="h-3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]"
                key={`header-${index}`}
              />
            ))}
          </div>
          {Array.from({ length: 7 }, (_, rowIndex) => (
            <div
              className="grid min-h-14 items-center gap-3 border-b border-[color:var(--warm-ledger-color-hairline)] last:border-b-0"
              key={`row-${rowIndex}`}
              style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}
            >
              {Array.from({ length: 6 }, (_, columnIndex) => (
                <span
                  className="h-3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]"
                  key={`cell-${rowIndex}-${columnIndex}`}
                  style={{ width: columnIndex === 0 ? '72%' : '58%' }}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-[color:var(--warm-ledger-color-hairline)] px-5 py-3">
          <span className="h-3 w-36 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
          <div className="flex gap-2">
            <span className="h-8 w-16 rounded-[var(--warm-ledger-radius-control)] bg-[var(--warm-ledger-color-raised)]" />
            <span className="h-8 w-16 rounded-[var(--warm-ledger-radius-control)] bg-[var(--warm-ledger-color-raised)]" />
          </div>
        </div>
      </section>
    </div>
  )
}
