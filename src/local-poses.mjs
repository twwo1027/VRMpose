import { BONE_NAMES, POSE_SYSTEM_PROMPT, normalizePose, poseFromAI } from '../shared/pose.mjs';

const standing = () => ({
  version: 1, name: '立ち姿', bones: {
    leftUpperArm: [0, 0, -78], rightUpperArm: [0, 0, 78],
    leftLowerArm: [0, -8, 0], rightLowerArm: [0, 8, 0],
  }, expressions: {}, hipsPosition: [0, 0, 0],
});
function wave(pose, side) {
  const sign = side === 'left' ? 1 : -1;
  pose.bones[`${side}UpperArm`] = [-90, -sign * 35, 0];
  pose.bones[`${side}LowerArm`] = [0, -sign * 105, 0];
  pose.bones[`${side}Hand`] = [0, 0, sign * 15];
}
function hipHand(pose, side) {
  const sign = side === 'left' ? 1 : -1;
  pose.bones[`${side}UpperArm`] = [0, sign * 12, -sign * 50];
  pose.bones[`${side}LowerArm`] = [0, -sign * 115, 0];
  pose.bones[`${side}Hand`] = [0, sign * 20, 0];
}
export function generateLocalPose(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4000) throw new Error('1〜4000文字の指示を入力してください。');
  const prompt = input.normalize('NFKC').replace(/\s/g, '');
  const pose = standing(), names = [];
  const tpose = /Tポーズ|T-pose|Tpose/i.test(prompt);
  if (tpose) { pose.bones = {}; names.push('Tポーズ'); }
  if (/立[ちつっ]|直立|自然体|リラックス|基本姿勢/.test(prompt)) names.push('立ち姿');
  if (/座[るりっ]|椅子|いす|イス/.test(prompt)) {
    Object.assign(pose.bones, { leftUpperLeg: [-85, 0, -5], rightUpperLeg: [-85, 0, 5], leftLowerLeg: [85, 0, 0], rightLowerLeg: [85, 0, 0] });
    pose.hipsPosition = [0, -0.5, 0]; names.push('座る');
  }
  if (/お辞儀|おじぎ|礼を|前かがみ/.test(prompt)) {
    pose.bones.spine = [25, 0, 0]; pose.bones.chest = [10, 0, 0]; pose.bones.head = [10, 0, 0]; names.push('お辞儀');
  }
  if (/両(手|腕).*(上げ|あげ|挙げ)|万歳|ばんざい|バンザイ/.test(prompt)) {
    Object.assign(pose.bones, { leftUpperArm: [0, 0, 60], rightUpperArm: [0, 0, -60], leftLowerArm: [0, -15, 0], rightLowerArm: [0, 15, 0] });
    names.push('両手を上げる');
  } else if (/(手|腕).*(振[るっり]|ふ[るっり]|上げ|あげ|挙げ)|手振り|手を振る/.test(prompt)) {
    const side = /左(手|腕)[^左右]{0,12}(振|ふ|上げ|あげ|挙げ)/.test(prompt) ? 'left' : 'right';
    wave(pose, side); names.push(`${side === 'left' ? '左' : '右'}手を振る`);
  }
  if (/ピース|ぴーす|Vサイン/i.test(prompt)) {
    const side = /左/.test(prompt) ? 'left' : 'right';
    const sign = side === 'left' ? 1 : -1;
    wave(pose, side);
    for (const finger of ['Ring', 'Little']) {
      for (const joint of ['Proximal', 'Intermediate', 'Distal']) pose.bones[`${side}${finger}${joint}`] = [0, 0, -sign * 75];
    }
    pose.bones[`${side}ThumbMetacarpal`] = [0, -sign * 35, sign * 20];
    pose.bones[`${side}ThumbProximal`] = [0, -sign * 35, 0];
    pose.bones[`${side}IndexProximal`] = [0, sign * 6, 0];
    pose.bones[`${side}MiddleProximal`] = [0, -sign * 6, 0];
    names.push(`${side === 'left' ? '左' : '右'}手のピース`);
  }
  if (/(手|腕).*(腰|こし)|(腰|こし).*(手|腕)/.test(prompt)) {
    const side = /左(手|腕)[^左右]{0,12}(腰|こし)|(腰|こし)[^左右]{0,8}左(手|腕)/.test(prompt) ? 'left' : 'right';
    hipHand(pose, side); names.push(`${side === 'left' ? '左' : '右'}手を腰に`);
  }
  if (/腕(を)?組|腕組み/.test(prompt)) {
    Object.assign(pose.bones, { leftUpperArm: [0, -25, -65], rightUpperArm: [0, 25, 65], leftLowerArm: [0, -110, 0], rightLowerArm: [0, 110, 0] });
    names.push('腕組み');
  }
  if (/左(を|に)向/.test(prompt)) { pose.bones.head = [0, 35, 0]; names.push('左を向く'); }
  if (/右(を|に)向/.test(prompt)) { pose.bones.head = [0, -35, 0]; names.push('右を向く'); }
  if (/笑顔|笑[うっい]|にこ|嬉し|うれし/.test(prompt)) { pose.expressions.happy = 1; names.push('笑顔'); }
  if (/怒[るりっ]|怒った/.test(prompt)) { pose.expressions.angry = 1; names.push('怒り'); }
  if (/悲し|かなし|泣[くきい]/.test(prompt)) { pose.expressions.sad = 1; names.push('悲しみ'); }
  if (/驚[くきい]|びっくり/.test(prompt)) { pose.expressions.surprised = 1; names.push('驚き'); }
  if (!names.length) throw new Error('無料モードで対応する定型指示が見つかりません。「右手を振る」「両手を上げる」「座る」「お辞儀」「笑顔」などを使うか、ChatGPT貼り付けをお試しください。');
  pose.name = [...new Set(names)].join('・');
  return normalizePose(pose);
}
export const PRESETS = [
  ['stand', '自然な立ち姿', '立ち姿'],
  ['wave', '右手を振る', '右手を振る'],
  ['raise', '両手を上げる', '両手を上げる'],
  ['sit', '座る', '座る'],
  ['bow', 'お辞儀', 'お辞儀'],
  ['cross', '腕組み', '腕を組む'],
  ['smile', '笑顔で手を振る', '笑顔で右手を振る'],
  ['tpose', 'Tポーズ', 'Tポーズ'],
].map(([id, name, description]) => ({ id, name, description, pose: generateLocalPose(description) }));

export function createChatGPTPrompt(prompt, expressionNames = []) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('ポーズの指示を1〜4000文字で入力してください。');
  return `${POSE_SYSTEM_PROMPT}\n\n次の指示をVRMポーズに変換してください。説明は付けずJSONだけ返してください。\n指示: ${prompt.trim()}\n\n使用可能なボーン: ${BONE_NAMES.join(', ')}\n使用可能な表情: ${expressionNames.filter(n => typeof n === 'string').join(', ') || 'なし（expressionsを空配列にする）'}\n形式（bonesとexpressionsは配列、回転角は度）:\n{"name":"日本語のポーズ名","bones":[{"name":"leftUpperArm","rotation":[0,0,-78]},{"name":"rightUpperArm","rotation":[0,0,78]}],"expressions":[]}\n角度は有限の数値で-180〜180、表情値は0〜1としてください。表情を使う場合は {"name":"使用可能な表情名","value":0.5} をexpressionsに入れてください。`;
}
export function parseChatGPTPose(text, expressionNames = []) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('ポーズJSONは1MB以内にしてください。');
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('JSONを読み取れません。ChatGPTの返答からJSON全体をコピーしてください。'); }
  if (value?.version === 1) {
    const pose = normalizePose(value);
    for (const name of Object.keys(pose.expressions)) if (!expressionNames.includes(name)) throw new Error(`このモデルに表情「${name}」はありません。`);
    return pose;
  }
  return poseFromAI(value, expressionNames);
}
