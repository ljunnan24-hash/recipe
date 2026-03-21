/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 生产跨域 API 根路径，如 https://api.example.com/api；同域 Nginx 反代时不要设置 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
