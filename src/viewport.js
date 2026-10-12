import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { BONE_LABELS, EXPRESSION_LABELS, normalizePose } from '../shared/pose.mjs';
import { StudioLighting } from './lighting.js';

const radians = THREE.MathUtils.degToRad;
const boneOrder = Object.keys(BONE_LABELS);

function checkedVector(value, limit, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(number => !Number.isFinite(number) || Math.abs(number) > limit)) {
    throw new Error(`${label}の値が正しくありません。`);
  }
  return [...value];
}

/** A stopped VRM rig: posing never runs automatic gaze or spring-bone simulation. */
export class PoseViewport {
  constructor(container, { onBoneSelect, onPoseChange } = {}) {
    this.container = container;
    this.onBoneSelect = onBoneSelect;
    this.onPoseChange = onPoseChange;
    this.vrm = null;
    this.boneNodes = new Map();
    this.boneValues = new Map();
    this.boneDefaults = new Map();
    this.displayNodes = new Map();
    this.expressionValues = new Map();
    this.nodeConstraints = [];
    this.disabledConstraints = new Set();
    this.hipsPosition = [0, 0, 0];
    this.helpersEnabled = true;
    this.selectedBone = null;
    this.editMode = 'rotate';
    this.interactionEnabled = true;
    this.forcedAspect = null;
    this._disposed = false;
    this._exporting = false;
    this._loadSequence = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.camera.position.set(2.5, 1.8, 4.5);
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      throw new Error('3D表示を開始できません。WebGL 2 に対応した GPU・グラフィックドライバーが必要です。');
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '3Dプレビュー。ボーンの点を選び、色付きのリングで回転。空白のドラッグでカメラを回転、ホイールで拡大縮小。');
    Object.assign(this.canvas.style, { display: 'block', position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.canvas);

    this.lighting = new StudioLighting({ scene: this.scene, renderer: this.renderer });

    this.grid = new THREE.GridHelper(6, 30, 0x53677e, 0x293847);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.42;
    this.scene.add(this.grid);
    this._createPlaceholder();
    this._createBoneHelpers();
    // Install gizmo listeners first so grabbing a handle cannot start an orbit.
    this._createTransformControls();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 30;
    this.controls.update();

    this._onPointerDown = event => {
      this._activePointerId = event.pointerId;
      this._pointerDown = { x: event.clientX, y: event.clientY, button: event.button };
    };
    this._onPointerUp = event => { this._activePointerId = null; this._pickBone(event); };
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();
    this._animate = time => {
      if (this._disposed) return;
      this._animationFrame = requestAnimationFrame(this._animate);
      if (this._exporting) return;
      if (this.placeholder.visible) this.placeholder.rotation.y = time * 0.00012;
      if (this.controls.enabled && !this.transformControls.dragging) this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this._animationFrame = requestAnimationFrame(this._animate);
  }

  get hasModel() { return Boolean(this.vrm); }

  _stopOrbitMomentum() {
    if (!this.controls) return;
    const position = this.camera.position.clone();
    const quaternion = this.camera.quaternion.clone();
    const target = this.controls.target.clone();
    const damping = this.controls.enableDamping;
    // Consume pending orbit/pan deltas using the public API, then keep the
    // exact view the user had when editing or exporting began.
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(position);
    this.camera.quaternion.copy(quaternion);
    this.controls.target.copy(target);
    this.controls.enableDamping = damping;
    this.controls.update();
  }

  _createTransformControls() {
    // VRM normalized nodes are edited, while markers follow the rendered rig.
    // A proxy lets both rigs share a handle without directly modifying raw bones.
    this.transformProxy = new THREE.Object3D();
    this.transformProxy.name = 'Bone editing proxy';
    this.scene.add(this.transformProxy);
    this.transformControls = new TransformControls(this.camera, this.canvas);
    this.transformControls.setMode('rotate');
    this.transformControls.setSpace('local');
    this.transformControls.setSize(0.85);
    this.transformHelper = this.transformControls.getHelper();
    this.scene.add(this.transformHelper);
    this.transformControls.addEventListener('dragging-changed', event => {
      if (this.controls) this.controls.enabled = this.interactionEnabled && !this._exporting && !event.value;
      if (!event.value) {
        this._transformStart = null;
        this._syncTransform();
      }
    });
    this.transformControls.addEventListener('mouseDown', () => {
      this._stopOrbitMomentum();
      this._gizmoPointer = true;
      const node = this.boneNodes.get(this.selectedBone);
      if (node) this._transformStart = { position: node.position.clone(), proxyPosition: this.transformProxy.position.clone() };
    });
    this.transformControls.addEventListener('objectChange', () => this._applyTransform());
    this._onPointerCancel = () => {
      if (this.transformControls.dragging) {
        this.transformControls.reset();
        this.transformControls.pointerUp(null);
      }
      if (this._activePointerId != null && this.canvas.hasPointerCapture(this._activePointerId)) this.canvas.releasePointerCapture(this._activePointerId);
      this._activePointerId = null;
      // Remove temporary move listeners and reset any active camera gesture.
      // Reconnect in the same order so the gizmo still takes priority.
      this.transformControls.disconnect();
      this.controls?.disconnect();
      this.transformControls.connect(this.canvas);
      this.controls?.connect(this.canvas);
      this._pointerDown = null;
      this._gizmoPointer = false;
    };
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this._onKeyDown = event => {
      if (event.key === 'Escape' && this.transformControls.dragging) {
        event.preventDefault();
        this._onPointerCancel();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  _syncTransform() {
    if (this.transformControls.dragging || this._exporting) return;
    const node = this.boneNodes.get(this.selectedBone);
    if (!node || this.editMode === 'camera' || !this.interactionEnabled || (this.editMode === 'translate' && this.selectedBone !== 'hips')) {
      this.transformControls.detach();
      return;
    }
    this.scene.updateMatrixWorld(true);
    this.displayNodes.get(this.selectedBone).getWorldPosition(this.transformProxy.position);
    // Use the same normalized axes as the angle sliders, including VRM 0's
    // facing correction. Extra hair/clothing bones retain their own rest axes.
    node.getWorldQuaternion(this.transformProxy.quaternion);
    this.transformProxy.updateMatrixWorld(true);
    this.transformControls.attach(this.transformProxy);
  }

  _applyTransform() {
    if (!this.interactionEnabled || this._exporting || !this.hasModel) return;
    const key = this.selectedBone;
    const node = this.boneNodes.get(key);
    if (!node) return;
    if (this.editMode === 'rotate') {
      const parentRotation = node.parent?.getWorldQuaternion(new THREE.Quaternion()) || new THREE.Quaternion();
      const local = parentRotation.invert().multiply(this.transformProxy.quaternion);
      const offset = this.boneDefaults.get(key).clone().invert().multiply(local);
      const euler = new THREE.Euler().setFromQuaternion(offset.normalize(), 'XYZ');
      const angles = [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg);
      if (this.isVRM0 && !key.startsWith('extra:')) { angles[0] *= -1; angles[2] *= -1; }
      this.setBone(key, angles);
    } else if (this.editMode === 'translate' && key === 'hips') {
      const start = this._transformStart;
      // Also support keyboard/programmatic handle changes outside a drag.
      const origin = start?.proxyPosition || this.displayNodes.get(key).getWorldPosition(new THREE.Vector3());
      const startPosition = start?.position || node.position;
      const desired = this.transformProxy.position.clone();
      const previous = origin.clone();
      if (node.parent) { node.parent.worldToLocal(desired); node.parent.worldToLocal(previous); }
      const offset = desired.sub(previous).add(startPosition).sub(this.hipsDefault);
      const position = [this.isVRM0 ? -offset.x : offset.x, offset.y, this.isVRM0 ? -offset.z : offset.z].map(value => THREE.MathUtils.clamp(value, -5, 5));
      this.setHipsPosition(position);
    } else return;
    this.onPoseChange?.(key);
  }

  setEditMode(mode) {
    if (!['rotate', 'translate', 'camera'].includes(mode)) return;
    if (this.transformControls.dragging) this._onPointerCancel();
    this.editMode = mode;
    this.transformControls.setMode(mode === 'translate' ? 'translate' : 'rotate');
    if (mode === 'translate' && this.hasModel && this.selectedBone !== 'hips') {
      this.setSelectedBone('hips');
      this.onBoneSelect?.('hips');
    }
    this._syncTransform();
  }

  getEditMode() { return this.editMode; }
  setTransformSpace(space) {
    if (['local', 'world'].includes(space)) this.transformControls.setSpace(space);
  }
  getTransformSpace() { return this.transformControls.space; }
  setInteractionEnabled(enabled) {
    if (!enabled && this.interactionEnabled) {
      this._onPointerCancel();
      this._stopOrbitMomentum();
    }
    this.interactionEnabled = Boolean(enabled);
    this.transformControls.enabled = this.interactionEnabled;
    this.controls.enabled = this.interactionEnabled && !this._exporting;
    this._syncTransform();
  }
  setLighting(settings) { return this.lighting.setSettings(settings); }
  getLighting() { return this.lighting.getSettings(); }

  _createPlaceholder() {
    this.placeholder = new THREE.Group();
    this.placeholder.position.y = 0.85;
    const solid = new THREE.IcosahedronGeometry(0.36, 1);
    const edges = new THREE.EdgesGeometry(solid);
    solid.dispose();
    this.placeholder.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x82b4d5, transparent: true, opacity: 0.65 })));
    for (let index = 0; index < 3; index++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.57 + index * 0.04, 0.004, 6, 96), new THREE.MeshBasicMaterial({ color: index === 1 ? 0xb8a083 : 0x7298b7, transparent: true, opacity: 0.45 }));
      ring.rotation.set(index === 0 ? Math.PI / 2 : 0.3 + index, index * 0.7, index * 0.5);
      this.placeholder.add(ring);
    }
    this.scene.add(this.placeholder);
  }

  _createBoneHelpers() {
    this.boneHelpers = new THREE.Group();
    this.boneHelpers.visible = false;
    this.scene.add(this.boneHelpers);
    this.markerGeometry = new THREE.SphereGeometry(1, 8, 6);
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: 0x96cbdc, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false });
    this.selectedMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xffcf82, depthTest: false, depthWrite: false });
    this.boneLineMaterial = new THREE.LineBasicMaterial({ color: 0x80b5c8, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false });
    this.boneLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.boneLineMaterial);
    this.boneLines.renderOrder = 9;
    this.boneHelpers.add(this.boneLines);
    this.selectionAxes = new THREE.AxesHelper(0.2);
    for (const material of Array.isArray(this.selectionAxes.material) ? this.selectionAxes.material : [this.selectionAxes.material]) {
      material.depthTest = false;
      material.depthWrite = false;
    }
    this.selectionAxes.renderOrder = 11;
    this.selectionAxes.visible = false;
    this.boneHelpers.add(this.selectionAxes);
    this.markers = new Map();
    this._worldPosition = new THREE.Vector3();
    this._worldQuaternion = new THREE.Quaternion();
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
  }

  _resize() {
    if (this._disposed || this._exporting) return;
    const bounds = this.container.getBoundingClientRect();
    let width = Math.max(1, bounds.width);
    let height = Math.max(1, bounds.height);
    if (this.forcedAspect) {
      width = Math.min(width, height * this.forcedAspect);
      height = width / this.forcedAspect;
    }
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setAspect(aspect) {
    if (aspect !== null && (!Number.isFinite(aspect) || aspect <= 0)) throw new Error('画像の縦横比が正しくありません。');
    this.forcedAspect = aspect;
    this._resize();
  }

  async loadFile(file) {
    if (this._disposed) throw new Error('3D表示は終了しています。');
    const sequence = ++this._loadSequence;
    const manager = new THREE.LoadingManager();
    // A portable VRM must contain its textures and buffers inside the file.
    manager.setURLModifier(url => {
      if (/^(data:|blob:)/i.test(url)) return url;
      throw new Error('外部ファイルを参照するモデルです。テクスチャを埋め込んだ単一の VRM ファイルを選んでください。');
    });
    const loader = new GLTFLoader(manager);
    loader.register(parser => new VRMLoaderPlugin(parser));
    let gltf;
    try {
      gltf = await loader.parseAsync(await file.arrayBuffer(), '');
    } catch (error) {
      throw new Error(`VRMを読み込めませんでした。${error?.message || 'ファイルが破損している可能性があります。'}`);
    }
    const vrm = gltf.userData.vrm;
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error('このファイルには VRM 0.x / 1.0 のモデル情報がありません。');
    }
    if (this._disposed || sequence !== this._loadSequence) {
      VRMUtils.deepDispose(vrm.scene);
      throw new Error('モデルの読み込みを中止しました。');
    }
    VRMUtils.rotateVRM0(vrm);
    // The original skin bounds become stale when a pose moves its vertices.
    vrm.scene.traverse(object => { if (object.isSkinnedMesh) object.frustumCulled = false; });
    vrm.humanoid.autoUpdateHumanBones = true;
    vrm.humanoid.resetNormalizedPose();
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    const auxiliaryNodes = new Set();
    for (const joint of vrm.springBoneManager?.joints || []) {
      // The spring loader disables normal matrix updates; restore them for
      // manual editing even when the joint is an ordinary Object3D, not Bone.
      joint.bone.matrixAutoUpdate = true;
      auxiliaryNodes.add(joint.bone);
      if (joint.child) auxiliaryNodes.add(joint.child);
    }
    for (const constraint of vrm.nodeConstraintManager?.constraints || []) {
      auxiliaryNodes.add(constraint.source);
      auxiliaryNodes.add(constraint.destination);
    }
    vrm.humanoid.update();
    vrm.expressionManager?.update();
    vrm.scene.updateMatrixWorld(true);

    this._clearModel();
    this.vrm = vrm;
    this.isVRM0 = vrm.meta?.metaVersion === '0';
    this.nodeConstraints = [...(vrm.nodeConstraintManager?.constraints || [])];
    this.scene.add(vrm.scene);
    this.placeholder.visible = false;
    const rawHumanoidNodes = new Set();
    const normalizedNodes = new Set();
    const bones = [];
    for (const key of boneOrder) {
      const node = vrm.humanoid.getNormalizedBoneNode(key);
      const rawNode = vrm.humanoid.getRawBoneNode(key);
      if (rawNode) rawHumanoidNodes.add(rawNode);
      if (!node) continue;
      normalizedNodes.add(node);
      this._registerBone(key, node, rawNode || node);
      bones.push({ key, label: BONE_LABELS[key] });
    }
    const visit = (node, path) => {
      if ((node.isBone || auxiliaryNodes.has(node)) && !rawHumanoidNodes.has(node) && !normalizedNodes.has(node)) {
        const key = `extra:${path.join('/')}`;
        this._registerBone(key, node, node);
        bones.push({ key, label: node.name || `追加ボーン ${bones.length + 1}`, extra: true });
      }
      node.children.forEach((child, index) => visit(child, [...path, index]));
    };
    visit(vrm.scene, []);
    const expressions = [];
    for (const expression of vrm.expressionManager?.expressions || []) {
      const key = expression.expressionName;
      if (!key) continue;
      this.expressionValues.set(key, 0);
      vrm.expressionManager.setValue(key, 0);
      expressions.push({ key, label: Object.hasOwn(EXPRESSION_LABELS, key) ? EXPRESSION_LABELS[key] : key });
    }
    const hips = this.boneNodes.get('hips');
    this.hipsDefault = hips?.position.clone() || new THREE.Vector3();
    this.hipsPosition = [0, 0, 0];
    this.modelName = vrm.meta?.name || vrm.meta?.title || file.name.replace(/\.vrm$/i, '');
    this._updateModel();
    const box = new THREE.Box3().setFromObject(vrm.scene);
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.7, 0, -0.3), new THREE.Vector3(0.7, 1.7, 0.3));
    this.modelBounds = box;
    this.modelHeight = Math.max(box.max.y - box.min.y, 0.1);
    this.lighting.update(vrm.scene, { restBounds: box });
    this.grid.position.y = box.min.y - 0.005;
    this._buildMarkers();
    this.setView('front');
    this.setHelpers(this.helpersEnabled);
    return { name: this.modelName, bones, expressions, version: vrm.meta?.metaVersion || '1' };
  }

  _registerBone(key, node, displayNode) {
    this.boneNodes.set(key, node);
    this.displayNodes.set(key, displayNode);
    this.boneDefaults.set(key, node.quaternion.clone());
    this.boneValues.set(key, [0, 0, 0]);
  }

  _buildMarkers() {
    for (const [key] of this.displayNodes) {
      const marker = new THREE.Mesh(this.markerGeometry, this.markerMaterial);
      marker.userData.boneKey = key;
      marker.renderOrder = 10;
      marker.scale.setScalar(this.modelHeight * 0.009);
      this.boneHelpers.add(marker);
      this.markers.set(key, marker);
    }
    this.selectionAxes.scale.setScalar(this.modelHeight / 1.7);
    this._updateHelpers();
  }

  _updateHelpers() {
    if (!this.vrm) return;
    this.scene.updateMatrixWorld(true);
    const positions = [];
    const knownNodes = new Set(this.displayNodes.values());
    for (const [key, node] of this.displayNodes) {
      node.getWorldPosition(this._worldPosition);
      this.markers.get(key)?.position.copy(this._worldPosition);
      let parent = node.parent;
      while (parent && !knownNodes.has(parent)) parent = parent.parent;
      if (parent) {
        positions.push(this._worldPosition.x, this._worldPosition.y, this._worldPosition.z);
        parent.getWorldPosition(this._worldPosition);
        positions.push(this._worldPosition.x, this._worldPosition.y, this._worldPosition.z);
      }
    }
    this.boneLines.geometry.dispose();
    this.boneLines.geometry = new THREE.BufferGeometry();
    this.boneLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const selectedNode = this.displayNodes.get(this.selectedBone);
    this.selectionAxes.visible = Boolean(selectedNode);
    if (selectedNode) {
      selectedNode.getWorldPosition(this.selectionAxes.position);
      selectedNode.getWorldQuaternion(this.selectionAxes.quaternion);
    }
  }

  _updateModel() {
    if (!this.vrm) return;
    // Deliberately do not call vrm.update(): that would overwrite manually posed
    // hair, clothing and gaze with automatic spring-bone / look-at motion.
    this.vrm.humanoid.update();
    this.vrm.expressionManager?.update();
    const manager = this.vrm.nodeConstraintManager;
    if (manager) {
      const manuallyPosed = new Set();
      for (const [key, angles] of this.boneValues) {
        if (angles.every(angle => Math.abs(angle) < 1e-8)) continue;
        if (key.startsWith('extra:')) this._setBoneWithoutUpdate(key, angles);
        // Humanoid controls edit normalized nodes, while constraints target
        // raw nodes. Protect their corresponding raw destination as well.
        manuallyPosed.add(this.displayNodes.get(key) || this.boneNodes.get(key));
      }
      // Keep authored twist/roll/aim behavior, releasing only destinations
      // explicitly posed by the user. Removing their constraint through the
      // public manager also lets dependent constraints see the manual source.
      for (const constraint of this.nodeConstraints) {
        if (manuallyPosed.has(constraint.destination)) {
          if (!this.disabledConstraints.has(constraint)) {
            manager.deleteConstraint(constraint);
            this.disabledConstraints.add(constraint);
          }
        } else if (this.disabledConstraints.has(constraint)) {
          manager.addConstraint(constraint);
          this.disabledConstraints.delete(constraint);
        }
      }
      manager.update();
    }
    for (const material of this.vrm.materials || []) material.update?.(0);
    this.vrm.scene.updateMatrixWorld(true);
    this._updateHelpers();
    this._syncTransform();
    this.lighting.update(this.vrm.scene);
  }

  _setBoneWithoutUpdate(key, degrees) {
    const node = this.boneNodes.get(key);
    if (!node) return false;
    const angles = checkedVector(degrees, 180, 'ボーン角度');
    // VRM 0 faces -Z before rotateVRM0. Convert its normalized rig axes so
    // saved/AI humanoid angles always use the same +Z-facing VRM 1 convention.
    const rigAngles = this.isVRM0 && !key.startsWith('extra:') ? [-angles[0], angles[1], -angles[2]] : angles;
    const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rigAngles.map(radians), 'XYZ'));
    node.quaternion.copy(this.boneDefaults.get(key)).multiply(offset);
    this.boneValues.set(key, angles);
    return true;
  }

  setBone(key, degrees) {
    if (this._setBoneWithoutUpdate(key, degrees)) this._updateModel();
  }

  setExpression(key, value) {
    if (!this.expressionValues.has(key)) return;
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('表情は 0〜1 の範囲で指定してください。');
    this.expressionValues.set(key, value);
    this.vrm.expressionManager.setValue(key, value);
    this._updateModel();
  }

  setHipsPosition(position) {
    this.hipsPosition = checkedVector(position, 5, '腰の移動量');
    const hips = this.boneNodes.get('hips');
    if (hips) hips.position.copy(this.hipsDefault).add(this._hipsOffset(this.hipsPosition));
    this._updateModel();
  }

  _hipsOffset(position) {
    return new THREE.Vector3(this.isVRM0 ? -position[0] : position[0], position[1], this.isVRM0 ? -position[2] : position[2]);
  }

  resetPose() {
    if (!this.vrm) return;
    for (const key of this.boneNodes.keys()) this._setBoneWithoutUpdate(key, [0, 0, 0]);
    for (const key of this.expressionValues.keys()) {
      this.expressionValues.set(key, 0);
      this.vrm.expressionManager.setValue(key, 0);
    }
    this.hipsPosition = [0, 0, 0];
    this.boneNodes.get('hips')?.position.copy(this.hipsDefault);
    this._updateModel();
  }

  applyPose(input) {
    if (!this.vrm) throw new Error('先に VRM ファイルを読み込んでください。');
    const pose = normalizePose(input);
    this.resetPose();
    for (const [key, degrees] of Object.entries(pose.bones)) this._setBoneWithoutUpdate(key, degrees);
    for (const [key, degrees] of Object.entries(pose.extraBones)) this._setBoneWithoutUpdate(key, degrees);
    for (const [key, value] of Object.entries(pose.expressions)) {
      if (!this.expressionValues.has(key)) continue;
      this.expressionValues.set(key, value);
      this.vrm.expressionManager.setValue(key, value);
    }
    this.hipsPosition = [...pose.hipsPosition];
    this.boneNodes.get('hips')?.position.copy(this.hipsDefault).add(this._hipsOffset(pose.hipsPosition));
    this._updateModel();
  }

  capturePose(name = '無題のポーズ') {
    if (!this.vrm) throw new Error('先に VRM ファイルを読み込んでください。');
    const bones = {}, extraBones = {};
    for (const [key, degrees] of this.boneValues) (key.startsWith('extra:') ? extraBones : bones)[key] = [...degrees];
    return normalizePose({ version: 1, name, bones, extraBones, expressions: Object.fromEntries(this.expressionValues), hipsPosition: [...this.hipsPosition] });
  }

  setView(view) {
    this._stopOrbitMomentum();
    const directions = {
      front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], 'three-quarter': [0.75, 0.1, 1],
    };
    const direction = new THREE.Vector3(...(directions[view] || directions.front)).normalize();
    const bounds = this.modelBounds || new THREE.Box3(new THREE.Vector3(-0.65, 0, -0.65), new THREE.Vector3(0.65, 1.7, 0.65));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const verticalFov = radians(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const horizontalExtent = Math.abs(direction.z) * size.x + Math.abs(direction.x) * size.z;
    const distance = Math.max(size.y / (2 * Math.tan(verticalFov / 2)), horizontalExtent / (2 * Math.tan(horizontalFov / 2)), 0.5) * 1.2 + Math.max(size.x, size.z) * 0.3;
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.up.set(0, 1, 0);
    this.camera.zoom = 1;
    this.camera.near = Math.max(0.005, distance / 1000);
    this.camera.far = Math.max(100, distance * 100);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  setHelpers(enabled) {
    this.helpersEnabled = Boolean(enabled);
    this.grid.visible = this.helpersEnabled;
    this.boneHelpers.visible = this.helpersEnabled && this.hasModel;
  }

  setSelectedBone(key) {
    if (this.transformControls.dragging) this._onPointerCancel();
    this.selectedBone = this.boneNodes.has(key) ? key : null;
    for (const [markerKey, marker] of this.markers) {
      marker.material = markerKey === this.selectedBone ? this.selectedMarkerMaterial : this.markerMaterial;
      marker.scale.setScalar(this.modelHeight * (markerKey === this.selectedBone ? 0.014 : 0.009));
    }
    this._updateHelpers();
    this._syncTransform();
  }

  _pickBone(event) {
    const down = this._pointerDown;
    this._pointerDown = null;
    const gizmoPointer = this._gizmoPointer;
    this._gizmoPointer = false;
    if (gizmoPointer || !this.interactionEnabled || this._exporting) return;
    if (!down || down.button !== 0 || !this.boneHelpers.visible || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const bounds = this.canvas.getBoundingClientRect();
    this._pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const result = this._raycaster.intersectObjects([...this.markers.values()], false)[0];
    if (result) {
      const key = result.object.userData.boneKey;
      this.setSelectedBone(key);
      this.onBoneSelect?.(key);
    }
  }

  async exportPNG({ width = 3840, height = 2160 } = {}) {
    if (!this.vrm) throw new Error('先に VRM ファイルを読み込んでください。');
    if (this._exporting) throw new Error('画像を書き出しています。完了までお待ちください。');
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error('画像サイズは 1〜8192 ピクセルで指定してください。');
    const context = this.renderer.getContext();
    const maximum = Math.min(context.getParameter(context.MAX_TEXTURE_SIZE), context.getParameter(context.MAX_RENDERBUFFER_SIZE));
    if (width > maximum || height > maximum) throw new Error(`この GPU の画像サイズ上限は ${maximum} ピクセルです。`);
    if (this.transformControls.dragging) {
      this.transformControls.pointerUp(null);
      this._onPointerCancel();
    }
    this._stopOrbitMomentum();
    const oldSize = this.renderer.getSize(new THREE.Vector2());
    const oldPixelRatio = this.renderer.getPixelRatio();
    const gridVisible = this.grid.visible;
    const helperVisible = this.boneHelpers.visible;
    const placeholderVisible = this.placeholder.visible;
    const transformVisible = this.transformHelper.visible;
    const orbitEnabled = this.controls.enabled;
    const transformEnabled = this.transformControls.enabled;
    const background = this.scene.background;
    const exportCamera = this.camera.clone();
    exportCamera.aspect = width / height;
    // Preserve the entire preview if a caller requests a narrower output ratio.
    if (exportCamera.aspect < this.camera.aspect) exportCamera.zoom *= exportCamera.aspect / this.camera.aspect;
    exportCamera.updateProjectionMatrix();
    this._exporting = true;
    try {
      this.grid.visible = false;
      this.boneHelpers.visible = false;
      this.placeholder.visible = false;
      this.transformHelper.visible = false;
      this.controls.enabled = false;
      this.transformControls.enabled = false;
      this.scene.background = null;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.renderer.render(this.scene, exportCamera);
      const blob = await new Promise((resolve, reject) => this.canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG の生成に失敗しました。')), 'image/png'));
      return blob;
    } finally {
      this.scene.background = background;
      this.grid.visible = gridVisible;
      this.boneHelpers.visible = helperVisible;
      this.placeholder.visible = placeholderVisible;
      this.transformHelper.visible = transformVisible;
      this.controls.enabled = orbitEnabled;
      this.transformControls.enabled = transformEnabled;
      this.renderer.setPixelRatio(oldPixelRatio);
      this.renderer.setSize(oldSize.x, oldSize.y, false);
      this._exporting = false;
      this._resize();
      this.renderer.render(this.scene, this.camera);
    }
  }

  _clearModel() {
    if (this.transformControls.dragging) this._onPointerCancel();
    this.transformControls.detach();
    this.lighting.update(null);
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = null;
    for (const marker of this.markers.values()) this.boneHelpers.remove(marker);
    this.markers.clear();
    this.boneNodes.clear();
    this.boneValues.clear();
    this.boneDefaults.clear();
    this.displayNodes.clear();
    this.expressionValues.clear();
    this.nodeConstraints = [];
    this.disabledConstraints.clear();
    this.selectedBone = null;
    this.selectionAxes.visible = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._loadSequence++;
    cancelAnimationFrame(this._animationFrame);
    this._resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    window.removeEventListener('keydown', this._onKeyDown);
    this._clearModel();
    this.controls.dispose();
    this.transformControls.dispose();
    this.transformHelper.removeFromParent();
    this.transformProxy.removeFromParent();
    this.lighting.dispose();
    VRMUtils.deepDispose(this.placeholder);
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    this.selectedMarkerMaterial.dispose();
    this.boneLines.geometry.dispose();
    this.boneLineMaterial.dispose();
    this.selectionAxes.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
