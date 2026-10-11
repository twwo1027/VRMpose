export const BONE_LABELS = {
  hips: '腰', spine: '背骨', chest: '胸', upperChest: '上胸', neck: '首', head: '頭',
  leftEye: '左目', rightEye: '右目', jaw: '顎',
  leftShoulder: '左肩', leftUpperArm: '左上腕', leftLowerArm: '左前腕', leftHand: '左手',
  rightShoulder: '右肩', rightUpperArm: '右上腕', rightLowerArm: '右前腕', rightHand: '右手',
  leftUpperLeg: '左太もも', leftLowerLeg: '左すね', leftFoot: '左足', leftToes: '左つま先',
  rightUpperLeg: '右太もも', rightLowerLeg: '右すね', rightFoot: '右足', rightToes: '右つま先',
};
for (const side of ['left', 'right']) {
  for (const [finger, label] of [['Thumb', '親指'], ['Index', '人差し指'], ['Middle', '中指'], ['Ring', '薬指'], ['Little', '小指']]) {
    const joints = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    joints.forEach((joint, index) => { BONE_LABELS[`${side}${finger}${joint}`] = `${side === 'left' ? '左' : '右'}${label} ${index + 1}`; });
  }
}
export const BONE_NAMES = Object.keys(BONE_LABELS);
export const EXPRESSION_LABELS = {
  happy: '喜び', angry: '怒り', sad: '悲しみ', relaxed: 'リラックス', surprised: '驚き',
  neutral: 'ニュートラル', blink: 'まばたき', blinkLeft: '左まばたき', blinkRight: '右まばたき',
  aa: 'あ', ih: 'い', ou: 'う', ee: 'え', oh: 'お',
  lookUp: '上を見る', lookDown: '下を見る', lookLeft: '左を見る', lookRight: '右を見る',
};
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);
function record(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}
function vector(value, limit, message) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > limit)) throw new Error(message);
  return [...value];
}
export function normalizePose(value) {
  record(value, 'ポーズの形式が正しくありません。');
  if (value.version !== 1) throw new Error('未対応のポーズ形式です。');
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 100) : '';
  const bones = {};
  for (const [key, angles] of Object.entries(record(value.bones, 'ボーン情報がありません。'))) {
    if (!BONE_NAMES.includes(key)) throw new Error(`未対応のボーン: ${key}`);
    bones[key] = vector(angles, 180, `${key} の角度は -180〜180 度で指定してください。`);
  }
  const expressions = {};
  for (const [key, weight] of Object.entries(record(value.expressions, '表情情報がありません。'))) {
    if (!key || key.length > 128 || dangerousKeys.has(key) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('表情パラメータが正しくありません。');
    expressions[key] = weight;
  }
  if (Object.keys(expressions).length > 128) throw new Error('表情パラメータが多すぎます。');
  const extraBones = {};
  if (value.extraBones !== undefined) {
    for (const [key, angles] of Object.entries(record(value.extraBones, '追加ボーン情報が正しくありません。'))) {
      if (dangerousKeys.has(key) || key.length > 512 || !key) throw new Error('追加ボーン名が正しくありません。');
      extraBones[key] = vector(angles, 180, '追加ボーンの角度が正しくありません。');
    }
    if (Object.keys(extraBones).length > 1000) throw new Error('追加ボーンが多すぎます。');
  }
  return {
    version: 1, name: name || '無題のポーズ', bones, expressions, extraBones,
    hipsPosition: value.hipsPosition === undefined ? [0, 0, 0] : vector(value.hipsPosition, 5, '腰の移動量は ±5m 以内です。'),
  };
}
export function poseFromAI(value, expressionNames = []) {
  record(value, 'AIの応答が正しくありません。');
  if (!Array.isArray(value.bones) || !Array.isArray(value.expressions)) throw new Error('AIの応答にボーン・表情情報がありません。');
  const bones = {}, expressions = {};
  for (const item of value.bones) {
    if (!item || !BONE_NAMES.includes(item.name) || Object.hasOwn(bones, item.name)) throw new Error('AIのボーン指定が不正です。');
    bones[item.name] = item.rotation;
  }
  for (const item of value.expressions) {
    if (!item || !expressionNames.includes(item.name) || dangerousKeys.has(item.name) || Object.hasOwn(expressions, item.name)) throw new Error('AIの表情指定が不正です。');
    expressions[item.name] = item.value;
  }
  return normalizePose({ version: 1, name: value.name, bones, expressions });
}
export function buildPoseSchema(expressionNames = []) {
  const expressionEnum = expressionNames.filter(x => typeof x === 'string' && x.length <= 128 && !dangerousKeys.has(x));
  return {
    type: 'object', additionalProperties: false, required: ['name', 'bones', 'expressions'],
    properties: {
      name: { type: 'string' },
      bones: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['name', 'rotation'],
        properties: { name: { type: 'string', enum: BONE_NAMES }, rotation: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: -180, maximum: 180 } } },
      } },
      expressions: { type: 'array', ...(expressionEnum.length ? {} : { maxItems: 0 }), items: {
        type: 'object', additionalProperties: false, required: ['name', 'value'],
        properties: { name: expressionEnum.length ? { type: 'string', enum: expressionEnum } : { type: 'string' }, value: { type: 'number', minimum: 0, maximum: 1 } },
      } },
    },
  };
}
export const POSE_SYSTEM_PROMPT = `You are a VRM humanoid pose designer. Interpret the user's Japanese instruction and return a complete pose from a neutral T-pose. Use normalized VRM 1 humanoid local rotation offsets, not raw skeleton rotations. Angles are degrees, intrinsic Euler XYZ, each in [-180,180]. World axes: +Y up, +Z forward, +X character's left. Arms extend horizontally along X in T-pose. To lower the left arm use negative Z on leftUpperArm; to lower the right arm use positive Z on rightUpperArm. To flex an elbow toward the front, use negative Y on leftLowerArm or positive Y on rightLowerArm. Forward hip flexion uses negative X on upperLeg; knee flexion uses positive X on lowerLeg. Combine axes carefully, prefer plausible anatomical limits and non-intersecting limbs. Unspecified bones/expressions are reset to neutral; include lowered arms for a standing pose. Choose only available expression names. Do not repeat a bone or expression. Return a short Japanese pose name. This is approximate angle-based posing, without inverse kinematics or collision simulation.`;
