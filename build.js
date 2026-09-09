const esbuild = require('esbuild');
const { sassPlugin } = require('esbuild-sass-plugin');
const fs = require('fs');
const path = require('path');

const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');
const outdir = path.join(__dirname, dev ? 'dev' : 'dist');
const assets = ['plugin.json', 'icon.png', 'preview.png', 'README.md', 'README_zh-CN.md'];
const files = ['index.js', ...assets];

function copyAssets() {
  for (const name of assets) fs.copyFileSync(path.join(__dirname, name), path.join(outdir, name));
}

/** Only the two known output directories may be removed. */
function cleanOutputDir() {
  const resolved = path.resolve(outdir);
  const allowed = new Set([path.join(__dirname, 'dev'), path.join(__dirname, 'dist')]);
  if (!allowed.has(resolved)) throw new Error('Refusing to clean unexpected output directory: ' + resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

async function packageZip() {
  const { ZipArchive } = require('archiver');
  const destination = path.join(__dirname, 'package.zip');
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(output);
    for (const name of files) archive.file(path.join(outdir, name), { name });
    archive.finalize().catch(reject);
  });
  console.log('Package: ' + destination);
}

async function main() {
  // A clean output directory keeps a renamed or dropped file from surviving as a
  // stale artifact of an older build.
  cleanOutputDir();
  const options = {
    entryPoints: [path.join(__dirname, 'src/index.ts')],
    outfile: path.join(outdir, 'index.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['siyuan'],
    sourcemap: true,
    minify: !dev,
    plugins: [sassPlugin({ type: 'css-text' })],
    logLevel: 'info',
  };
  if (watch) {
    const context = await esbuild.context(options);
    await context.rebuild();
    copyAssets();
    await context.watch();
    const watcher = fs.watch(__dirname, (_, filename) => {
      if (assets.includes(String(filename))) copyAssets();
    });
    const close = async () => { watcher.close(); await context.dispose(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } else {
    await esbuild.build(options);
    copyAssets();
    if (process.argv.includes('--zip')) await packageZip();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
