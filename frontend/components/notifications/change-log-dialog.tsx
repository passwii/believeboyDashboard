'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { changeLog, type ChangeLogEntry } from '@/config/changelog'
import { CHANGELOG_READ_KEY } from '@/lib/notifications'
import { Sparkles } from 'lucide-react'

export function ChangeLogDialog() {
  const [entry, setEntry] = useState<ChangeLogEntry | null>(null)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const latestEntry = changeLog[0]
    if (!latestEntry) return

    const readId = localStorage.getItem(CHANGELOG_READ_KEY)
    if (readId !== latestEntry.id) {
      setEntry(latestEntry)
      setIsOpen(true)
    }
  }, [])

  const handleClose = () => {
    if (entry) {
      localStorage.setItem(CHANGELOG_READ_KEY, entry.id)
    }
    setIsOpen(false)
  }

  if (!entry) return null

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        aria-describedby="changelog-dialog-description"
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            <span className="text-sm font-medium text-muted-foreground">
              {entry.date}
            </span>
          </div>
          <DialogTitle className="text-xl">{entry.title}</DialogTitle>
        </DialogHeader>

        <div id="changelog-dialog-description" className="space-y-3 py-2">
          <p className="text-sm font-medium text-foreground">本次更新</p>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {entry.content}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose} className="w-full sm:w-auto">
            我知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}