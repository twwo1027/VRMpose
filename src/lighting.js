import * as THREE from 'three';

const PRESETS = Object.freeze({
  studio: { intensity: 2.4, fill: 0.65, azimuth: -35, elevation: 45 },
  side: { intensity: 2.8, fill: 0.45, azimuth: -80, elevation: 35 },
  front: { intensity: 2.2, fill: 0.8, azimuth: 0, elevation: 35 },
});

const DEFAULTS = Object.freeze({ preset: 'studio', ...PRESETS.studio, shadows: true, groundShadow: true });
const LIMITS = Object.freeze({ intensity: [0, 5], fill: [0, 2], azimuth: [-180, 180], elevation: [5, 85] });

// A depth map cannot represent blended opacity. Casting the whole card would
// turn translucent hair/lashes into opaque rectangles; cutout passes retain
// the renderer's texture alpha-test support.
function canCastShadow(material) {
  return Boolean(material?.visible && !material.isOutline && material.opacity > 0 && (!material.transparent || material.alphaTest > 0));
}

function finiteBounds(box) {
  return box?.isBox3 && !box.isEmpty() && [...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite);
}

function corners(box) {
  const points = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z));
    }
  }
  return points;
}

/** Lighting and a transparent shadow catcher; neither belongs to editor helpers. */
export class StudioLighting {
  constructor({ scene, renderer }) {
    this.scene = scene;
    this.renderer = renderer;
    this.settings = { ...DEFAULTS };
    this._model = null;
    this._restBounds = null;
    this._meshState = new Map();
    this._disposed = false;
    this._previousShadowMap = {
      enabled: renderer.shadowMap.enabled,
      type: renderer.shadowMap.type,
      autoUpdate: renderer.shadowMap.autoUpdate,
    };

    this.group = new THREE.Group();
    this.group.name = 'Studio lighting';
    this.key = new THREE.DirectionalLight(0xfff2e2, DEFAULTS.intensity);
    this.key.name = 'Soft key light';
    this.key.castShadow = true;
    const mapSize = Math.min(2048, renderer.capabilities?.maxTextureSize || 2048);
    this.key.shadow.mapSize.set(mapSize, mapSize);
    this.key.shadow.radius = 3;
    this.key.shadow.intensity = 0.9;
    this.key.shadow.bias = -0.00008;
    this.fill = new THREE.HemisphereLight(0xdceaff, 0x646c80, DEFAULTS.fill);
    this.fill.name = 'Sky and floor fill';
    this.rim = new THREE.DirectionalLight(0xc9dcff, DEFAULTS.intensity * 0.2);
    this.rim.name = 'Soft rim light';
    this.group.add(this.key, this.key.target, this.fill, this.rim, this.rim.target);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.24, depthWrite: false }),
    );
    this.ground.name = 'Transparent ground shadow';
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.group.add(this.ground);
    scene.add(this.group);

    // r186 implements soft hardware PCF here; PCFSoftShadowMap was removed.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // A pose editor is static between edits. Explicit invalidation below keeps
    // shadows fresh while avoiding a second 2048 px render on every orbit frame.
    renderer.shadowMap.autoUpdate = false;
    this.key.shadow.autoUpdate = false;
    renderer.shadowMap.enabled = true;
    this._applySettings();
  }

  getSettings() { return { ...this.settings }; }

  setSettings(partial = {}) {
    if (!partial || typeof partial !== 'object') return this.getSettings();
    const next = { ...this.settings };
    if (Object.hasOwn(PRESETS, partial.preset)) {
      Object.assign(next, PRESETS[partial.preset], { preset: partial.preset });
    }
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      if (Number.isFinite(partial[key])) next[key] = THREE.MathUtils.clamp(partial[key], min, max);
    }
    for (const key of ['shadows', 'groundShadow']) {
      if (typeof partial[key] === 'boolean') next[key] = partial[key];
    }
    this.settings = next;
    this._applySettings();
    if (this._model) this.update(this._model);
    return this.getSettings();
  }

  _applySettings() {
    this.key.intensity = this.settings.intensity;
    this.fill.intensity = this.settings.fill;
    this.rim.intensity = this.settings.intensity * 0.2;
    this.key.castShadow = this.settings.shadows;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.key.shadow.needsUpdate = true;
    this.ground.visible = Boolean(this._model && this.settings.shadows && this.settings.groundShadow);
  }

  _restoreMeshes() {
    for (const [mesh, state] of this._meshState) {
      mesh.castShadow = state.castShadow;
      mesh.receiveShadow = state.receiveShadow;
      mesh.onBeforeShadow = state.onBeforeShadow;
      mesh.onAfterShadow = state.onAfterShadow;
    }
    this._meshState.clear();
  }

  _prepareMeshes(model) {
    model.traverse(mesh => {
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const existing = this._meshState.get(mesh);
      if (existing) {
        mesh.castShadow = materials.some(canCastShadow);
        return;
      }
      const state = {
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        onBeforeShadow: mesh.onBeforeShadow,
        onAfterShadow: mesh.onAfterShadow,
      };
      this._meshState.set(mesh, state);
      mesh.castShadow = materials.some(canCastShadow);
      mesh.receiveShadow = true;
      // MToon outlines usually share a mesh with the surface. Their extra
      // back-face pass must not thicken the caster or produce self-shadow acne.
      // Check every pass at draw time too: expressions can change opacity after
      // loading, and a mesh can mix opaque, cutout and blended material groups.
      {
        let previousDepthWrite;
        mesh.onBeforeShadow = function (...args) {
          state.onBeforeShadow.apply(this, args);
          const depthMaterial = args[5];
          const group = args[6];
          const surfaceMaterial = group && Array.isArray(this.material) ? this.material[group.materialIndex] : this.material;
          previousDepthWrite = undefined;
          if (!canCastShadow(surfaceMaterial)) {
            previousDepthWrite = depthMaterial.depthWrite;
            depthMaterial.depthWrite = false;
          }
        };
        mesh.onAfterShadow = function (...args) {
          if (previousDepthWrite !== undefined) args[5].depthWrite = previousDepthWrite;
          previousDepthWrite = undefined;
          state.onAfterShadow.apply(this, args);
        };
      }
    });
  }

  _currentBounds(model) {
    const bounds = new THREE.Box3();
    const meshBounds = new THREE.Box3();
    const vertex = new THREE.Vector3();
    model.updateMatrixWorld(true);
    model.traverseVisible(mesh => {
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!materials.some(material => material?.visible && !material.isOutline)) return;
      const position = mesh.geometry?.getAttribute('position');
      if (!position) return;
      meshBounds.makeEmpty();
      // getVertexPosition accounts for both current morph targets and skinning.
      // A cached geometry/object box otherwise clips shadows after a pose edit.
      for (let index = 0; index < position.count; index++) {
        mesh.getVertexPosition(index, vertex);
        meshBounds.expandByPoint(vertex);
      }
      if (mesh.isSkinnedMesh) {
        mesh.boundingBox ||= new THREE.Box3();
        mesh.boundingBox.copy(meshBounds);
      }
      meshBounds.applyMatrix4(mesh.matrixWorld);
      bounds.union(meshBounds);
    });
    return bounds;
  }

  update(vrmScene, { restBounds } = {}) {
    if (this._disposed) return;
    if (vrmScene !== this._model) {
      this._restoreMeshes();
      this._model = vrmScene || null;
      this._restBounds = null;
    }
    if (!this._model) {
      this.ground.visible = false;
      return;
    }
    this._prepareMeshes(this._model);
    const bounds = this._currentBounds(this._model);
    if (!finiteBounds(bounds)) {
      this.ground.visible = false;
      return;
    }
    if (finiteBounds(restBounds)) this._restBounds = restBounds.clone();
    this._restBounds ||= bounds.clone();
    const size = bounds.getSize(new THREE.Vector3());
    const restHeight = this._restBounds.max.y - this._restBounds.min.y;
    const modelScale = Math.max(size.x, size.y, size.z, restHeight, 0.1);
    const center = bounds.getCenter(new THREE.Vector3());
    const elevation = THREE.MathUtils.degToRad(this.settings.elevation);
    const azimuth = THREE.MathUtils.degToRad(this.settings.azimuth);
    const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    this.key.position.copy(center).addScaledVector(direction, modelScale * 3);
    this.key.target.position.copy(center);
    this.rim.position.copy(center).add(new THREE.Vector3(1, 1.1, -1.4).multiplyScalar(modelScale * 1.6));
    this.rim.target.position.copy(center);

    // The floor keeps its loaded-model height when hips or feet move. A raised
    // pose therefore casts its shadow down onto the same floor, not onto its feet.
    const floorY = this._restBounds.min.y - Math.max(restHeight, 0.1) * 0.0015;
    const modelCorners = corners(bounds);
    const groundBounds = new THREE.Box3();
    const projectedPoints = modelCorners.map(point => {
      const projection = point.clone().addScaledVector(direction, -Math.max(0, point.y - floorY) / direction.y);
      projection.y = floorY;
      groundBounds.expandByPoint(projection);
      groundBounds.expandByPoint(new THREE.Vector3(point.x, floorY, point.z));
      return projection;
    });
    const groundSize = groundBounds.getSize(new THREE.Vector3());
    const groundCenter = groundBounds.getCenter(new THREE.Vector3());
    this.ground.position.copy(groundCenter);
    this.ground.scale.set(Math.max(groundSize.x, modelScale * 0.5) + modelScale * 0.5, Math.max(groundSize.z, modelScale * 0.5) + modelScale * 0.5, 1);
    this.ground.visible = this.settings.shadows && this.settings.groundShadow;

    this.group.updateMatrixWorld(true);
    this.key.shadow.updateMatrices(this.key);
    const shadowCamera = this.key.shadow.camera;
    const viewBounds = new THREE.Box3();
    for (const point of [...modelCorners, ...(this.ground.visible ? projectedPoints : [])]) {
      viewBounds.expandByPoint(point.clone().applyMatrix4(shadowCamera.matrixWorldInverse));
    }
    const padding = modelScale * 0.055;
    const quantum = modelScale / 128;
    const width = Math.ceil((viewBounds.max.x - viewBounds.min.x + padding * 2) / quantum) * quantum;
    const height = Math.ceil((viewBounds.max.y - viewBounds.min.y + padding * 2) / quantum) * quantum;
    const texelX = width / this.key.shadow.mapSize.x;
    const texelY = height / this.key.shadow.mapSize.y;
    const x = Math.round((viewBounds.min.x + viewBounds.max.x) * 0.5 / texelX) * texelX;
    const y = Math.round((viewBounds.min.y + viewBounds.max.y) * 0.5 / texelY) * texelY;
    shadowCamera.left = x - width / 2;
    shadowCamera.right = x + width / 2;
    shadowCamera.bottom = y - height / 2;
    shadowCamera.top = y + height / 2;
    shadowCamera.near = Math.max(modelScale * 0.005, -viewBounds.max.z - padding);
    shadowCamera.far = Math.max(shadowCamera.near + modelScale, -viewBounds.min.z + padding);
    shadowCamera.updateProjectionMatrix();
    this.key.shadow.normalBias = modelScale * 0.0015;
    this.key.shadow.updateMatrices(this.key);
    this.key.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.bounds = bounds;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._restoreMeshes();
    this._model = null;
    this.group.removeFromParent();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.key.shadow.dispose();
    Object.assign(this.renderer.shadowMap, this._previousShadowMap);
    this.renderer.shadowMap.needsUpdate = true;
  }
}
