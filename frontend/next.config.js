/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  allowedDevOrigins: ['145.79.143.98', 'dash.believeboy.com'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.google.com',
        pathname: '/s2/favicons/**',
      },
      {
        protocol: 'https',
        hostname: 'bucket.believeboy.com',
      },
      {
        protocol: 'https',
        hostname: '*.r2.cloudflarestorage.com',
      },
    ],
    unoptimized: true,
  },
  // BLF-601 彻底改造：供应链分类取消并入运营，旧 /dashboard/supply-chain/* 永久 301 到新路径（保留 query）
  async redirects() {
    const supplyChainRoutes = [
      'weekly-product-analysis',
      'portfolio-overview',
      'sku-info',
      'inventory-replenishment',
      'inventory-ledger',
      'seasonal-replenishment',
      'shipment-management',
    ]
    return supplyChainRoutes.map((route) => ({
      source: `/dashboard/supply-chain/${route}`,
      destination: `/dashboard/operations/${route}`,
      permanent: true,
    }))
  },
}

module.exports = nextConfig
