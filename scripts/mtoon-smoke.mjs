import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { makeVRMFixture } from '../tests/helpers/vrm-fixture.mjs';

// Add actual MToon definitions to generated, asset-free VRM geometry. This
// exercises both loader compatibility paths, including generated outline passes.
function makeMToonFixture(version) {
  const fixture = makeVRMFixture(version);
  const jsonLength = fixture.readUInt32LE(12);
  const document = JSON.parse(fixture.subarray(20, 20 + jsonLength).toString());
  if (version === '1') {
    document.extensionsUsed.push('VRMC_materials_mtoon');
    document.materials[0].extensions = {
      VRMC_materials_mtoon: {
        specVersion: '1.0',
        shadeColorFactor: [0.2, 0.23, 0.3],
        shadingShiftFactor: 0,
        shadingToonyFactor: 0.7,
        giEqualizationFactor: 0.9,
        outlineWidthMode: 'worldCoordinates',
        outlineWidthFactor: 0.003,
        outlineColorFactor: [0.015, 0.02, 0.03],
        outlineLightingMixFactor: 0,
      },
    };
  } else {
    const material = document.extensions.VRM.materialProperties[0];
    material.shader = 'VRM/MToon';
    material.renderQueue = 2000;
    material.floatProperties = {
      _CullMode: 2, _BlendMode: 0, _ZWrite: 1, _ShadeShift: 0, _ShadeToony: 0.7,
      _IndirectLightIntensity: 0.1, _OutlineWidthMode: 1, _OutlineWidth: 0.3,
      _OutlineColorMode: 0,
    };
    material.vectorProperties = {
      _Color: [1, 1, 1, 1], _ShadeColor: [0.45, 0.48, 0.58, 1],
      _EmissionColor: [0, 0, 0, 1], _RimColor: [0, 0, 0, 1],
      _OutlineColor: [0.08, 0.1, 0.12, 1],
    };
  }
  const json = Buffer.from(JSON.stringify(document));
  const paddedJSON = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJSON);
  const binaryChunk = fixture.subarray(20 + jsonLength);
  const header = Buffer.from(fixture.subarray(0, 12));
  header.writeUInt32LE(20 + paddedJSON.length + binaryChunk.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJSON.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([header, jsonHeader, paddedJSON, binaryChunk]);
}

const server = await createServer({ server: { host: '127.0.0.1', port: 5182, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 }, deviceScaleFactor: 1 });
  // The desktop app has no web favicon; avoid Chromium's unrelated auto request.
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('http://127.0.0.1:5182/');
  await page.waitForSelector('#app button');
  const report = [];
  await mkdir('test-results', { recursive: true });
  for (const version of ['1', '0']) {
    const result = await page.evaluate(async ({ version, bytes }) => {
      const { PoseViewport } = await import('/src/viewport.js');
      const container = document.createElement('div');
      Object.assign(container.style, { position: 'fixed', width: '960px', height: '540px', top: '0', left: '0', zIndex: '10000' });
      document.body.append(container);
      const viewport = new PoseViewport(container);
      const shaderErrors = [];
      viewport.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        shaderErrors.push({ program: gl.getProgramInfoLog(program), vertex: gl.getShaderInfoLog(vertex), fragment: gl.getShaderInfoLog(fragment) });
      };
      try {
        await viewport.loadFile(new File([new Uint8Array(bytes)], `mtoon-${version}.vrm`));
        const materialTypes = [];
        viewport.vrm.scene.traverse(mesh => {
          if (!mesh.isMesh) return;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materialTypes.push(...materials.map(material => ({ mtoon: Boolean(material.isMToonMaterial), outline: Boolean(material.isOutline) })));
        });
        viewport.setAspect(16 / 9);
        viewport.setView('three-quarter');
        viewport.setBone('leftUpperArm', [0, 0, -60]);
        viewport.setBone('rightUpperArm', [0, 0, 45]);
        viewport.setExpression('happy', 0.8);
        viewport.setLighting({ azimuth: -55, elevation: 28, intensity: 2.8, fill: 0.25, shadows: false, groundShadow: false });
        async function pixelsFor(blob) {
          const image = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          image.close();
          return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, png: canvas.toDataURL('image/png').split(',')[1] };
        }
        const noShadows = await pixelsFor(await viewport.exportPNG({ width: 640, height: 360 }));
        viewport.setLighting({ shadows: true });
        const selfShadows = await pixelsFor(await viewport.exportPNG({ width: 640, height: 360 }));
        viewport.setLighting({ groundShadow: true });
        const groundShadows = await pixelsFor(await viewport.exportPNG({ width: 640, height: 360 }));
        let selfShadowPixels = 0, groundShadowPixels = 0, opaqueModelPixels = 0;
        for (let offset = 0; offset < noShadows.data.length; offset += 4) {
          if (selfShadows.data[offset + 3] > 200) opaqueModelPixels++;
          if (noShadows.data[offset + 3] > 200 && selfShadows.data[offset + 3] > 200 &&
              Math.abs(noShadows.data[offset] - selfShadows.data[offset]) + Math.abs(noShadows.data[offset + 1] - selfShadows.data[offset + 1]) + Math.abs(noShadows.data[offset + 2] - selfShadows.data[offset + 2]) > 12) selfShadowPixels++;
          if (selfShadows.data[offset + 3] === 0 && groundShadows.data[offset + 3] > 1) groundShadowPixels++;
        }
        const cornerAlphas = [0, 639, 359 * 640, 360 * 640 - 1].map(index => groundShadows.data[index * 4 + 3]);
        return {
          version, materialTypes, shaderErrors, selfShadowPixels, groundShadowPixels, opaqueModelPixels, cornerAlphas,
          shadowMap: [viewport.lighting.key.shadow.map.width, viewport.lighting.key.shadow.map.height],
          glError: viewport.renderer.getContext().getError(),
          png: { withoutShadows: noShadows.png, withShadows: groundShadows.png },
        };
      } finally { viewport.dispose(); container.remove(); }
    }, { version, bytes: Array.from(makeMToonFixture(version)) });
    assert.ok(result.materialTypes.some(material => material.mtoon && !material.outline), `VRM${version}: loader uses an actual MToon surface`);
    assert.ok(result.materialTypes.some(material => material.mtoon && material.outline), `VRM${version}: loader creates an actual MToon outline pass`);
    assert.deepEqual(result.shaderErrors, [], `VRM${version}: MToon shadow shaders compile and link`);
    assert.equal(result.glError, 0, `VRM${version}: WebGL rendering has no GL error`);
    assert.ok(result.opaqueModelPixels > 500, `VRM${version}: a visible MToon model is rendered`);
    assert.ok(result.selfShadowPixels > 20, `VRM${version}: shadow mapping visibly changes actual MToon model pixels (${result.selfShadowPixels})`);
    assert.ok(result.groundShadowPixels > 20, `VRM${version}: the model casts a transparent floor shadow (${result.groundShadowPixels})`);
    assert.deepEqual(result.cornerAlphas, [0, 0, 0, 0], `VRM${version}: PNG background remains transparent`);
    assert.deepEqual(result.shadowMap, [2048, 2048]);
    for (const [name, encoded] of Object.entries(result.png)) await writeFile(`test-results/mtoon-${version}-${name}.png`, Buffer.from(encoded, 'base64'));
    delete result.png;
    report.push(result);
  }
  assert.deepEqual(pageErrors, [], 'no browser runtime errors');
  assert.deepEqual(consoleErrors, [], 'no browser console or GPU shader errors');
  await writeFile('test-results/mtoon-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
