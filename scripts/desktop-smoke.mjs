import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeVRMFixture } from '../tests/helpers/vrm-fixture.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'vrmpose-electron-'));
let instance;
try {
  if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('Electronの実画面検証にはDISPLAYが必要です。Xvfbを起動してから実行してください。');
  const userData = path.join(temporary, 'user-data');
  await mkdir(userData);
  const harness = path.join(temporary, 'launch.cjs');
  await writeFile(harness, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(userData)});\nrequire(${JSON.stringify(path.resolve('electron/main.cjs'))});\n`);
  const options = {
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []), harness],
    env: { ...process.env, XDG_CACHE_HOME: path.join(temporary, 'cache'), XDG_CONFIG_HOME: path.join(temporary, 'config') },
  };
  instance = await electron.launch(options);
  let window = await instance.firstWindow();
  await window.waitForSelector('#vrm-input', { state: 'attached' });
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  await window.locator('#vrm-input').setInputFiles({ name: 'desktop-fixture.vrm', mimeType: 'application/octet-stream', buffer: makeVRMFixture('1') });
  await window.waitForFunction(() => !document.querySelector('#export-png').disabled);
  await window.locator('#pose-prompt').fill('右手を振って笑顔');
  await window.locator('#apply-local').click();
  await window.locator('#save-current').click();
  await window.locator('#save-name').fill('デスクトップ保存テスト');
  await window.locator('#save-submit').click();
  await window.waitForFunction(() => document.querySelector('#library-count').textContent === '1');
  const saved = await window.evaluate(() => window.desktop.listPoses());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pose.expressions.happy, 1);
  const pngPath = path.join(temporary, 'export.png');
  await instance.evaluate(({ dialog }, pngPath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: pngPath }); }, pngPath);
  await window.locator('#export-png').click();
  await window.waitForFunction(() => document.querySelector('#app-state').textContent.includes('透過PNGを書き出しました'), null, { timeout: 60000 });
  const png = await readFile(pngPath);
  assert.equal(png.readUInt32BE(16), 3840);
  assert.equal(png.readUInt32BE(20), 2160);
  await instance.close(); instance = undefined;
  instance = await electron.launch(options);
  window = await instance.firstWindow();
  await window.waitForFunction(() => document.querySelector('#library-count')?.textContent === '1');
  const afterRestart = await window.evaluate(() => window.desktop.listPoses());
  assert.deepEqual(afterRestart, saved);
  console.log('PASS: real Electron window, VRM load, free Japanese command, native library survives restart, native 3840×2160 PNG saved.');
} finally {
  if (instance) await instance.close();
  await rm(temporary, { recursive: true, force: true });
}
