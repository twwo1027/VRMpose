import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeVRMFixture } from '../tests/helpers/vrm-fixture.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 5180, strictPort: true, hmr: false } });
let browser;

// Find a real rendered handle whose picker is hit by the same screen point.
// This keeps the mouse test independent of camera distance and gizmo size.
async function dragGizmo(page, { mode, axis, version, cancel = false }) {
  const points = await page.evaluate(({ mode, axis }) => {
    const { viewport } = window.__smoke;
    const control = viewport.transformControls;
    viewport.renderer.render(viewport.scene, viewport.camera);
    const bounds = viewport.canvas.getBoundingClientRect();
    const toScreen = point => {
      point.project(viewport.camera);
      return { x: bounds.left + (point.x + 1) * bounds.width / 2, y: bounds.top + (1 - point.y) * bounds.height / 2 };
    };
    const center = toScreen(control.object.getWorldPosition(control.object.position.clone()));
    const candidates = [];
    const ray = control.getRaycaster();
    for (const handle of control._gizmo.gizmo[mode].children) {
      if (handle.name !== axis || !handle.visible) continue;
      const position = handle.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index++) {
        const point = toScreen(control.object.position.clone().fromBufferAttribute(position, index).applyMatrix4(handle.matrixWorld));
        if (point.x < bounds.left + 4 || point.x > bounds.right - 4 || point.y < bounds.top + 4 || point.y > bounds.bottom - 4) continue;
        ray.setFromCamera(viewport._pointer.clone().set((point.x - bounds.left) / bounds.width * 2 - 1, -(point.y - bounds.top) / bounds.height * 2 + 1), viewport.camera);
        const hit = ray.intersectObject(control._gizmo.picker[mode], true).find(hit => hit.object.visible);
        if (hit?.object.name !== axis) continue;
        const dx = point.x - center.x, dy = point.y - center.y;
        const score = mode === 'rotate' ? Math.min(Math.abs(dx), Math.abs(dy)) : dx;
        candidates.push({ ...point, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) throw new Error(`No visible ${mode} ${axis} handle can be picked`);
    const start = candidates[0];
    let end;
    if (mode === 'rotate') {
      const dx = start.x - center.x, dy = start.y - center.y, angle = Math.PI / 6;
      end = { x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
    } else end = { x: start.x + 35, y: start.y };
    return { start, end, before: viewport.capturePose('ドラッグ'), callbacks: window.__smoke.changes.length };
  }, { mode, axis });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  const during = await page.evaluate(() => {
    const { viewport } = window.__smoke;
    return { dragging: viewport.transformControls.dragging, orbitEnabled: viewport.controls.enabled, cameraPosition: viewport.camera.position.toArray(), cameraTarget: viewport.controls.target.toArray() };
  });
  assert.ok(during.dragging, `VRM${version}: mouse grabs ${mode} ${axis} handle`);
  assert.equal(during.orbitEnabled, false, `VRM${version}: orbit stops during a gizmo drag`);
  await page.mouse.move(points.end.x, points.end.y, { steps: 10 });
  const dragCamera = await page.evaluate(() => ({ position: window.__smoke.viewport.camera.position.toArray(), target: window.__smoke.viewport.controls.target.toArray() }));
  assert.ok(dragCamera.position.every((value, index) => Math.abs(value - during.cameraPosition[index]) < 1e-8), `VRM${version}: gizmo pointer movement leaves the camera position fixed`);
  assert.ok(dragCamera.target.every((value, index) => Math.abs(value - during.cameraTarget[index]) < 1e-8), `VRM${version}: gizmo pointer movement leaves the camera target fixed`);
  if (cancel) {
    const moved = await page.evaluate(() => window.__smoke.viewport.capturePose('ドラッグ').bones.head);
    assert.ok(moved.some((angle, index) => Math.abs(angle - points.before.bones.head[index]) > 5), 'cancel test first changes the pose through a real drag');
    await page.keyboard.press('Escape');
  }
  await page.mouse.up();
  const after = await page.evaluate(() => ({ pose: window.__smoke.viewport.capturePose('ドラッグ'), callbacks: window.__smoke.changes.length, dragging: window.__smoke.viewport.transformControls.dragging, orbitEnabled: window.__smoke.viewport.controls.enabled }));
  assert.equal(after.dragging, false);
  assert.equal(after.orbitEnabled, true, `VRM${version}: orbit resumes after the drag`);
  assert.ok(after.callbacks > points.callbacks, `VRM${version}: pointer changes notify the editor`);
  if (cancel) assert.ok(after.pose.bones.head.every((angle, index) => Math.abs(angle - points.before.bones.head[index]) < 1e-7), `VRM${version}: Escape restores the pose from before the drag`);
  else if (mode === 'rotate') assert.ok(after.pose.bones.head.some((angle, index) => Math.abs(angle - points.before.bones.head[index]) > 5), `VRM${version}: real ring drag changes canonical head angles`);
  else assert.ok(after.pose.hipsPosition[0] > points.before.hipsPosition[0] + 0.01, `VRM${version}: real arrow drag translates canonical hips rightward`);
  return { axis, before: mode === 'rotate' ? points.before.bones.head : points.before.hipsPosition, after: mode === 'rotate' ? after.pose.bones.head : after.pose.hipsPosition, callbacks: after.callbacks - points.callbacks, ...(cancel ? { cancelled: true } : {}) };
}

async function checkOrbitMomentumLock(page, version) {
  const initial = await page.evaluate(() => {
    const { viewport } = window.__smoke;
    viewport.setEditMode('camera');
    viewport.setView('front');
    const bounds = viewport.canvas.getBoundingClientRect();
    return { position: viewport.camera.position.toArray(), x: bounds.left + 45, y: bounds.top + bounds.height * 0.75 };
  });
  await page.mouse.move(initial.x, initial.y);
  await page.mouse.down();
  await page.mouse.move(initial.x + 85, initial.y - 30, { steps: 2 });
  await page.mouse.up();
  const result = await page.evaluate(async () => {
    const { viewport } = window.__smoke;
    viewport.setInteractionEnabled(false);
    const snapshot = () => ({ position: viewport.camera.position.toArray(), target: viewport.controls.target.toArray() });
    const locked = snapshot();
    const frames = async () => { for (let index = 0; index < 3; index++) await new Promise(resolve => requestAnimationFrame(resolve)); };
    await frames();
    const afterLocked = snapshot();
    viewport.setInteractionEnabled(true);
    await frames();
    const afterUnlocked = snapshot();
    viewport.setView('front');
    viewport.setEditMode('rotate');
    return { locked, afterLocked, afterUnlocked };
  });
  assert.ok(result.locked.position.some((value, index) => Math.abs(value - initial.position[index]) > 0.01), `VRM${version}: blank-canvas mouse drag rotates the real camera`);
  for (const [state, snapshot] of Object.entries({ locked: result.afterLocked, resumed: result.afterUnlocked })) {
    for (const key of ['position', 'target']) assert.ok(snapshot[key].every((value, index) => Math.abs(value - result.locked[key][index]) < 1e-8), `VRM${version}: camera ${key} stays fixed while ${state} after orbit damping`);
  }
  return { cameraDrag: true, lockedWithoutDrift: true, resumedWithoutInertia: true };
}

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
    await page.evaluate(async ({ bytes, version }) => {
      const { PoseViewport } = await import('/src/viewport.js');
      const container = document.createElement('div');
      Object.assign(container.style, { position: 'fixed', width: '960px', height: '540px', top: '0', left: '0', zIndex: '10000' });
      document.body.append(container);
      const changes = [];
      const viewport = new PoseViewport(container, { onPoseChange: change => changes.push(change) });
      window.__smoke = { viewport, container, changes };
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
        window.__smoke.result = { version, bones: metadata.bones.length, expressions: metadata.expressions.map(x => x.key), before, after, weights, extras: extras.length, hairMoved, pose, reset, restored };
        viewport.setSelectedBone('head');
        viewport.setEditMode('rotate');
        viewport.setTransformSpace('world');
    }, { bytes: Array.from(makeVRMFixture(version)), version });
    const orbitMomentum = await checkOrbitMomentumLock(page, version);
    const rotationDrag = await dragGizmo(page, { mode: 'rotate', axis: 'Z', version });
    const cancelledDrag = await dragGizmo(page, { mode: 'rotate', axis: 'Z', version, cancel: true });
    await page.evaluate(() => {
      const { viewport } = window.__smoke;
      viewport.setEditMode('translate');
      viewport.setSelectedBone('hips');
      viewport.setTransformSpace('world');
      window.__smoke.hipsBefore = viewport.displayNodes.get('hips').getWorldPosition(viewport.displayNodes.get('hips').position.clone()).toArray();
    });
    const translationDrag = await dragGizmo(page, { mode: 'translate', axis: 'X', version });
    const result = await page.evaluate(async ({ version }) => {
      const { viewport, result } = window.__smoke;
      try {
        const gizmoPose = viewport.capturePose('操作ハンドルで作成');
        const hipsAfter = viewport.displayNodes.get('hips').getWorldPosition(viewport.displayNodes.get('hips').position.clone()).toArray();
        viewport.resetPose();
        viewport.applyPose(gizmoPose);
        const gizmoRestored = viewport.capturePose(gizmoPose.name);
        // The handle's world orientation must become the same canonical pose
        // as numeric input, including all three axes under a rotated parent.
        const proxyConversions = [];
        function checkProxyRotation(key, expected) {
          const before = [...viewport.boneValues.get(key)];
          viewport.setEditMode('rotate');
          viewport.setSelectedBone(key);
          viewport.setTransformSpace('local');
          viewport.setBone(key, expected);
          const node = viewport.boneNodes.get(key), rendered = viewport.displayNodes.get(key);
          const desired = node.getWorldQuaternion(node.quaternion.clone());
          const expectedRendered = rendered.getWorldQuaternion(rendered.quaternion.clone());
          viewport.setBone(key, [0, 0, 0]);
          const callbacks = window.__smoke.changes.length;
          viewport.transformControls.object.quaternion.copy(desired);
          viewport.transformControls.object.updateMatrixWorld(true);
          viewport.transformControls.dispatchEvent({ type: 'objectChange' });
          const actual = [...viewport.boneValues.get(key)];
          const actualRendered = rendered.getWorldQuaternion(rendered.quaternion.clone());
          proxyConversions.push({ key, expected, actual, renderedDifference: 1 - Math.abs(expectedRendered.dot(actualRendered)), callbacks: window.__smoke.changes.length - callbacks });
          viewport.setBone(key, before);
        }
        checkProxyRotation('leftLowerArm', [15, 25, -10]);
        const hairKey = [...viewport.boneNodes].find(([key, node]) => key.startsWith('extra:') && node.name === 'hairJoint')?.[0];
        checkProxyRotation(hairKey, [-15, 24, 9]);
        viewport.setEditMode('rotate');
        viewport.setSelectedBone('leftUpperArm');
        viewport.setTransformSpace('local');
        const localMode = viewport.getEditMode() === 'rotate' && viewport.getTransformSpace() === 'local';
        viewport.setInteractionEnabled(false);
        const controlsDisabled = !viewport.transformControls.enabled && !viewport.controls.enabled;
        viewport.setInteractionEnabled(true);
        viewport.setEditMode('camera');
        const cameraMode = viewport.getEditMode() === 'camera' && !viewport.transformHelper.visible && viewport.controls.enabled;
        viewport.setEditMode('rotate');

        // Compare the actual PNG pixels, rather than only checking light flags.
        viewport.setView('three-quarter');
        viewport.setLighting({ azimuth: -55, elevation: 28, intensity: 2.8, fill: 0.25, shadows: false, groundShadow: false });
        async function pixelsFor(blob) {
          const image = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          image.close();
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        const noShadows = await pixelsFor(await viewport.exportPNG({ width: 640, height: 360 }));
        viewport.setLighting({ shadows: true });
        const selfShadows = await pixelsFor(await viewport.exportPNG({ width: 640, height: 360 }));
        viewport.setLighting({ groundShadow: true });
        const groundShadows = await pixelsFor(await viewport.exportPNG({ width: 640, height: 360 }));
        let selfShadowPixels = 0, groundShadowPixels = 0;
        for (let offset = 0; offset < noShadows.length; offset += 4) {
          if (noShadows[offset + 3] > 200 && selfShadows[offset + 3] > 200 && Math.abs(noShadows[offset] - selfShadows[offset]) + Math.abs(noShadows[offset + 1] - selfShadows[offset + 1]) + Math.abs(noShadows[offset + 2] - selfShadows[offset + 2]) > 12) selfShadowPixels++;
          if (selfShadows[offset + 3] === 0 && groundShadows[offset + 3] > 1) groundShadowPixels++;
        }
        const lighting = viewport.getLighting();
        const key = viewport.lighting.key;
        const shadowMap = { requested: key.shadow.mapSize.toArray(), actual: key.shadow.map ? [key.shadow.map.width, key.shadow.map.height] : null };
        let casters = 0, receivers = 0;
        viewport.vrm.scene.traverse(node => { if (node.isMesh && node.visible && node.castShadow) casters++; if (node.isMesh && node.visible && node.receiveShadow) receivers++; });
        const groundShadowVisible = viewport.lighting.ground.visible;
        viewport.setLighting({ shadows: false });
        const groundDisabledWithShadows = !viewport.lighting.ground.visible;
        viewport.setLighting({ shadows: true });

        const oldWidth = viewport.canvas.width, oldHeight = viewport.canvas.height;
        const width = version === '1' ? 3840 : 2160, height = version === '1' ? 2160 : 3840;
        let exportHidesGizmo = false, exportHidesHelpers = false;
        const render = viewport.renderer.render;
        viewport.renderer.render = function (...args) {
          if (viewport._exporting) { exportHidesGizmo = !viewport.transformHelper.visible; exportHidesHelpers = !viewport.boneHelpers.visible && !viewport.grid.visible; }
          return render.apply(this, args);
        };
        const blob = await viewport.exportPNG({ width, height });
        viewport.renderer.render = render;
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
        const cornerAlphas = [0, width - 1, (height - 1) * width, width * height - 1].map(index => pixels[index * 4 + 3]);
        image.close();
        return {
          ...result, gizmoPose, gizmoRestored, hipsBefore: window.__smoke.hipsBefore, hipsAfter, proxyConversions, localMode, controlsDisabled, cameraMode,
          lighting, shadowMap, casters, receivers, groundShadowVisible, groundDisabledWithShadows, selfShadowPixels, groundShadowPixels, cornerAlphas,
          dimensions: [canvas.width, canvas.height], transparent, visible, firstPixel,
          pngSize: blob.size, viewRestored: oldWidth === viewport.canvas.width && oldHeight === viewport.canvas.height,
          helpersRestored: viewport.boneHelpers.visible && viewport.grid.visible && viewport.transformHelper.visible,
          exportHidesGizmo, exportHidesHelpers,
        };
      } finally { viewport.dispose(); window.__smoke.container.remove(); delete window.__smoke; }
    }, { version });
    assert.ok(result.bones >= 55, 'all humanoid bones detected');
    assert.ok(result.extras >= 4 && result.hairMoved, 'spring and extra bones permit manual editing');
    assert.ok(result.after[1] < result.before[1] - 0.1, `VRM${version}: left arm lowers in canonical coordinates`);
    assert.ok(result.weights.some(weight => Math.abs(weight - 0.8) < 0.001), 'expression changes actual mesh morph');
    assert.deepEqual(result.restored, result.pose, 'pose round trip including hips offset');
    assert.deepEqual(result.gizmoRestored, result.gizmoPose, 'gizmo rotation and translation survive pose save/restore');
    for (const conversion of result.proxyConversions) {
      assert.ok(conversion.actual.every((angle, index) => Math.abs(angle - conversion.expected[index]) < 1e-7), `VRM${version}: ${conversion.key} proxy rotation maps all three axes to canonical angles`);
      assert.ok(conversion.renderedDifference < 1e-8 && conversion.callbacks > 0, `VRM${version}: ${conversion.key} proxy changes the actual rig under its rotated parent`);
    }
    assert.ok(result.hipsAfter[0] > result.hipsBefore[0] + 0.01, `VRM${version}: translated normalized hips move the actual rig rightward`);
    assert.ok(result.localMode && result.controlsDisabled && result.cameraMode, 'local axes, loading/export interaction lock, and camera mode work');
    assert.deepEqual(result.reset.bones.leftUpperArm, [0, 0, 0]);
    assert.equal(result.reset.expressions.happy, 0);
    assert.deepEqual(result.dimensions, version === '1' ? [3840, 2160] : [2160, 3840]);
    assert.ok(result.transparent > result.dimensions[0] * result.dimensions[1] / 2, 'export background is transparent');
    assert.ok(result.visible > 1000, 'export contains the actual model');
    assert.equal(result.firstPixel[3], 0);
    assert.deepEqual(result.cornerAlphas, [0, 0, 0, 0], 'ground shadows retain a fully transparent PNG background');
    assert.ok(result.selfShadowPixels > 20, `VRM${version}: cast shadows visibly change the model (${result.selfShadowPixels} pixels)`);
    assert.ok(result.groundShadowPixels > 20, `VRM${version}: ground shadow appears on transparent pixels (${result.groundShadowPixels} pixels)`);
    assert.ok(result.casters > 0 && result.receivers > 0, 'model surfaces cast and receive shadows');
    assert.ok(result.groundShadowVisible && result.groundDisabledWithShadows, 'ground shadow follows both switches');
    assert.deepEqual(result.shadowMap.actual, result.shadowMap.requested, 'allocated shadow map uses configured resolution');
    assert.equal(result.lighting.intensity, 2.8);
    assert.ok(result.exportHidesGizmo && result.exportHidesHelpers, '4K export omits gizmos, markers and grid');
    assert.ok(result.pngSize > 10000);
    assert.ok(result.viewRestored && result.helpersRestored, 'export restores viewport and helpers');
    report.push({ version, bones: result.bones, dimensions: result.dimensions, transparentPixels: result.transparent, modelPixels: result.visible, pngBytes: result.pngSize, orbitMomentum, rotationDrag, cancelledDrag, translationDrag, proxyConversions: result.proxyConversions, selfShadowPixels: result.selfShadowPixels, groundShadowPixels: result.groundShadowPixels, shadowMap: result.shadowMap });
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/studio-empty.png', fullPage: true });
  await page.locator('#vrm-input').setInputFiles({ name: 'ui-fixture.vrm', mimeType: 'application/octet-stream', buffer: makeVRMFixture('1') });
  await page.waitForFunction(() => !document.querySelector('#export-png').disabled);
  await page.locator('#edit-camera').click();
  assert.equal(await page.locator('#edit-camera').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('#transform-space').isDisabled(), 'camera mode disables bone-axis selection');
  await page.locator('#edit-rotate').click();
  await page.locator('#transform-space').selectOption('world');
  await page.locator('#camera-view').selectOption('front');
  // Temporarily capture the existing UI instance on a normal bone selection.
  // The test never replaces the application callback: it records and forwards it.
  await page.evaluate(async () => {
    const { PoseViewport } = await import('/src/viewport.js');
    const original = PoseViewport.prototype.setSelectedBone;
    PoseViewport.prototype.setSelectedBone = function (...args) {
      PoseViewport.prototype.setSelectedBone = original;
      const callback = this.onPoseChange, changes = [];
      this.onPoseChange = change => { changes.push(change); callback?.(change); };
      window.__smoke = { viewport: this, changes, callback };
      return original.apply(this, args);
    };
  });
  await page.locator('#bone-select').selectOption('head');
  const uiRotationDrag = await dragGizmo(page, { mode: 'rotate', axis: 'Z', version: '1 UI' });
  assert.ok(Math.abs(Number(await page.locator('#rotation-z-number').inputValue())) > 5, 'preview ring drag updates the numeric bone inspector');
  await page.locator('#edit-translate').click();
  assert.equal(await page.locator('#bone-select').inputValue(), 'hips', 'translation mode selects the hips');
  const uiTranslationDrag = await dragGizmo(page, { mode: 'translate', axis: 'X', version: '1 UI' });
  assert.ok(Number(await page.locator('#position-x-number').inputValue()) > 0.01, 'preview arrow drag updates the numeric position inspector');
  await page.locator('#edit-rotate').click();
  await page.locator('#tab-lighting').click();
  await page.locator('#light-preset').selectOption('side');
  const sideSettings = await page.evaluate(() => window.__smoke.viewport.getLighting());
  assert.equal(sideSettings.preset, 'side');
  await page.locator('#light-azimuth-number').fill('17');
  await page.locator('#light-azimuth-number').press('Tab');
  await page.locator('#light-intensity-number').fill('2.5');
  await page.locator('#light-intensity-number').press('Tab');
  const editedSettings = await page.evaluate(() => window.__smoke.viewport.getLighting());
  assert.equal(editedSettings.azimuth, 17);
  assert.equal(editedSettings.intensity, 2.5);
  await page.locator('#light-shadows').uncheck();
  assert.ok(await page.locator('#light-ground-shadow').isDisabled(), 'disabling model shadows disables ground shadow control');
  await page.locator('#light-shadows').check();
  await page.locator('#light-ground-shadow').check();
  assert.ok((await page.evaluate(() => window.__smoke.viewport.getLighting())).groundShadow, 'lighting controls update the actual renderer');
  await page.screenshot({ path: 'test-results/studio-lighting.png', fullPage: true });
  await page.locator('#tab-bones').click();
  await page.locator('#reset-pose').click();
  await page.evaluate(() => { window.__smoke.viewport.onPoseChange = window.__smoke.callback; delete window.__smoke; });
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
  const ui = { manualEdit: true, previewRotation: uiRotationDrag, previewTranslation: uiTranslationDrag, lightingControls: true, expressionEdit: true, libraryRoundTrip: true, persistentLibrary: true, chatGPTPaste: true, pngDownload: true, responsive: true };
  await writeFile('test-results/smoke.json', JSON.stringify({ checkedAt: new Date().toISOString(), report, ui, pageErrors }, null, 2));
  console.log(JSON.stringify({ status: 'passed', report, ui }, null, 2));
} finally {
  if (browser) await browser.close();
  await server.close();
}
