'use client'

import React from 'react'

import {
  BelieveboyGlassReveal,
  type BelieveboyRevealVariant,
} from '@/components/brand/believeboy-glass-reveal'
import { BelieveboyMark } from '@/components/brand/believeboy-mark'
import { GlassReveal21stDemo } from '@/components/brand/glass-reveal-21st.demo'
import {
  BELIEVEBOY_MARK_LABELS,
  type BelieveboyMarkDirection,
} from '@/components/brand/believeboy-marks'

import styles from './brand-draft.module.css'

/**
 * BLF-1553 草稿页：三条 LOGO 方向 + 三档玻璃动效，均可在浅色 / 暗色下对比。
 * 草稿阶段不接管登录页或侧栏；确认方向后才替换既有 `BrandMark` 与 `app/icon.svg`。
 */

type RevealChoice = BelieveboyRevealVariant | 'upstream'

const DIRECTIONS: Array<{
  id: BelieveboyMarkDirection
  name: string
  idea: string
  tradeoff: string
}> = [
  {
    id: 'wing',
    name: 'A · Wing-cut B（推荐）',
    idea: '把既确认的三片白翼收成两道向右上扬的切口，B 的骨架不变；切口斜边正好落在玻璃棱边的折射带上。',
    tradeoff: '16 px 下两道切口仍是清晰的负空间；圆底图标需要把首字母单独裁切，与既有 B · 飞翼的圆形底不完全一致。',
  },
  {
    id: 'ledger',
    name: 'B · Ledger B',
    idea: '直边账本 B：每个字怀里横贯一条细线，把碗形读成对账行，直接对齐 V4 Warm Ledger 的账本隐喻。',
    tradeoff: '细线在 20 px 以下会糊成灰块；作为主标识更适合说明性场景，而不是 favicon 或侧栏缩略。',
  },
  {
    id: 'seam',
    name: 'C · Wordmark b',
    idea: '小写 b 的升部顶端斜切成翼尖，与 `elieveboy` 组成连字锁合；字标承担品牌名，mark 只做识别锚点。',
    tradeoff: '单独作图标时首字母大写语义丢失；锁合依赖字标排版，不适合宽高比被压扁的槽位。',
  },
]

const VARIANTS: Array<{ id: RevealChoice; name: string; note: string }> = [
  { id: 'wing-cut', name: '收束成应用图标', note: '钴蓝圆角方片落地，白色 B 后补' },
  { id: 'prism', name: '棱镜加长', note: '放大边缘色散与沿边拖影' },
  { id: 'bare', name: '极简擦亮', note: '停在裸标，不做收束' },
  { id: 'upstream', name: '上游默认（对照）', note: '未改任何 tuning 的 21st.dev 默认露出：水滴长成、玻璃松手、留下 21st 标记' },
]

export default function BrandDraftPage() {
  const [direction, setDirection] = React.useState<BelieveboyMarkDirection>('wing')
  const [variant, setVariant] = React.useState<RevealChoice>('wing-cut')
  const [tone, setTone] = React.useState<'light' | 'dark'>('light')
  const [replayKey, setReplayKey] = React.useState(0)
  const [showAudit, setShowAudit] = React.useState(false)

  // `GlassIconReveal` 只在首次挂载时启动引擎，要重播需要换 key 重挂。
  const replay = () => setReplayKey((n) => n + 1)
  const isUpstream = variant === 'upstream'

  return (
    <main className={styles.page} data-tone={tone}>
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}>BLF-1553 · 草稿，待讨论</p>
          <h1 className={styles.title}>Believeboy LOGO 重设计</h1>
        </div>
        <div className={styles.controls}>
          <button type="button" className={styles.button} onClick={() => setTone(tone === 'light' ? 'dark' : 'light')}>
            {tone === 'light' ? '切到暗色' : '切到浅色'}
          </button>
          <button type="button" className={styles.button} onClick={replay}>
            重播动效
          </button>
        </div>
      </header>

      <section className={styles.section} aria-labelledby="directions-title">
        <h2 id="directions-title" className={styles.sectionTitle}>
          方向
        </h2>
        <div className={styles.directionGrid}>
          {DIRECTIONS.map((item) => (
            <article
              key={item.id}
              className={styles.card}
              data-active={direction === item.id}
            >
              <button
                type="button"
                className={styles.cardButton}
                onClick={() => setDirection(item.id)}
                aria-pressed={direction === item.id}
              >
                <BelieveboyMark
                  direction={item.id}
                  className={styles.cardMark}
                  label={BELIEVEBOY_MARK_LABELS[item.id]}
                />
                <span className={styles.cardName}>{item.name}</span>
              </button>
              <p className={styles.cardBody}>{item.idea}</p>
              <p className={styles.cardTradeoff}>{item.tradeoff}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="reveal-title">
        <div className={styles.sectionHead}>
          <h2 id="reveal-title" className={styles.sectionTitle}>
            玻璃动效
          </h2>
          <div className={styles.variantTabs} role="tablist" aria-label="动效变体">
            {VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={variant === v.id}
                className={styles.variantTab}
                onClick={() => setVariant(v.id)}
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.variantNote}>
          {VARIANTS.find((v) => v.id === variant)?.note}
          {isUpstream
            ? ' · 这个对照里放的仍是 21st.dev 自己的标记，不是 Believeboy。'
            : direction !== 'wing'
              ? ' · 动效只调过 Wing-cut B，其余方向沿用同一几何以保持可比。'
              : null}
        </p>
        <div className={styles.stage}>
          {isUpstream ? (
            <UpstreamReveal key={`upstream-${tone}-${replayKey}`} tone={tone} />
          ) : (
            <BelieveboyGlassReveal
              key={`${variant}-${tone}-${replayKey}`}
              mark={direction}
              variant={variant}
              tone={tone}
              className={styles.reveal}
              label="Believeboy"
            />
          )}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="sizes-title">
        <div className={styles.sectionHead}>
          <h2 id="sizes-title" className={styles.sectionTitle}>
            尺寸与底色
          </h2>
          <button
            type="button"
            className={styles.button}
            onClick={() => setShowAudit((value) => !value)}
          >
            {showAudit ? '收起 16px 以下放大' : '放大 16px 检查'}
          </button>
        </div>
        <div className={styles.sizeRow}>
          {[96, 48, 32, 24, 20, 16].map((size) => (
            <div key={size} className={styles.sizeCell}>
              <BelieveboyMark
                direction={direction}
                className={styles.sizeMark}
                style={{ width: size, height: size }}
                label={`Believeboy · ${size}px`}
              />
              <span className={styles.sizeLabel}>{size}</span>
            </div>
          ))}
          <div className={styles.sizeCell}>
            <span className={styles.tileBlue}>
              <BelieveboyMark direction={direction} className={styles.sizeMark} label="Believeboy" style={{ width: 40, height: 40 }} />
            </span>
            <span className={styles.sizeLabel}>钴蓝</span>
          </div>
          <div className={styles.sizeCell}>
            <span className={styles.tileDark}>
              <BelieveboyMark direction={direction} className={styles.sizeMark} label="Believeboy" style={{ width: 40, height: 40 }} />
            </span>
            <span className={styles.sizeLabel}>暗底</span>
          </div>
          <div className={styles.sizeCell}>
            <span className={styles.tileCream}>
              <BelieveboyMark direction={direction} className={styles.sizeMark} label="Believeboy" style={{ width: 40, height: 40 }} />
            </span>
            <span className={styles.sizeLabel}>纸白</span>
          </div>
        </div>
        {showAudit ? (
          <div className={styles.audit}>
            <p className={styles.auditNote}>
              把 14~20 px 的临界尺寸放大 6 倍，检查字怀是否会糊成一团。
            </p>
            <div className={styles.auditRow}>
              {[14, 16, 18, 20].map((size) => (
                <div key={size} className={styles.sizeCell}>
                  <span className={styles.auditFrame}>
                    <BelieveboyMark
                      direction={direction}
                      className={styles.sizeMark}
                      style={{ width: size * 6, height: size * 6 }}
                      label={`Believeboy · ${size}px 放大`}
                    />
                  </span>
                  <span className={styles.sizeLabel}>{size}px × 6</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

/** 上游默认露出：只换明暗底色，其余完全用组件自带预设，作为「改没改」的对照。 */
function UpstreamReveal({ tone }: { tone: 'light' | 'dark' }) {
  return (
    <GlassReveal21stDemo
      className={styles.reveal}
      // 上游 light 预设的背景是 #e9e9eb；暗色下换成草稿舞台色，其余不动。
      background={tone === 'dark' ? '#101319' : undefined}
      look={tone}
    />
  )
}
