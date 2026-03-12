#!/usr/bin/env node
/**
 * scripts/gen-icons.js
 * Generates .icns (macOS) and .ico (Windows) from a source SVG.
 * Run: node scripts/gen-icons.js
 * Requires: npm install sharp png2icons --save-dev
 */

const fs   = require('fs');
const path = require('path');

// Inline SVG — Arie logo mark (blue rounded square + white dot)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="200" fill="url(#g)"/>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1E54D4"/>
      <stop offset="100%" stop-color="#08B5CF"/>
    </linearGradient>
  </defs>
  <!-- Bird silhouette -->
  <path d="M512 260 C380 260 270 355 260 480 L200 440 C220 340 310 260 420 240 Z"
        fill="white" opacity="0.9"/>
  <path d="M512 260 C644 260 754 355 764 480 L824 440 C804 340 714 260 604 240 Z"
        fill="white" opacity="0.7"/>
  <ellipse cx="512" cy="530" rx="160" ry="140" fill="white" opacity="0.95"/>
  <ellipse cx="512" cy="560" rx="80" ry="100" fill="url(#g)"/>
  <!-- Eye -->
  <circle cx="560" cy="490" r="22" fill="white"/>
  <circle cx="566" cy="490" r="11" fill="#050D18"/>
  <!-- Tail feathers -->
  <path d="M380 640 C340 720 280 760 220 740 C280 700 320 660 360 620 Z" fill="white" opacity="0.8"/>
  <path d="M512 680 C512 780 490 830 460 840 C480 790 495 740 500 680 Z" fill="white" opacity="0.7"/>
  <path d="M644 640 C684 720 744 760 804 740 C744 700 704 660 664 620 Z" fill="white" opacity="0.8"/>
</svg>`;

async function main() {
  try {
    const sharp     = require('sharp');
    const png2icons = require('png2icons');

    const assetsDir = path.join(__dirname, '../assets');
    const macDir    = path.join(assetsDir, 'icons/mac');
    const winDir    = path.join(assetsDir, 'icons/win');

    // Write SVG
    const svgPath = path.join(assetsDir, 'icon.svg');
    fs.writeFileSync(svgPath, svg);
    console.log('✓ SVG written');

    // Generate PNGs at required sizes
    const sizes = [16, 32, 64, 128, 256, 512, 1024];
    const pngs  = {};

    for (const size of sizes) {
      const buf = await sharp(Buffer.from(svg))
        .resize(size, size)
        .png()
        .toBuffer();
      pngs[size] = buf;
      const outPath = path.join(assetsDir, `icon-${size}.png`);
      fs.writeFileSync(outPath, buf);
      console.log(`✓ ${size}x${size} PNG`);
    }

    // macOS: .icns needs an iconset folder
    const iconsetDir = path.join(macDir, 'icon.iconset');
    fs.mkdirSync(iconsetDir, { recursive: true });

    const icnsSizes = [
      [16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'],
      [128, '128x128'], [256, '128x128@2x'], [256, '256x256'], [512, '256x256@2x'],
      [512, '512x512'], [1024, '512x512@2x']
    ];
    for (const [px, name] of icnsSizes) {
      fs.writeFileSync(path.join(iconsetDir, `icon_${name}.png`), pngs[px]);
    }
    // iconutil is macOS-only — provide instructions
    fs.writeFileSync(
      path.join(macDir, 'BUILD.txt'),
      'Run on macOS: iconutil -c icns icon.iconset -o icon.icns\n'
    );
    console.log('✓ iconset written — run iconutil on macOS to produce icon.icns');

    // Windows: .ico (multi-size)
    const icoInput = pngs[256]; // use 256px as source
    const ico = png2icons.createICO(icoInput, png2icons.BILINEAR, 0, false, true);
    fs.writeFileSync(path.join(winDir, 'icon.ico'), ico);
    // Also copy to assets root (electron-builder looks here)
    fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);
    console.log('✓ icon.ico written');

    // 512px PNG for Linux
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngs[512]);
    console.log('✓ icon.png written');

    console.log('\nDone. Next step on macOS:');
    console.log('  cd assets/icons/mac && iconutil -c icns icon.iconset -o icon.icns');
    console.log('  cp assets/icons/mac/icon.icns assets/icon.icns');

  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error('Missing deps. Run: npm install sharp png2icons --save-dev');
    } else {
      console.error(e.message);
    }
    process.exit(1);
  }
}

main();
