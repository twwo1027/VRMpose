import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeVRMFixture } from '../tests/helpers/vrm-fixture.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 5180, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('http://127.0.0.1:5180/');
  await page.waitForSelector('#app button');
  const report = [];
  for (const version of ['1', '0']) {
    const result = await page.evaluate(async ({ bytes, version }) => {
      const { PoseViewport } = await import('/src/viewport.js');
      const container = document.createElement('div');
      Object.assign(container.style, { position: 'fixed', width: '960px', height: '540px', top: '0', left: '0', zIndex: '10000' });
      document.body.append(container);
      const viewport = new PoseViewport(container);
      try {
        const metadata = await viewport.loadFile(new File([new Uint8Array(bytes)], `fixture-${version}.vrm`));
        viewport.setAspect(16 / 9);
        viewport.setView('front');
        const hand = viewport.displayNodes.get('leftHand');
        const worldPosition = () => { const value = hand.position.clone(); hand.getWorldPosition(value); return value.toArray(); };
        const before = worldPosition();
        viewport.setBone('leftUpperArm', [0, 0, -60]);
        const after = worldPosition();
        viewport.setExpression('happy', 0.8);
        const extras = metadata.bones.filter(bone => bone.extra);
        const hair = extras.find(bone => bone.label === 'hairJoint');
        if (!hair) throw new Error('additional hair bone not exposed');
        viewport.setBone(hair.key, [20, 0, 10]);
        const hairNode = viewport.boneNodes.get(hair.key);
        const hairMoved = hairNode.matrixAutoUpdate && Math.abs(hairNode.quaternion.x) > 0.01;
        const weights = [];
        viewport.vrm.scene.traverse(node => { if (node.morphTargetInfluences) weights.push(...node.morphTargetInfluences); });
        viewport.setHipsPosition([0.05, -0.1, 0.02]);
        const pose = viewport.capturePose('復元テスト');
        viewport.resetPose();
        const reset = viewport.capturePose('初期値');
        viewport.applyPose(pose);
        const restored = viewport.capturePose(pose.name);
        viewport.setSelectedBone('leftUpperArm');
        const oldWidth = viewport.canvas.width, oldHeight = viewport.canvas.height;
        const width = version === '1' ? 3840 : 2160, height = version === '1' ? 2160 : 3840;
        const blob = await viewport.exportPNG({ width, height });
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        let transparent = 0, visible = 0;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (!pixels[offset]) transparent++;
          if (pixels[offset] > 200) visible++;
        }
        const firstPixel = Array.from(pixels.subarray(0, 4));
        image.close();
        return {
          version, bones: metadata.bones.length, expressions: metadata.expressions.map(x => x.key), before, after,
          weights, extras: extras.length, hairMoved, pose, reset, restored, dimensions: [canvas.width, canvas.height], transparent, visible, firstPixel,
          pngSize: blob.size, viewRestored: oldWidth === viewport.canvas.width && oldHeight === viewport.canvas.height,
          helpersRestored: viewport.boneHelpers.visible && viewport.grid.visible,
        };
      } finally { viewport.dispose(); container.remove(); }
    }, { bytes: Array.from(makeVRMFixture(version)), version });
    assert.ok(result.bones >= 55, 'all humanoid bones detected');
    assert.ok(result.extras >= 4 && result.hairMoved, 'spring and extra bones permit manual editing');
    assert.ok(result.after[1] < result.before[1] - 0.1, `VRM${version}: left arm lowers in canonical coordinates`);
    assert.ok(result.weights.some(weight => Math.abs(weight - 0.8) < 0.001), 'expression changes actual mesh morph');
    assert.deepEqual(result.restored, result.pose, 'pose round trip including hips offset');
    assert.deepEqual(result.reset.bones.leftUpperArm, [0, 0, 0]);
    assert.equal(result.reset.expressions.happy, 0);
    assert.deepEqual(result.dimensions, version === '1' ? [3840, 2160] : [2160, 3840]);
    assert.ok(result.transparent > result.dimensions[0] * result.dimensions[1] / 2, 'export background is transparent');
    assert.ok(result.visible > 1000, 'export contains the actual model');
    assert.equal(result.firstPixel[3], 0);
    assert.ok(result.pngSize > 10000);
    assert.ok(result.viewRestored && result.helpersRestored, 'export restores viewport and helpers');
    report.push({ version, bones: result.bones, dimensions: result.dimensions, transparentPixels: result.transparent, modelPixels: result.visible, pngBytes: result.pngSize });
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/studio-empty.png', fullPage: true });
  await page.locator('#vrm-input').setInputFiles({ name: 'ui-fixture.vrm', mimeType: 'application/octet-stream', buffer: makeVRMFixture('1') });
  await page.waitForFunction(() => !document.querySelector('#export-png').disabled);
  await page.locator('#pose-prompt').fill('右手を振って笑顔');
  await page.locator('#apply-local').click();
  await page.locator('#bone-select').selectOption('leftLowerArm');
  await page.locator('#rotation-y-number').fill('-45');
  await page.locator('#rotation-y-number').press('Tab');
  await page.locator('#tab-expressions').click();
  await page.locator('[data-expression-number="0"]').fill('0.65');
  await page.locator('[data-expression-number="0"]').press('Tab');
  await page.locator('#save-current').click();
  await page.locator('#save-name').fill('UIで編集したポーズ');
  await page.locator('#save-submit').click();
  await page.waitForFunction(() => document.querySelector('#library-count').textContent === '1');
  await page.locator('#reset-pose').click();
  await page.locator('.library-apply').first().click();
  await page.locator('#tab-bones').click();
  await page.locator('#bone-select').selectOption('leftLowerArm');
  assert.equal(await page.locator('#rotation-y-number').inputValue(), '-45');
  await page.locator('#tab-expressions').click();
  assert.equal(await page.locator('[data-expression-number="0"]').inputValue(), '0.65');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#library-count').textContent === '1');
  await page.locator('#vrm-input').setInputFiles({ name: 'ui-fixture.vrm', mimeType: 'application/octet-stream', buffer: makeVRMFixture('1') });
  await page.waitForFunction(() => !document.querySelector('#export-png').disabled);
  await page.locator('#mode-chatgpt').click();
  await page.locator('#chatgpt-result').fill(JSON.stringify({ name: 'ChatGPT貼付テスト', bones: [{ name: 'head', rotation: [15, 20, -10] }], expressions: [{ name: 'happy', value: 0.7 }] }));
  await page.locator('#apply-chatgpt').click();
  await page.locator('#bone-select').selectOption('head');
  assert.equal(await page.locator('#rotation-x-number').inputValue(), '15');
  assert.equal(await page.locator('#rotation-y-number').inputValue(), '20');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-png').click();
  const download = await downloadEvent;
  await download.saveAs('test-results/ui-export.png');
  await page.screenshot({ path: 'test-results/studio-model.png', fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop minimum width fits');
  await page.setViewportSize({ width: 768, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow window has no horizontal overflow');
  assert.deepEqual(pageErrors, [], 'no runtime errors in the editing screen');
  const ui = { manualEdit: true, expressionEdit: true, libraryRoundTrip: true, persistentLibrary: true, chatGPTPaste: true, pngDownload: true, responsive: true };
  await writeFile('test-results/smoke.json', JSON.stringify({ checkedAt: new Date().toISOString(), report, ui, pageErrors }, null, 2));
  console.log(JSON.stringify({ status: 'passed', report, ui }, null, 2));
} finally {
  if (browser) await browser.close();
  await server.close();
}
