import Image from 'next/image'
import type { ReactNode } from 'react'

import styles from './brand-registration-example-page.module.css'
import { TermPanel } from '@/components/terminal/term-panel'

const BOX_IMAGES = [
  { src: 'box-01.jpg', alt: '包装拍摄示例 01，盒面 Logo 清晰可见' },
  { src: 'box-02.jpg', alt: '包装拍摄示例 02，另一盒面 Logo 清晰可见' },
  { src: 'box-03.jpg', alt: '包装拍摄示例 03，手扶包装盒侧边展示盒身' },
  { src: 'box-04.jpg', alt: '包装拍摄示例 04，展示包装盒身侧面' },
  { src: 'box-05.jpg', alt: '包装拍摄示例 05，手扶盒边展示包装 Logo' },
  { src: 'box-06.jpg', alt: '包装拍摄示例 06，手扶包装盒展示多个盒面' },
]

const PRODUCT_IMAGES = [
  { src: 'product-07.jpg', alt: '产品拍摄示例 01，服装与领标 Logo' },
  { src: 'product-08.jpg', alt: '产品拍摄示例 02，服装包装内整体展示' },
  { src: 'product-09.jpg', alt: '产品拍摄示例 03，服装另一角度展示' },
  { src: 'product-10.jpg', alt: '产品拍摄示例 04，服装领标 Logo 特写' },
]

const ASSET_BASE = '/brand-registration-example'

type Photo = { src: string; alt: string }

function PhotoGrid({
  images,
  columns,
  label,
}: {
  images: Photo[]
  columns: 'box' | 'product'
  label: string
}) {
  return (
    <div
      aria-label={label}
      className={
        columns === 'box'
          ? 'grid grid-cols-2 gap-2 md:grid-cols-3'
          : 'grid grid-cols-2 gap-2'
      }
      role="group"
    >
      {images.map((image, index) => (
        <figure key={image.src} className="min-w-0 border border-term-border bg-term-panel p-1">
          <div className="relative aspect-[4/3] w-full bg-term-raised">
            <Image
              src={`${ASSET_BASE}/${image.src}`}
              alt={image.alt}
              fill
              sizes={columns === 'box' ? '(max-width: 768px) 45vw, 22vw' : '(max-width: 768px) 45vw, 30vw'}
              className="object-contain"
            />
          </div>
          <figcaption className="flex items-center justify-between gap-1 px-1 pt-1 text-xs leading-5 text-term-muted">
            <span className="font-mono tabular-nums">{String(index + 1).padStart(2, '0')}</span>
            <span className="truncate text-right">{image.alt.replace(/^.*?，/, '')}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function Requirement({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2 border-t border-term-border py-2">
      <span className="font-mono text-xs tabular-nums text-term-faint">{number}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-term-text">{title}</h3>
        <div className="mt-1 space-y-1 text-xs leading-5 text-term-muted">{children}</div>
      </div>
    </li>
  )
}

export default function BrandRegistrationExamplePage() {
  return (
    <div className="flex min-w-0 flex-col gap-2 p-2 text-term-text md:p-3">
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-2 border-b border-term-border pb-2">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-wider text-term-faint">
            BelieveBoy / Photo Checklist
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-term-text">
            品牌备案拍摄示例
          </h1>
          <p className="mt-1 text-xs text-term-muted">
            包装与产品拍摄参考，用于品牌备案和 UPC 条码豁免申请。
          </p>
        </div>
        <span className="font-mono text-xs text-term-muted">TOOLBOX / 01</span>
      </header>

      <div className="flex items-start gap-2 border border-term-border bg-term-raised px-2 py-2 text-xs leading-5 text-term-text">
        <span className="shrink-0 font-semibold">背景要求</span>
        <p className="min-w-0 text-term-muted">
          所有照片请在完整、干净、颜色单一的背景下拍摄，例如一整张白色桌面。
        </p>
      </div>

      <div className={styles.layoutContainer}>
        <div className={styles.layoutGrid}>
          <div className="flex min-w-0 flex-col gap-2">
            <TermPanel title="01 / 包装 · BOX" actions={<span className="font-mono text-xs text-term-faint">6 PHOTOS</span>} bodyClassName="p-2">
            <PhotoGrid
              images={BOX_IMAGES}
              columns="box"
              label="包装 / BOX 拍摄示例"
            />
          </TermPanel>

          <TermPanel title="02 / 产品 · PRODUCT" actions={<span className="font-mono text-xs text-term-faint">4 PHOTOS</span>} bodyClassName="p-2">
            <PhotoGrid
              images={PRODUCT_IMAGES}
              columns="product"
              label="产品 / PRODUCT 拍摄示例"
            />
          </TermPanel>
          <p className="text-xs leading-5 text-term-muted">
            图片仅供拍摄角度参考；示例中的木纹桌面不是背景要求，正式拍摄请使用干净的单色背景。
          </p>
        </div>

          <TermPanel title="拍摄要点" bodyClassName="px-2">
            <p className="py-2 text-xs leading-5 text-term-muted">
              每个面尽量拍完整、仔细，确保品牌标识清晰可辨。
            </p>
            <ol className="list-none">
            <Requirement number="01" title="包装需要 Logo">
              <p>包装上须有品牌 Logo；尽量拍全包装各面，确保包装和 Logo 完整清楚。</p>
              <p>可手扶盒子侧边拍摄，这是亚马逊建议的真实拍摄方式。</p>
            </Requirement>
            <Requirement number="02" title="产品也需要 Logo">
              <p>产品本身应展示 Logo；服装类请拍清洗标和吊牌。</p>
              <p>产品上下左右、前后都尽量拍到，画面保持完整。</p>
              <p>可手扶盒子或产品侧边，展示实物。</p>
            </Requirement>
            <Requirement number="03" title="多拍后精选提交">
              <p>建议各个面都多拍几张，最终挑选 5 张提交。</p>
              <p>可用于品牌备案及 UPC 条码豁免申请。</p>
            </Requirement>
          </ol>
          <div className="border-t border-term-border bg-term-raised px-2 py-2 text-xs leading-5 text-term-muted">
            <span className="font-semibold text-term-text">拍摄检查：</span>
            单色干净背景 · 品牌 Logo 清晰 · 包装和产品完整入镜
          </div>
          </TermPanel>
        </div>
      </div>
    </div>
  )
}
