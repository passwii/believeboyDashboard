interface TableLoadingStateProps {
  tableName: string
  loadingLabel: string
  headers: readonly string[]
  minWidthClass: string
}

export function TableLoadingState({
  tableName,
  loadingLabel,
  headers,
  minWidthClass,
}: TableLoadingStateProps) {
  return (
    <div aria-busy="true" className="min-w-0">
      <p
        className="px-3 py-2 text-xs text-[color:var(--warm-ledger-color-text-muted)]"
        role="status"
      >
        {loadingLabel}
      </p>
      <div
        aria-label={`${tableName}表格`}
        className="w-full min-w-0 overflow-x-auto overscroll-x-contain touch-pan-x focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--warm-ledger-focus-color)]"
        data-table-scroll
        role="region"
        tabIndex={0}
      >
        <table
          aria-hidden="true"
          aria-label={tableName}
          className={`w-full ${minWidthClass} border-collapse text-left text-xs`}
        >
          <thead>
            <tr className="border-b border-[color:var(--warm-ledger-color-hairline)]">
              {headers.map((header, index) => (
                <th
                  className={`px-3 py-3 font-medium text-[color:var(--warm-ledger-color-text-muted)] ${index > 0 ? 'text-right' : 'text-left'}`}
                  key={header}
                  scope="col"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 4 }, (_, rowIndex) => (
              <tr
                className="border-b border-[color:var(--warm-ledger-color-hairline)]"
                key={rowIndex}
              >
                {headers.map((header, columnIndex) => (
                  <td className="px-3 py-4" key={header}>
                    <span
                      className={`block h-3 rounded-[2px] bg-[var(--warm-ledger-color-raised)] ${columnIndex === 0 ? 'w-3/5' : 'ms-auto w-2/5'}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface TableMessageProps {
  kind: 'empty' | 'error'
  title: string
  detail?: string | null
}

export function TableMessage({ kind, title, detail }: TableMessageProps) {
  const isError = kind === 'error'

  return (
    <div className="px-3 py-6">
      <p
        className={`text-sm ${isError ? 'text-[color:var(--warm-ledger-color-negative)]' : 'text-[color:var(--warm-ledger-color-text-muted)]'}`}
        role={isError ? 'alert' : 'status'}
      >
        {title}
        {detail ? `：${detail}` : ''}
      </p>
    </div>
  )
}
