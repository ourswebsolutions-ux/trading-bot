/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_API_BASE_URL?: string
  readonly MAIN_VITE_ENTITLEMENT_PUBLIC_KEY?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
