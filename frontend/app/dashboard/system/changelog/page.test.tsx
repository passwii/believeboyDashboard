import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { getChangelogSnapshot } from '@/lib/server/changelog'
import ChangelogPage from './page'

describe('ChangelogPage', () => {
  const snapshot = getChangelogSnapshot()

  it('renders every server snapshot release with its stable anchor', () => {
    const { container } = render(<ChangelogPage />)
    const navigation = screen.getByRole('navigation', {
      name: 'Changelog release navigation',
    })

    expect(container.querySelector('[data-warm-changelog="true"]')).toBeInTheDocument()

    for (const release of snapshot.releases) {
      const anchor = `#${release.version.toLowerCase()}`
      expect(
        within(navigation).getByRole('link', {
          name: new RegExp(release.version),
        }),
      ).toHaveAttribute('href', anchor)
      expect(document.getElementById(release.version.toLowerCase())).toHaveTextContent(
        release.version,
      )
    }
  })

  it('wires the source log disclosure to the panel it controls', () => {
    render(<ChangelogPage />)

    const disclosure = screen.getAllByRole('button', { name: /原始 log 线索/ })[0]
    const panelId = disclosure.getAttribute('aria-controls')

    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(panelId).toBeTruthy()
    expect(document.getElementById(panelId as string)).toHaveAttribute('hidden')

    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(panelId as string)).not.toHaveAttribute('hidden')
  })
})
