import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucida-core'],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
