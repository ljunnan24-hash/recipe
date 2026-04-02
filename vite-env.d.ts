/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 生产跨域 API 根路径，如 https://api.example.com/api；同域 Nginx 反代时不要设置 */
  readonly VITE_API_BASE?: string;
  /** Supabase 项目 URL（前端公开） */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon key（前端公开） */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** 与后端同名时可在 vite.config 中通过 envPrefix 暴露给前端（本地 .env.local 复用） */
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
