/**
 * Generated, intentionally simple test geometry; no downloaded model or asset.
 * A block humanoid in T-pose exercises real skinning and a visible happy morph.
 * This fixture is for automated import/render tests, not a bundled demo avatar.
 */
export function makeVRMFixture(version = '1') {
  if (version !== '0' && version !== '1') throw new Error('Fixture version must be "0" or "1".');

  const nodes = [];
  const bones = new Map();
  const positions = new Map();
  // VRM0's forward axis is -Z, with the character's left along -X.
  // Rotate all exported rest data together; rotateVRM0 then matches VRM1.
  const coordinates = vector => version === '0' ? [-vector[0], vector[1], -vector[2]] : vector;
  function bone(name, parent, world) {
    world = coordinates(world);
    const parentWorld = parent ? positions.get(parent) : [0, 0, 0];
    const index = nodes.push({ name, translation: world.map((n, i) => n - parentWorld[i]), children: [] }) - 1;
    bones.set(name, index);
    positions.set(name, world);
    if (parent) nodes[bones.get(parent)].children.push(index);
    return index;
  }

  bone('hips', null, [0, 0.94, 0]);
  bone('spine', 'hips', [0, 1.08, 0]);
  bone('chest', 'spine', [0, 1.28, 0]);
  bone('upperChest', 'chest', [0, 1.42, 0]);
  bone('neck', 'upperChest', [0, 1.53, 0]);
  bone('head', 'neck', [0, 1.65, 0]);
  bone('leftEye', 'head', [0.055, 1.71, 0.113]);
  bone('rightEye', 'head', [-0.055, 1.71, 0.113]);
  bone('jaw', 'head', [0, 1.59, 0.07]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    bone(`${side}Shoulder`, 'upperChest', [sign * 0.12, 1.43, 0]);
    bone(`${side}UpperArm`, `${side}Shoulder`, [sign * 0.22, 1.43, 0]);
    bone(`${side}LowerArm`, `${side}UpperArm`, [sign * 0.48, 1.43, 0]);
    bone(`${side}Hand`, `${side}LowerArm`, [sign * 0.73, 1.43, 0]);
    bone(`${side}UpperLeg`, 'hips', [sign * 0.10, 0.90, 0]);
    bone(`${side}LowerLeg`, `${side}UpperLeg`, [sign * 0.10, 0.49, 0]);
    bone(`${side}Foot`, `${side}LowerLeg`, [sign * 0.10, 0.10, 0]);
    bone(`${side}Toes`, `${side}Foot`, [sign * 0.10, 0.06, 0.12]);
    for (const [fingerIndex, finger] of ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].entries()) {
      const joints = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let parent = `${side}Hand`;
      joints.forEach((joint, index) => {
        const name = `${side}${finger}${joint}`;
        bone(name, parent, [sign * (0.79 + index * 0.025), 1.43, (fingerIndex - 2) * 0.022]);
        parent = name;
      });
    }
  }

  const humanoidEntries = [...bones];
  // A genuine non-humanoid skinned joint, with its own visible tiny hair block.
  const hairJoint = bone('hairJoint', 'head', [0, 1.82, 0]);
  const hairTip = bone('hairTip', 'hairJoint', [0, 1.96, 0]);
  // Spring joints need not be skin joints or THREE.Bone instances. These two
  // plain Object3D nodes test discovery and manual matrix updates separately.
  const springJoint = nodes.push({ name: 'springJoint', translation: coordinates([0.10, 0.16, -0.06]), children: [] }) - 1;
  nodes[bones.get('head')].children.push(springJoint);
  const springTip = nodes.push({ name: 'springTip', translation: coordinates([0, 0.12, 0]) }) - 1;
  nodes[springJoint].children.push(springTip);

  const position = [], normal = [], color = [], joints = [], weights = [], morph = [], indices = [];
  const jointNames = [...bones.keys()];
  function box(center, size, boneName, rgb, smile = false) {
    // Duplicate vertices per face so the faceted blocks have proper hard normals.
    const faces = [
      [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
      [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
      [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
      [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    ];
    for (const [faceNormal, corners] of faces) {
      const first = position.length / 3;
      for (const corner of corners) {
        position.push(...coordinates(center.map((n, axis) => n + corner[axis] * size[axis] / 2)));
        normal.push(...coordinates(faceNormal));
        color.push(...rgb);
        joints.push(jointNames.indexOf(boneName), 0, 0, 0);
        weights.push(1, 0, 0, 0);
        // A big, deliberately testable smiling mouth: corners spread and rise.
        morph.push(...coordinates([smile ? corner[0] * 0.025 : 0, smile ? (corner[1] === 1 ? 0.035 : -0.01) : 0, 0]));
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }
  const blue = [0.18, 0.46, 0.88], skin = [0.97, 0.75, 0.56], dark = [0.04, 0.06, 0.10];
  box([0, 1.19, 0], [0.32, 0.48, 0.21], 'spine', blue);
  box([0, 0.94, 0], [0.30, 0.14, 0.20], 'hips', blue);
  box([0, 1.52, 0], [0.08, 0.15, 0.08], 'neck', skin);
  box([0, 1.68, 0], [0.25, 0.29, 0.23], 'head', skin);
  box([0, 1.88, 0], [0.055, 0.12, 0.055], 'hairJoint', dark);
  box([0, 1.965, 0], [0.035, 0.05, 0.035], 'hairTip', dark);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    box([sign * 0.35, 1.43, 0], [0.26, 0.10, 0.10], `${side}UpperArm`, blue);
    box([sign * 0.605, 1.43, 0], [0.25, 0.09, 0.09], `${side}LowerArm`, skin);
    box([sign * 0.77, 1.43, 0], [0.085, 0.10, 0.10], `${side}Hand`, skin);
    box([sign * 0.10, 0.70, 0], [0.12, 0.40, 0.14], `${side}UpperLeg`, dark);
    box([sign * 0.10, 0.295, 0], [0.10, 0.39, 0.12], `${side}LowerLeg`, dark);
    box([sign * 0.10, 0.055, 0.05], [0.13, 0.10, 0.23], `${side}Foot`, blue);
    // The face is on both sides, keeping VRM0's forward-axis correction testable.
    for (const front of [-1, 1]) box([sign * 0.055, 1.71, front * 0.119], [0.025, 0.04, 0.008], `${side}Eye`, dark);
  }
  for (const front of [-1, 1]) box([0, 1.62, front * 0.121], [0.075, 0.015, 0.008], 'head', dark, true);

  const binaryChunks = [], bufferViews = [], accessors = [];
  let byteLength = 0;
  function accessor(values, ArrayType, componentType, type, components, withBounds = false) {
    const array = new ArrayType(values);
    const raw = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4);
    raw.copy(padded);
    const view = bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: raw.length }) - 1;
    binaryChunks.push(padded);
    byteLength += padded.length;
    const data = { bufferView: view, componentType, count: values.length / components, type };
    if (withBounds) {
      data.min = Array(components).fill(Infinity);
      data.max = Array(components).fill(-Infinity);
      for (let i = 0; i < values.length; i++) {
        const axis = i % components;
        data.min[axis] = Math.min(data.min[axis], values[i]);
        data.max[axis] = Math.max(data.max[axis], values[i]);
      }
    }
    return accessors.push(data) - 1;
  }
  const attributes = {
    POSITION: accessor(position, Float32Array, 5126, 'VEC3', 3, true),
    NORMAL: accessor(normal, Float32Array, 5126, 'VEC3', 3),
    COLOR_0: accessor(color, Float32Array, 5126, 'VEC3', 3),
    JOINTS_0: accessor(joints, Uint16Array, 5123, 'VEC4', 4),
    WEIGHTS_0: accessor(weights, Float32Array, 5126, 'VEC4', 4),
  };
  const indexAccessor = accessor(indices, Uint16Array, 5123, 'SCALAR', 1);
  const morphAccessor = accessor(morph, Float32Array, 5126, 'VEC3', 3, true);
  const inverseBindMatrices = [];
  for (const name of jointNames) {
    const [x, y, z] = positions.get(name);
    inverseBindMatrices.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1);
  }
  const inverseBindAccessor = accessor(inverseBindMatrices, Float32Array, 5126, 'MAT4', 16);
  const meshNode = nodes.push({ name: 'SyntheticTestGeometry', mesh: 0, skin: 0 }) - 1;
  const humanBones = Object.fromEntries(humanoidEntries.map(([name, node]) => [name, { node }]));
  const lookAtMap = { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 };
  const extension = version === '1' ? {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'Generated test humanoid', version: '1', authors: ['VRMpose test generator'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone',
        commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true,
        modification: 'allowModificationRedistribution',
      },
      humanoid: { humanBones },
      expressions: { preset: { happy: { morphTargetBinds: [{ node: meshNode, index: 0, weight: 1 }] } } },
    },
    VRMC_springBone: {
      specVersion: '1.0',
      springs: [
        { name: 'Synthetic skinned hair', joints: [{ node: hairJoint, stiffness: 1, gravityPower: 0, gravityDir: [0, -1, 0], dragForce: 0.4, hitRadius: 0.01 }, { node: hairTip }] },
        { name: 'Synthetic plain spring nodes', joints: [{ node: springJoint, stiffness: 1, gravityPower: 0, gravityDir: [0, -1, 0], dragForce: 0.4, hitRadius: 0.01 }, { node: springTip }] },
      ],
    },
  } : {
    VRM: {
      exporterVersion: 'VRMpose synthetic test generator', specVersion: '0.0',
      meta: { title: 'Generated test humanoid', version: '1', author: 'VRMpose test generator', allowedUserName: 'Everyone', violentUssageName: 'Allow', sexualUssageName: 'Allow', commercialUssageName: 'Allow', licenseName: 'CC0' },
      humanoid: { humanBones: humanoidEntries.map(([name, node]) => ({ bone: name.replace('ThumbProximal', 'ThumbIntermediate').replace('ThumbMetacarpal', 'ThumbProximal'), node, useDefaultValues: true })) },
      firstPerson: {
        firstPersonBone: bones.get('head'), firstPersonBoneOffset: { x: 0, y: 0, z: 0 },
        meshAnnotations: [{ mesh: 0, firstPersonFlag: 'Auto' }], lookAtTypeName: 'Bone',
        lookAtHorizontalInner: lookAtMap, lookAtHorizontalOuter: lookAtMap,
        lookAtVerticalDown: lookAtMap, lookAtVerticalUp: lookAtMap,
      },
      blendShapeMaster: { blendShapeGroups: [{ name: 'Happy', presetName: 'joy', isBinary: false, binds: [{ mesh: 0, index: 0, weight: 100 }] }] },
      secondaryAnimation: {
        boneGroups: [{ comment: 'Synthetic hair and plain spring nodes', bones: [hairJoint, springJoint], stiffiness: 1, gravityPower: 0, gravityDir: { x: 0, y: -1, z: 0 }, dragForce: 0.4, hitRadius: 0.01, colliderGroups: [] }],
        colliderGroups: [],
      },
      materialProperties: [{ name: 'VertexColoredTestMaterial', shader: 'VRM_USE_GLTFSHADER', renderQueue: -1, floatProperties: {}, vectorProperties: {}, textureProperties: {}, keywordMap: {}, tagMap: {} }],
    },
  };
  for (const node of nodes) if (node.children?.length === 0) delete node.children;
  const document = {
    asset: { version: '2.0', generator: 'VRMpose synthetic test fixture' }, scene: 0,
    scenes: [{ nodes: [bones.get('hips'), meshNode] }], nodes,
    extensionsUsed: version === '1' ? ['VRMC_vrm', 'VRMC_springBone'] : ['VRM'], extensions: extension,
    buffers: [{ byteLength }], bufferViews, accessors,
    skins: [{ inverseBindMatrices: inverseBindAccessor, skeleton: bones.get('hips'), joints: [...bones.values()] }],
    materials: [{ name: 'VertexColoredTestMaterial', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    meshes: [{ name: 'SyntheticBlockHumanoid', weights: [0], extras: { targetNames: ['happy'] }, primitives: [{ attributes, indices: indexAccessor, material: 0, targets: [{ POSITION: morphAccessor }] }] }],
  };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJSON = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJSON);
  const binary = Buffer.concat(binaryChunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJSON.length + 8 + binary.length, 8);
  function chunkHeader(length, type) {
    const result = Buffer.alloc(8);
    result.writeUInt32LE(length, 0);
    result.writeUInt32LE(type, 4);
    return result;
  }
  return Buffer.concat([header, chunkHeader(paddedJSON.length, 0x4e4f534a), paddedJSON, chunkHeader(binary.length, 0x004e4942), binary]);
}
