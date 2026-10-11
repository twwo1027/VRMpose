import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePose, poseFromAI, BONE_NAMES } from '../shared/pose.mjs';
import { PRESETS, generateLocalPose, createChatGPTPrompt, parseChatGPTPose } from '../src/local-poses.mjs';

const neutral = () => ({ version: 1, name: 'test', bones: {}, expressions: {} });

test('all presets and all 55 humanoid bone names form valid portable poses', () => {
  assert.equal(BONE_NAMES.length, 55);
  assert.equal(new Set(BONE_NAMES).size, 55);
  for (const preset of PRESETS) assert.deepEqual(normalizePose(preset.pose), preset.pose);
  const pose = { ...neutral(), bones: Object.fromEntries(BONE_NAMES.map(name => [name, [1, -2, 3]])), extraBones: { '0/髪/1': [10, -5, 0] } };
  assert.equal(Object.keys(normalizePose(pose).bones).length, 55);
});
test('pose validation rejects malformed data, nonfinite angles and prototype keys', () => {
  for (const value of [null, [], {}, { ...neutral(), version: 2 }, { ...neutral(), bones: { other: [0, 0, 0] } }, { ...neutral(), bones: { head: [NaN, 0, 0] } }, { ...neutral(), bones: { head: [181, 0, 0] } }, { ...neutral(), expressions: { happy: -1 } }, { ...neutral(), hipsPosition: [0, Infinity, 0] }, JSON.parse('{"version":1,"bones":{},"expressions":{"__proto__":1}}')]) {
    assert.throws(() => normalizePose(value));
  }
  const input = { ...neutral(), bones: { head: [0, 20, 0] } };
  normalizePose(input).bones.head[1] = 10;
  assert.equal(input.bones.head[1], 20, 'validation creates independent arrays');
});
test('Japanese commands combine posture, side-specific arm gestures and expression', () => {
  const pose = generateLocalPose('座って、左手を振り、右手を腰に置いて笑顔');
  assert.equal(pose.bones.leftLowerArm[1], -105);
  assert.equal(pose.bones.rightLowerArm[1], 115);
  assert.equal(pose.bones.leftUpperLeg[0], -85);
  assert.equal(pose.expressions.happy, 1);
  assert.deepEqual(generateLocalPose('Ｔポーズ').bones, {});
  assert.throws(() => generateLocalPose('ヨガの鷲のポーズ'), /ChatGPT/);
});
test('ChatGPT result handles fenced JSON and validates supported bones/expressions', () => {
  const response = { name: 'ご挨拶', bones: [{ name: 'head', rotation: [10, 0, 0] }], expressions: [{ name: 'happy', value: 0.8 }] };
  const pose = parseChatGPTPose('```json\n' + JSON.stringify(response) + '\n```', ['happy']);
  assert.equal(pose.expressions.happy, 0.8);
  assert.deepEqual(pose.bones.head, [10, 0, 0]);
  assert.throws(() => parseChatGPTPose(JSON.stringify(response), []), /表情/);
  assert.throws(() => poseFromAI({ ...response, bones: [response.bones[0], response.bones[0]] }, ['happy']), /ボーン/);
  assert.throws(() => parseChatGPTPose('alert(1)'), /JSON/);
  assert.deepEqual(parseChatGPTPose(JSON.stringify(pose), ['happy']), pose);
});
test('copied prompt includes the request, available expressions and concrete coordinate conventions', () => {
  const prompt = createChatGPTPrompt('左手を振る', ['happy']);
  assert.match(prompt, /指示: 左手を振る/);
  assert.match(prompt, /使用可能な表情: happy/);
  assert.match(prompt, /leftLittleDistal/);
  assert.match(prompt, /negative Y on leftLowerArm/);
  assert.throws(() => createChatGPTPrompt(''), /指示/);
});
