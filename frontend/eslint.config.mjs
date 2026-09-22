// ESLint 9+ 只认 flat config；eslint-config-next 16 的 core-web-vitals 已经是
// flat config 数组（旧的 .eslintrc.json + extends 写法在 ESLint 9 下不再生效）。
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

export default [
  {
    ignores: [
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      'public/**',
      '.lighthouseci/**',
    ],
  },
  ...nextCoreWebVitals,
  {
    // eslint-config-next 16 带进来的 eslint-plugin-react-hooks v7 默认启用一批
    // React Compiler 规则，存量代码命中 7 条规则共 266 处 error。依赖升级不夹带
    // 大规模 hook 重构，这里先关闭，避免 CI（pnpm lint）整体变红；
    // 清理这批历史用法应作为独立任务推进，而不是混在工具链升级里。
    name: 'believeboy/react-compiler-rules-off',
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/purity': 'off',
    },
  },
]
