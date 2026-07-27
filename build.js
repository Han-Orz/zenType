const esbuild = require('esbuild');
const { sassPlugin } = require('esbuild-sass-plugin');
const fs = require('fs');
const path = require('path');

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');
const isZip = process.argv.includes('--zip');

const OUT_DIR = isDev ? 'dev' : 'dist';
const OUT_FILE = path.join(OUT_DIR, 'index.js');

const buildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: OUT_FILE,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  external: ['siyuan'],
  loader: { '.ts': 'ts' },
  plugins: [
    sassPlugin({
      // 'css-text' makes SCSS imports return the compiled CSS as a string,
      // so modules can call addStyle(id, css) and inject it as a <style> tag.
      // (Previously 'css' emitted a separate dev/index.css file, which left
      //  `import css from '*.scss'` as an empty object at runtime.)
      type: 'css-text',
      loadPaths: ['src/styles'],
    }),
  ],
  logLevel: 'info',
};

function copyAssets() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync('plugin.json', path.join(OUT_DIR, 'plugin.json'));
  fs.copyFileSync('icon.png', path.join(OUT_DIR, 'icon.png'));
  fs.copyFileSync('preview.png', path.join(OUT_DIR, 'preview.png'));
  fs.copyFileSync('README.md', path.join(OUT_DIR, 'README.md'));
  fs.copyFileSync('README_zh-CN.md', path.join(OUT_DIR, 'README_zh-CN.md'));
  // Sanity check: with `type: 'css-text'` the compiled CSS must end up inside
  // index.js. Look for a known selector from src/styles/index.scss.
  // (Previously also checked `#zentype-highlight-line` — removed in v2.2.1 P3
  //  highlighter-bar deletion; the comment marker in index.scss:104 is not
  //  bundled into JS. Check #zentype-cursor alone is sufficient.)
  const outJs = fs.readFileSync(OUT_FILE, 'utf-8');
  if (!outJs.includes('#zentype-cursor')) {
    console.warn('Warning: index.js does not contain expected CSS rules. ' +
      'Check that sassPlugin type is "css-text" and the SCSS compiles.');
  }
}

if (isWatch) {
  esbuild
    .context(buildOptions)
    .then(async (ctx) => {
      // Do an initial build synchronously so dev/ has index.js before
      // copyAssets() tries to read it. Then start watching for changes.
      await ctx.rebuild();
      copyAssets();
      await ctx.watch();
      console.log(`Watching for changes... Output: ${OUT_DIR}/`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  esbuild
    .build(buildOptions)
    .then(() => {
      copyAssets();
      console.log(`Build complete: ${OUT_DIR}/`);
      if (isZip) packageZip();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

function packageZip() {
  const archiver = require('archiver');
  const output = fs.createWriteStream('package.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => {
    console.log(`Created package.zip (${archive.pointer()} bytes)`);
  });

  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      console.warn('Archive warning:', err);
    } else {
      throw err;
    }
  });

  archive.on('error', (err) => {
    throw err;
  });

  archive.pipe(output);
  archive.directory('dist/', false);
  archive.finalize();
}
