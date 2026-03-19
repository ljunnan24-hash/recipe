import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
    return {
      server: {
        // 固定前端端口，避免 Vite 自动换端口导致「看起来像旧版本」
        port: 4300,
        strictPort: true,
        host: '0.0.0.0',
        proxy: {
          // 只代理 /api/ 路径（如 /api/ai/scan），避免 /api.ts 被误转发导致前端脚本 404
          '/api/': {
            // 后端固定在 4301 端口
            target: 'http://localhost:4301',
            changeOrigin: true,
          },
        },
      },
      plugins: [
        react(),
        tailwindcss(),
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
