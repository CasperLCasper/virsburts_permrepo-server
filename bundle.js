import esbuild from 'esbuild';

console.log('Sākam bundling...');

try {
    await esbuild.build({
        entryPoints: ['public/js/backup-src.js'],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        outfile: 'public/js/backup-bundle.js',
        define: {
            'process.env.NODE_ENV': '"production"',
            'global': 'window'
        },
        plugins: [{
            name: 'node-polyfills',
            setup(build) {
                build.onResolve({ filter: /^(buffer|crypto|stream|process|path)$/ }, args => {
                    return { path: args.path, namespace: 'polyfill' };
                });
            }
        }]
    });
    
    console.log('✅ Bundle izveidots: public/js/backup-bundle.js');
} catch (e) {
    console.error('❌ Bundle kļūda:', e.message);
    process.exit(1);
}
