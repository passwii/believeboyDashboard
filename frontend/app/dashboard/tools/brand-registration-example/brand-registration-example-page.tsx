import Image from 'next/image'
import type { ReactNode } from 'react'

import { ToolsPageFrame, ToolsPanel } from '../_components'
import styles from './brand-registration-example-page.module.css'

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
      className={`${styles.photoGrid} ${columns === 'box' ? styles.boxGrid : styles.productGrid}`}
      data-photo-grid={columns}
      role="group"
    >
      {images.map((image, index) => (
        <figure key={image.src} className={styles.photoCard}>
          <div className={styles.imageFrame}>
            <Image
              src={`${ASSET_BASE}/${image.src}`}
              alt={image.alt}
              fill
              sizes={
                columns === 'box'
                  ? '(min-width: 1280px) 18vw, (min-width: 641px) 30vw, 44vw'
                  : '(min-width: 1280px) 28vw, (min-width: 641px) 42vw, 44vw'
              }
              className={styles.image}
            />
          </div>
          <figcaption className={styles.photoCaption}>
            <span className={styles.photoIndex}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.photoCaptionText}>
              {image.alt.replace(/^.*?，/, '')}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function Requirement({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <li className={styles.requirement}>
      <span className={styles.requirementNumber}>{number}</span>
      <div className={styles.requirementCopy}>
        <h3 className={styles.requirementTitle}>{title}</h3>
        <div className={styles.requirementBody}>{children}</div>
      </div>
    </li>
  )
}

export default function BrandRegistrationExamplePage() {
  return (
    <ToolsPageFrame className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>品牌备案拍摄示例</h1>
        <p className={styles.subtitle}>
          包装与产品拍摄参考，用于品牌备案和 UPC 条码豁免申请。
        </p>
      </header>

      <div className={styles.backgroundNote}>
        <span className={styles.backgroundLabel}>背景要求</span>
        <p className={styles.backgroundCopy}>
          所有照片请在完整、干净、颜色单一的背景下拍摄，例如一整张白色桌面。
        </p>
      </div>

      <div className={styles.layoutGrid}>
        <div className={styles.galleryColumn}>
          <ToolsPanel
            title="01 / 包装 · BOX"
            actions={<span className={styles.photoCount}>6 张</span>}
          >
            <PhotoGrid
              images={BOX_IMAGES}
              columns="box"
              label="包装 / BOX 拍摄示例"
            />
          </ToolsPanel>

          <ToolsPanel
            title="02 / 产品 · PRODUCT"
            actions={<span className={styles.photoCount}>4 张</span>}
          >
            <PhotoGrid
              images={PRODUCT_IMAGES}
              columns="product"
              label="产品 / PRODUCT 拍摄示例"
            />
          </ToolsPanel>
          <p className={styles.galleryNote}>
            图片仅供拍摄角度参考；示例中的木纹桌面不是背景要求，正式拍摄请使用干净的单色背景。
          </p>
        </div>

        <ToolsPanel title="拍摄要点">
          <p className={styles.requirementsIntro}>
            每个面尽量拍完整、仔细，确保品牌标识清晰可辨。
          </p>
          <ol className={styles.requirementList}>
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
          <div className={styles.checkSummary}>
            <span className={styles.checkLabel}>拍摄检查</span>
            <p>
            单色干净背景 · 品牌 Logo 清晰 · 包装和产品完整入镜
            </p>
          </div>
        </ToolsPanel>
      </div>
    </ToolsPageFrame>
  )
}
