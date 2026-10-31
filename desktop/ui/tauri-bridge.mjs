import { invoke } from '@tauri-apps/api/core';

if (!window.__MIHOME_TAURI__) {
  window.__MIHOME_TAURI__ = Object.freeze({ invoke });
}
