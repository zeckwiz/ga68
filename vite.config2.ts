
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Use env var for base so you can build for USB or GH Pages cleanly.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/', // default for local/USB
});
