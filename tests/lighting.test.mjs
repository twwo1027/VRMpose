import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StudioLighting } from '../src/lighting.js';

function makeLighting() {
  const scene = new THREE.Scene();
  const renderer = { shadowMap: { enabled: false, type: THREE.BasicShadowMap, autoUpdate: true }, capabilities: { maxTextureSize: 4096 } };
  return { scene, renderer, lighting: new StudioLighting({ scene, renderer }) };
}

function skinnedBox() {
  const geometry = new THREE.BoxGeometry(1, 1, 0.5);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) weights[index * 4] = 1;
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  return { mesh, bone };
}

test('posed skin and morph vertices remain inside the fitted light frustum', () => {
  const { lighting, scene, renderer } = makeLighting();
  const { mesh, bone } = skinnedBox();
  const model = new THREE.Group();
  model.add(mesh);
  scene.add(model);
  lighting.update(model);
  const rest = lighting.bounds.clone();
  const floorY = lighting.ground.position.y;
  // A hidden mesh and enormous editor lines do not enlarge the model lighting.
  const hiddenGroup = new THREE.Group();
  hiddenGroup.visible = false;
  hiddenGroup.add(new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshBasicMaterial()));
  model.add(hiddenGroup, new THREE.AxesHelper(1000));
  bone.position.set(4, 3, -2);
  const morph = mesh.geometry.getAttribute('position').clone();
  for (let index = 0; index < morph.count; index++) morph.setY(index, morph.getY(index) + 0.75);
  mesh.geometry.morphAttributes.position = [morph];
  mesh.updateMorphTargets();
  mesh.morphTargetInfluences[0] = 1;
  lighting.update(model, { restBounds: rest });
  assert.equal(lighting.ground.position.y, floorY);
  assert.equal(lighting.bounds.min.x, rest.min.x + 4);
  assert.equal(lighting.bounds.max.y, rest.max.y + 3.75);
  assert.ok(lighting.bounds.max.x < 10);
  assert.equal(mesh.castShadow, true);
  assert.equal(mesh.receiveShadow, true);
  assert.equal(renderer.shadowMap.needsUpdate, true);
  assert.equal(lighting.key.shadow.needsUpdate, true);
  for (const azimuth of [-180, -80, 0, 80, 180]) {
    for (const elevation of [5, 45, 85]) {
      lighting.setSettings({ azimuth, elevation });
      const vertex = new THREE.Vector3();
      for (let index = 0; index < mesh.geometry.getAttribute('position').count; index++) {
        mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld).project(lighting.key.shadow.camera);
        assert.ok(Math.abs(vertex.x) <= 1 && Math.abs(vertex.y) <= 1 && Math.abs(vertex.z) <= 1, `clipped vertex at ${azimuth}°, ${elevation}°: ${vertex.toArray()}`);
      }
    }
  }
  lighting.dispose();
});

test('transparent floor shadows can be toggled without disabling model shadows', () => {
  const { lighting, renderer } = makeLighting();
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial());
  lighting.update(model);
  assert.equal(renderer.shadowMap.type, THREE.PCFShadowMap);
  assert.equal(lighting.key.shadow.mapSize.x, 2048);
  assert.equal(lighting.ground.material.isShadowMaterial, true);
  assert.equal(lighting.ground.material.transparent, true);
  assert.equal(lighting.ground.material.depthWrite, false);
  assert.equal(lighting.ground.castShadow, false);
  assert.equal(lighting.ground.visible, true);
  lighting.setSettings({ groundShadow: false });
  assert.equal(lighting.ground.visible, false);
  assert.equal(lighting.key.castShadow, true);
  assert.equal(renderer.shadowMap.enabled, true);
  lighting.setSettings({ groundShadow: true, shadows: false });
  assert.equal(lighting.ground.visible, false);
  assert.equal(renderer.shadowMap.enabled, false);
  lighting.setSettings({ shadows: true });
  assert.equal(lighting.ground.visible, true);
  lighting.update(null);
  assert.equal(lighting.ground.visible, false);
  assert.equal(model.castShadow, false);
  assert.equal(model.receiveShadow, false);
  lighting.dispose();
});

test('MToon outline passes preserve rendering but cannot write shadow depth', () => {
  const { lighting, renderer } = makeLighting();
  const surface = new THREE.MeshBasicMaterial();
  const outline = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
  outline.isOutline = true;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [surface, outline]);
  let beforeCount = 0;
  let afterCount = 0;
  const before = () => beforeCount++;
  const after = () => afterCount++;
  mesh.onBeforeShadow = before;
  mesh.onAfterShadow = after;
  const model = new THREE.Group();
  const outlineOnly = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), outline);
  model.add(mesh, outlineOnly);
  lighting.update(model);
  assert.equal(mesh.castShadow, true);
  assert.equal(outlineOnly.castShadow, false);
  const depth = new THREE.MeshDepthMaterial();
  const args = [renderer, mesh, new THREE.Camera(), lighting.key.shadow.camera, mesh.geometry, depth, { materialIndex: 1 }];
  mesh.onBeforeShadow(...args);
  assert.equal(depth.depthWrite, false);
  assert.equal(outline.visible, true);
  mesh.onAfterShadow(...args);
  assert.equal(depth.depthWrite, true);
  args[6] = { materialIndex: 0 };
  mesh.onBeforeShadow(...args);
  assert.equal(depth.depthWrite, true);
  mesh.onAfterShadow(...args);
  assert.equal(beforeCount, 2);
  assert.equal(afterCount, 2);
  lighting.dispose();
  assert.equal(mesh.onBeforeShadow, before);
  assert.equal(mesh.onAfterShadow, after);
  assert.equal(mesh.castShadow, false);
  assert.equal(renderer.shadowMap.type, THREE.BasicShadowMap);
  assert.equal(renderer.shadowMap.autoUpdate, true);
});

test('lighting presets clamp invalid input and return independent settings', () => {
  const { lighting } = makeLighting();
  assert.deepEqual(lighting.setSettings({ preset: 'side' }), { preset: 'side', intensity: 2.8, fill: 0.45, azimuth: -80, elevation: 35, shadows: true, groundShadow: true });
  const settings = lighting.setSettings({ intensity: 100, fill: -10, azimuth: 500, elevation: -5, shadows: 'false' });
  assert.deepEqual(settings, { preset: 'side', intensity: 5, fill: 0, azimuth: 180, elevation: 5, shadows: true, groundShadow: true });
  settings.shadows = false;
  assert.equal(lighting.getSettings().shadows, true);
  lighting.setSettings({ preset: 'unknown', intensity: Number.NaN });
  assert.equal(lighting.getSettings().intensity, 5);
  lighting.dispose();
});

test('mixed opaque and cutout surfaces cast shadows while blended and invisible passes do not', () => {
  const { lighting, renderer } = makeLighting();
  const opaque = new THREE.MeshBasicMaterial();
  const cutout = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5 });
  const blended = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const zeroOpacity = new THREE.MeshBasicMaterial({ opacity: 0 });
  const materials = [opaque, cutout, blended, hidden, zeroOpacity];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  let beforeCount = 0, afterCount = 0;
  const before = () => beforeCount++, after = () => afterCount++;
  mesh.onBeforeShadow = before;
  mesh.onAfterShadow = after;
  const model = new THREE.Group();
  const card = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), blended);
  model.add(mesh, card);
  lighting.update(model);
  assert.equal(mesh.castShadow, true);
  assert.equal(card.castShadow, false);
  const depth = new THREE.MeshDepthMaterial();
  for (let index = 0; index < materials.length; index++) {
    const args = [renderer, mesh, new THREE.Camera(), lighting.key.shadow.camera, mesh.geometry, depth, { materialIndex: index }];
    mesh.onBeforeShadow(...args);
    assert.equal(depth.depthWrite, index < 2, `material pass ${index} shadow eligibility`);
    mesh.onAfterShadow(...args);
    assert.equal(depth.depthWrite, true, 'shared shadow material state is restored');
  }
  assert.equal(beforeCount, 5);
  assert.equal(afterCount, 5);
  // Material opacity/expression changes are reevaluated on the next pose update.
  opaque.opacity = 0;
  cutout.alphaTest = 0;
  lighting.update(model);
  assert.equal(mesh.castShadow, false);
  blended.alphaTest = 0.5;
  lighting.update(model);
  assert.equal(mesh.castShadow, true);
  assert.equal(card.castShadow, true);
  lighting.dispose();
  assert.equal(mesh.onBeforeShadow, before);
  assert.equal(mesh.onAfterShadow, after);
  assert.equal(mesh.castShadow, false);
  assert.equal(card.castShadow, false);
});
