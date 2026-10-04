import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // 0.0.0.0 so the port published from the devcontainer reaches the Mac.
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  // The Codama client reads process.env.NODE_ENV, which browsers don't have.
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
}));
