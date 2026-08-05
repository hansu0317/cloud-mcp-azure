import { defineConfig } from 'vite'
import react            from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir:      'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,   // 조용히 다른 포트로 옮겨가면 로컬 북마크·프록시 설정이 깨진다
    proxy: {
      '/api': {
        target:       'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
