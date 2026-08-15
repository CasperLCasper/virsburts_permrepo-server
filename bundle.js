import esbuild from 'esbuild';

console.log('Sākam bundling...');

try {
    await esbuild.build({
        entryPoints: ['public/js/backup-src.js'],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        outfile: 'public/js/backup-bundle.js',
        alias: {
            'fs': 'empty',
            'path': 'empty',
            'crypto': 'empty',
            'stream': 'empty',
            'buffer': 'empty',
            'node:stream': 'empty'
        },
        define: {
            'process.env.NODE_ENV': '"production"',
            'global': 'window'
        }
    });
    
    console.log('✅ Bundle izveidots: public/js/backup-bundle.js');
} catch (e) {
    console.error('❌ Bundle kļūda:', e.message);
    process.exit(1);
}
