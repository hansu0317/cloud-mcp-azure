import { defineConfig, loadEnv } from 'vite'
import react                     from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxyTarget = env.VITE_API_PROXY_TARGET?.trim()
    || `http://localhost:${env.PORT?.trim() || '3000'}`

  return {
    plugins: [react()],
    build: {
      outDir:      'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
