
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Derive base from homepage (optional)
// If homepage is like "https://user.github.io/repo", base should be "/repo/"
function homepageToBase() {
  try {
    const pkg = require('./package.json');
    const homepage: string | undefined = pkg.homepage;
    if (!homepage) return '';
    const u = new URL(homepage);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 1) return `/${parts[parts.length - 1]}/`;
    return '';
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react()],
  base: homepageToBase(), // "" for localhost; "/repo/" for GH Pages
});
