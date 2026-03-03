import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type ChangelogType = 'feature' | 'fix' | 'docs' | 'chore' | 'merge' | 'other'

export type ChangelogEntry = {
  hash: string
  shortHash: string
  date: string
  subject: string
  type: ChangelogType
}

const MAX_TRAVERSE_LEVEL = 8

function resolveGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir)

  for (let i = 0; i < MAX_TRAVERSE_LEVEL; i += 1) {
    if (existsSync(path.join(current, '.git'))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

function classifyCommit(subject: string): ChangelogType {
  const normalized = subject.trim().toLowerCase()

  if (normalized.startsWith('feat')) return 'feature'
  if (normalized.startsWith('fix')) return 'fix'
  if (normalized.startsWith('docs')) return 'docs'
  if (normalized.startsWith('chore')) return 'chore'
  if (normalized.startsWith('merge ')) return 'merge'
  return 'other'
}

export function getChangelogEntries(limit = 120): { entries: ChangelogEntry[]; error: string | null } {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 300)) : 120
  const gitRoot = resolveGitRoot(process.cwd())

  if (!gitRoot) {
    return {
      entries: [],
      error: '未找到 Git 仓库，暂时无法读取更新日志。',
    }
  }

  try {
    const output = execFileSync(
      'git',
      ['log', '-n', String(safeLimit), '--date=short', '--pretty=format:%H%x09%h%x09%ad%x09%s'],
      {
        cwd: gitRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )

    const entries = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, date, ...subjectParts] = line.split('\t')
        const subject = subjectParts.join('\t').trim()

        if (!hash || !shortHash || !date || !subject) {
          return null
        }

        return {
          hash,
          shortHash,
          date,
          subject,
          type: classifyCommit(subject),
        } satisfies ChangelogEntry
      })
      .filter((entry): entry is ChangelogEntry => entry !== null)

    return { entries, error: null }
  } catch {
    return {
      entries: [],
      error: '读取 Git 提交记录失败，请确认运行环境允许执行 git 命令。',
    }
  }
}
