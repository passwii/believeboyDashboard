import React from 'react'
import { createRoot } from 'react-dom/client'
import { BelieveboyMark } from '@/components/brand/believeboy-mark'
import { BelieveboyGlassReveal, type BelieveboyRevealVariant } from '@/components/brand/believeboy-glass-reveal'
import { BELIEVEBOY_MARK_LABELS, type BelieveboyMarkDirection } from '@/components/brand/believeboy-marks'
import { GlassReveal21stDemo } from '@/components/brand/glass-reveal-21st.demo'

type RevealChoice = BelieveboyRevealVariant | 'upstream'

const DIRECTIONS: Array<{ id: BelieveboyMarkDirection; name: string; idea: string; tradeoff: string }> = [
  {
    id: 'wing',
    name: 'A · Wing-cut B（推荐）',
    idea: '把既确认的三片白翼收成两道向右上扬的切口，B 的骨架不变；切口斜边正好落在玻璃棱边的折射带上。',
    tradeoff: '16 px 下两道切口仍是清晰负空间；圆底图标需把首字母单独裁切。',
  },
  {
    id: 'ledger',
    name: 'B · Ledger B',
    idea: '直边账本 B：每个字怀里横贯一条细线，把碗形读成对账行，对齐 V4 Warm Ledger 的账本隐喻。',
    tradeoff: '细线在 20 px 以下会糊成灰块；更适合说明性场景，不适合 favicon 或侧栏缩略。',
  },
  {
    id: 'seam',
    name: 'C · Wordmark b',
    idea: '小写 b 的升部顶端斜切成翼尖，与 elieveboy 组成连字锁合；字标承担品牌名，mark 只做识别锚点。',
    tradeoff: '单独作图标时首字母大写语义丢失；锁合依赖字标排版，不适合被压扁的槽位。',
  },
]

const VARIANTS: Array<{ id: RevealChoice; name: string; note: string }> = [
  { id: 'wing-cut', name: '收束成应用图标', note: '钴蓝圆角方片落地，白色 B 后补；没有「玻璃松手」那一段。' },
  { id: 'prism', name: '棱镜加长', note: '放大边缘色散与沿边拖影，让两道翼切口被折成光谱。' },
  { id: 'bare', name: '极简擦亮', note: '玻璃只擦亮一次，最后停在裸标，不做收束。' },
  { id: 'upstream', name: '上游默认（对照）', note: '未改任何 tuning 的 21st.dev 默认露出；这里放的仍是 21st 自己的标记，不是 Believeboy。' },
]

function Draft() {
  const [direction, setDirection] = React.useState<BelieveboyMarkDirection>('wing')
  const [variant, setVariant] = React.useState<RevealChoice>('wing-cut')
  const [tone, setTone] = React.useState<'light' | 'dark'>('light')
  const [replay, setReplay] = React.useState(0)
  const [showSizes, setShowSizes] = React.useState(false)

  React.useEffect(() => {
    document.documentElement.dataset.tone = tone
  }, [tone])

  return (
    <div className="draft" data-tone={tone}>
      <header className="head">
        <div>
          <p className="kicker">BLF-1553 · 草稿，待讨论</p>
          <h1 className="title">Believeboy LOGO 重设计</h1>
          <p className="lede">三个方向 + 三档玻璃动效。方向与动效都可切换，浅色 / 暗色下各看一次再定。</p>
        </div>
        <div className="controls">
          <button type="button" className="btn" onClick={() => setTone(tone === 'light' ? 'dark' : 'light')}>
            {tone === 'light' ? '切到暗色' : '切到浅色'}
          </button>
          <button type="button" className="btn" onClick={() => setReplay((n) => n + 1)}>重播动效</button>
        </div>
      </header>

      <section className="section">
        <h2 className="section-title">方向</h2>
        <div className="cards">
          {DIRECTIONS.map((d) => (
            <article key={d.id} className="card" data-active={direction === d.id}>
              <button type="button" className="card-btn" onClick={() => setDirection(d.id)} aria-pressed={direction === d.id}>
                <BelieveboyMark direction={d.id} className="card-mark" label={BELIEVEBOY_MARK_LABELS[d.id]} />
                <span className="card-name">{d.name}</span>
              </button>
              <p className="card-body">{d.idea}</p>
              <p className="card-tradeoff">{d.tradeoff}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">玻璃动效</h2>
          <div className="tabs" role="tablist" aria-label="动效变体">
            {VARIANTS.map((v) => (
              <button key={v.id} type="button" role="tab" aria-selected={variant === v.id} className="tab" onClick={() => setVariant(v.id)}>
                {v.name}
              </button>
            ))}
          </div>
        </div>
        <p className="note">{VARIANTS.find((v) => v.id === variant)?.note}</p>
        <div className="stage">
          {variant === 'upstream' ? (
            <GlassReveal21stDemo
              key={`upstream-${tone}-${replay}`}
              className="reveal"
              look={tone}
              background={tone === 'dark' ? '#101319' : undefined}
            />
          ) : (
            <BelieveboyGlassReveal
              key={`${direction}-${variant}-${tone}-${replay}`}
              mark={direction}
              variant={variant}
              tone={tone}
              className="reveal"
              label="Believeboy"
            />
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">尺寸与底色</h2>
          <button type="button" className="btn quiet" onClick={() => setShowSizes((v) => !v)}>
            {showSizes ? '收起 16px 以下放大' : '放大 16px 检查'}
          </button>
        </div>
        <div className="sizes">
          {[96, 48, 32, 24, 20, 16].map((size) => (
            <div key={size} className="size-cell">
              <BelieveboyMark direction={direction} className="size-mark" style={{ width: size, height: size }} label={`Believeboy ${size}px`} />
              <span className="size-label">{size}</span>
            </div>
          ))}
          <div className="size-cell">
            <span className="tile blue"><BelieveboyMark direction={direction} className="size-mark" style={{ width: 40, height: 40 }} label="Believeboy 钴蓝底" /></span>
            <span className="size-label">钴蓝</span>
          </div>
          <div className="size-cell">
            <span className="tile dark"><BelieveboyMark direction={direction} className="size-mark" style={{ width: 40, height: 40 }} label="Believeboy 暗底" /></span>
            <span className="size-label">暗底</span>
          </div>
          <div className="size-cell">
            <span className="tile cream"><BelieveboyMark direction={direction} className="size-mark" style={{ width: 40, height: 40 }} label="Believeboy 纸白底" /></span>
            <span className="size-label">纸白</span>
          </div>
        </div>
        {showSizes && (
          <div className="audit">
            <p className="note">把 14~20 px 的临界尺寸放大 6 倍，检查字怀是否会糊成一团。</p>
            <div className="audit-row">
              {[14, 16, 18, 20].map((size) => (
                <div key={size} className="audit-cell">
                  <span className="zoom-wrap"><BelieveboyMark direction={direction} className="size-mark" style={{ width: size * 6, height: size * 6 }} label={`Believeboy ${size}px 放大`} /></span>
                  <span className="size-label">{size}px × 6</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <footer className="foot">
        <span>草稿 · 未接入登录页、侧栏或 favicon</span>
        <span className="mono">glass reveal 基于 21st.dev / zanwei glass-icon-reveal（MIT）</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Draft />)
