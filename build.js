const esbuild = require('esbuild');
const { sassPlugin } = require('esbuild-sass-plugin');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');
const isZip = process.argv.includes('--zip');

const OUT_DIR_NAME = isDev ? 'dev' : 'dist';
const OUT_DIR = path.join(ROOT_DIR, OUT_DIR_NAME);
const OUT_FILE = path.join(OUT_DIR, 'index.js');

// Static plugin files are intentionally explicit. Keeping this list shared by
// copy and watch prevents a changed README/icon from being omitted in dev.
const STATIC_ASSETS = [
  'plugin.json',
  'icon.png',
  'preview.png',
  'README.md',
  'README_zh-CN.md',
];

// Package only files produced by this build. In particular, never archive
// stale files left in dist/ by an older plugin version.
const PACKAGE_FILES = [
  'index.js',
  'index.js.map',
  ...STATIC_ASSETS,
];

const buildOptions = {
  entryPoints: [path.join(ROOT_DIR, 'src/index.ts')],
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
      // so modules can call addStyle(id, css) and inject a <style> tag.
      type: 'css-text',
      loadPaths: [path.join(ROOT_DIR, 'src/styles')],
    }),
  ],
  logLevel: 'info',
};

function outputDirectoryIsSafe(outDir) {
  const resolved = path.resolve(outDir);
  const allowed = new Set([
    path.resolve(ROOT_DIR, 'dist'),
    path.resolve(ROOT_DIR, 'dev'),
  ]);
  return allowed.has(resolved);
}

function cleanOutputDir(outDir = OUT_DIR) {
  if (!outputDirectoryIsSafe(outDir)) {
    throw new Error(`Refusing to clean unexpected output directory: ${outDir}`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
}

function copyAssets(outDir = OUT_DIR, sourceDir = ROOT_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  STATIC_ASSETS.forEach((asset) => {
    fs.copyFileSync(
      path.join(sourceDir, asset),
      path.join(outDir, asset),
    );
  });

  // Sanity check: with 'type: css-text' the compiled CSS must end up inside
  // index.js. Look for a known selector from src/styles/index.scss.
  const outJs = fs.readFileSync(path.join(outDir, 'index.js'), 'utf-8');
  if (!outJs.includes('#zentype-cursor')) {
    console.warn('Warning: index.js does not contain expected CSS rules. ' +
      'Check that sassPlugin type is "css-text" and the SCSS compiles.');
  }
}

function watchStaticAssets(outDir = OUT_DIR, sourceDir = ROOT_DIR) {
  const assetNames = new Set(STATIC_ASSETS);
  const watcher = fs.watch(sourceDir, (eventType, filename) => {
    const name = filename ? filename.toString() : '';
    if (!assetNames.has(name)) return;
    try {
      copyAssets(outDir, sourceDir);
      console.log(`Updated static asset: ${name}`);
    } catch (error) {
      console.error(`Failed to copy static asset ${name}:`, error);
    }
  });
  return () => watcher.close();
}

function packageZip(outDir = OUT_DIR, zipPath = path.join(ROOT_DIR, 'package.zip')) {
  const { ZipArchive } = require('archiver');
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    output.on('close', () => {
      if (settled) return;
      settled = true;
      console.log(`Created package.zip (${archive.pointer()} bytes)`);
      resolve();
    });
    output.on('error', fail);
    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') {
        console.warn('Archive warning:', error);
      } else {
        fail(error);
      }
    });
    archive.on('error', fail);

    try {
      PACKAGE_FILES.forEach((file) => {
        const source = path.join(outDir, file);
        if (!fs.existsSync(source)) {
          throw new Error(`Missing package file: ${source}`);
        }
        archive.file(source, { name: file });
      });
      archive.pipe(output);
      archive.finalize();
    } catch (error) {
      fail(error);
    }
  });
}

async function runWatch() {
  cleanOutputDir();
  const ctx = await esbuild.context(buildOptions);
  await ctx.rebuild();
  copyAssets();
  const closeStaticWatcher = watchStaticAssets();
  await ctx.watch();
  console.log(`Watching for changes... Output: ${OUT_DIR_NAME}/`);

  const dispose = async () => {
    closeStaticWatcher();
    await ctx.dispose();
  };
  process.once('SIGINT', () => { void dispose(); });
  process.once('SIGTERM', () => { void dispose(); });
}

async function runBuild() {
  cleanOutputDir();
  await esbuild.build(buildOptions);
  copyAssets();
  console.log(`Build complete: ${OUT_DIR_NAME}/`);
  if (isZip) await packageZip();
}

if (require.main === module) {
  (isWatch ? runWatch() : runBuild()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  STATIC_ASSETS,
  PACKAGE_FILES,
  cleanOutputDir,
  copyAssets,
  watchStaticAssets,
  packageZip,
};
