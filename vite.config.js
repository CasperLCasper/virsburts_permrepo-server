import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
    plugins: [
        nodePolyfills()
    ],
    build: {
        outDir: 'dist',
        rollupOptions: {
            input: 'public/js/backup-src.js',
            output: {
                format: 'esm',
                entryFileNames: 'backup-bundle.js'
            }
        }
    }
});
