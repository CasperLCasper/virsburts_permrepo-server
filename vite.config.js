import { defineConfig } from 'vite';
import polyfillPkg from '@esbuild-plugins/node-modules-polyfill';

const { nodePolyfills } = polyfillPkg;

export default defineConfig({
    plugins: [
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true,
            }
        })
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
