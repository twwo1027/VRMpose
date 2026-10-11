import './style.css';
import { PoseViewport } from './viewport.js';
import { PRESETS, generateLocalPose, createChatGPTPrompt, parseChatGPTPose } from './local-poses.mjs';
import { platform, isDesktop } from './platform.js';

const icons = {
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  sparkle: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4m-2-2h4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-8h10v8"/>',
  folder: '<path d="M3 7V5h7l2 2h9v13H3V7Z"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  bone: '<path d="m8 16 8-8M4.2 12.4a3 3 0 1 0 4.3 4.3 3 3 0 1 0-4.3-4.3ZM15.5 7.3a3 3 0 1 0 4.3 4.3 3 3 0 1 0-4.3-4.3Z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
};
const icon = (key, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key] || icons.cube}</svg>`;

document.querySelector('#app').innerHTML = `
  <header class="app-header">
    <div class="brand"><div class="brand-mark">${icon('cube')}</div><div><h1>VRM<span>pose</span></h1><p>YOUR CHARACTER. YOUR EXPRESSION.</p></div></div>
    <div class="header-state"><span class="status-dot"></span>オフラインで、自由につくる <span class="free-tag">API利用料なし</span></div>
    <div class="header-actions"><button class="button button-quiet" id="open-model">${icon('upload')}<span>VRMを開く</span></button><button class="button button-accent" id="export-png" disabled>${icon('download')}<span>PNGを書き出す</span></button></div>
  </header>
  <main class="workspace">
    <aside class="creative-panel">
      <section class="prompt-section">
        <div class="section-heading"><div><span class="eyebrow">POSE ASSISTANT</span><h2>ことばから、ポーズに。</h2></div><span class="section-number">01</span></div>
        <div class="segmented mode-tabs" role="tablist" aria-label="ポーズの作成方法"><button id="mode-local" class="active" role="tab" aria-selected="true" aria-controls="local-panel">${icon('sparkle')}無料の指示</button><button id="mode-chatgpt" role="tab" aria-selected="false" aria-controls="chatgpt-panel">ChatGPT貼り付け</button></div>
        <div id="local-panel" role="tabpanel" aria-labelledby="mode-local">
          <label class="field-label" for="pose-prompt">どんなポーズにしますか？</label>
          <div class="prompt-input"><textarea id="pose-prompt" rows="4" maxlength="1000" placeholder="例：右手を振って、笑顔にして"></textarea><span class="prompt-input-symbol">${icon('sparkle')}</span></div>
          <div class="prompt-suggestions"><button data-prompt="右手を振って、笑顔にして">手を振る</button><button data-prompt="両手を上げて">両手を上げる</button><button data-prompt="ピースして、笑顔にして">ピース</button></div>
          <button class="button button-accent button-full" id="apply-local" disabled>${icon('sparkle')}ポーズを適用${icon('arrow', 'trailing-icon')}</button>
          <p class="helper-text">対応する日本語をプリセットに変換します。<br>通信・APIキーは不要です。</p>
        </div>
        <div id="chatgpt-panel" role="tabpanel" aria-labelledby="mode-chatgpt" hidden>
          <p class="helper-text chatgpt-explainer">普段のChatGPTで指示文を送り、返ってきたJSONを貼り付けます。アプリからのAPI課金はありません。</p>
          <label class="field-label" for="chatgpt-prompt">作りたいポーズ</label><textarea id="chatgpt-prompt" class="text-field" rows="2" maxlength="1000" placeholder="例：少し首を傾けて、片手を腰にあてる"></textarea>
          <button class="button button-outline button-full" id="copy-chatgpt">${icon('copy')}ChatGPT用の指示をコピー</button>
          <label class="field-label spaced" for="chatgpt-result">ChatGPTの回答（JSON）</label><textarea id="chatgpt-result" class="text-field code-field" rows="4" maxlength="200000" placeholder='{ "version": 1, "bones": … }' spellcheck="false"></textarea>
          <button class="button button-accent button-full" id="apply-chatgpt" disabled>${icon('check')}回答のポーズを適用</button>
          <p class="helper-text">ChatGPTの利用条件はお使いのプランに従います。ボーン角度による生成のため、必要に応じて手動で調整してください。</p>
        </div>
        <p id="prompt-error" class="inline-error" role="alert" hidden></p>
      </section>
      <section class="preset-section">
        <div class="mini-heading"><h3>まずは、ここから</h3><span>PRESETS</span></div><div class="preset-grid" id="preset-list"></div>
      </section>
      <section class="library-section">
        <div class="library-heading"><div class="mini-heading"><h3>${icon('folder')}マイポーズ <span id="library-count" class="count-badge">0</span></h3></div><button class="icon-button" id="save-current" title="現在のポーズを保存" aria-label="現在のポーズを保存" disabled>${icon('plus')}</button></div>
        <div id="library-list" class="library-list"></div>
        <button class="button button-library" id="import-pose">${icon('upload')}ポーズJSONを読み込む</button>
        <p class="library-footnote" id="storage-note"></p>
      </section>
    </aside>
    <section class="stage-panel" aria-label="3Dモデルのプレビュー">
      <div class="stage-topbar"><div class="model-label"><span class="model-tag">MODEL</span><span id="model-name">モデル未読み込み</span></div><div class="stage-actions"><span class="live-dot" id="model-ready-dot"></span><span id="model-format">VRM 0.x / 1.0</span><button class="icon-button" id="show-help" title="操作ガイド" aria-label="操作ガイド">${icon('info')}</button></div></div>
      <div class="stage-frame"><div id="viewport"></div><div class="stage-vignette"></div>
        <div class="empty-stage" id="empty-stage"><div class="empty-model-icon">${icon('cube')}<span class="orbit orbit-one"></span><span class="orbit orbit-two"></span></div><span class="eyebrow">A BLANK CANVAS, ENDLESS POSSIBILITIES.</span><h2>あなたのモデルを、<br>あなたらしいポーズに。</h2><p id="empty-description">VRMファイルを読み込んで始めましょう。<br>ポーズも表情も、思いのままに。</p><button class="button button-accent" id="open-model-empty">${icon('plus')}VRMモデルを選ぶ</button><span class="empty-supported">.vrm &nbsp; · &nbsp; VRM 0.x / VRM 1.0</span></div>
        <div class="composition-label"><span class="frame-corner"></span><span id="composition-label">LANDSCAPE / 16:9</span></div>
        <div class="camera-hint"><span>ドラッグで回転</span><span>右ドラッグで移動</span><span>ホイールでズーム</span></div>
        <div class="pose-name-badge" id="pose-name-badge" hidden>${icon('check')}<span id="current-pose-name"></span></div>
      </div>
      <div class="stage-toolbar"><div class="view-tools"><span class="toolbar-label">VIEW</span><select id="camera-view" aria-label="カメラの方向"><option value="three-quarter">斜め</option><option value="front">正面</option><option value="back">背面</option><option value="left">左側</option><option value="right">右側</option></select><button class="icon-button" id="reset-view" title="カメラをリセット" aria-label="カメラをリセット">${icon('reset')}</button><span class="toolbar-divider"></span><label class="helper-toggle" title="床・ボーンのガイド表示。書き出したPNGには含まれません。"><input type="checkbox" id="show-helpers" checked><span>ガイド</span></label></div><button class="button button-small button-quiet" id="reset-pose" disabled>${icon('reset')}ポーズをリセット</button></div>
      <div class="export-strip"><div class="export-strip-title">${icon('download')}<div><strong>TRANSPARENT PNG</strong><span>背景を透過して、高解像度で。</span></div></div><div class="export-controls"><label for="output-size" class="sr-only">出力サイズ</label><select id="output-size"><option value="landscape">横長 · 3840 × 2160</option><option value="portrait">縦長 · 2160 × 3840</option><option value="square">正方形 · 4096 × 4096</option></select><span class="resolution-tag">4K</span></div></div>
    </section>
    <aside class="inspector-panel">
      <div class="inspector-heading"><div><span class="eyebrow">FINE TUNE</span><h2>細部まで、自分らしく。</h2></div><span class="section-number">02</span></div>
      <div class="inspector-tabs" role="tablist" aria-label="モデルの調整"><button id="tab-bones" class="active" role="tab" aria-selected="true" aria-controls="bones-panel">${icon('bone')}ボーン</button><button id="tab-expressions" role="tab" aria-selected="false" aria-controls="expressions-panel">${icon('smile')}表情</button></div>
      <section id="bones-panel" role="tabpanel" aria-labelledby="tab-bones">
        <div class="inspector-block bone-picker"><label class="field-label" for="bone-search">操作するボーン</label><div class="search-field">${icon('search')}<input id="bone-search" type="search" placeholder="ボーンを検索" disabled></div><select id="bone-select" size="7" aria-label="操作するボーン" disabled><option>モデルを読み込んでください</option></select><p class="inspector-help" id="bone-count">指や追加ボーンも編集できます。</p></div>
        <div class="inspector-block"><div class="control-heading"><h3>回転</h3><button class="text-button" id="reset-bone" disabled>リセット</button></div><p class="control-caption" id="selected-bone-label">ボーンを選択してください</p><div id="rotation-controls"></div><p class="inspector-help">選択したボーンの初期姿勢からの回転角度</p></div>
        <div class="inspector-block"><div class="control-heading"><h3>モデルの位置</h3><span class="unit-badge">m</span></div><div id="position-controls"></div><p class="inspector-help">腰を基準にモデル全体を移動します。</p></div>
      </section>
      <section id="expressions-panel" role="tabpanel" aria-labelledby="tab-expressions" hidden><div class="inspector-block"><div class="control-heading"><h3>表情パラメータ</h3><span class="unit-badge">0 – 1</span></div><p class="inspector-help">モデルに含まれる表情を組み合わせます。</p><div id="expression-controls" class="expression-controls"><p class="inspector-empty">VRMを読み込むと、<br>使用できる表情が表示されます。</p></div></div></section>
      <div class="inspector-tip">${icon('info')}<p>モデルはお使いのPC内で処理されます。<br>VRMファイルを外部へ送信しません。</p></div>
    </aside>
  </main>
  <footer class="app-footer"><span><span class="footer-dot"></span><span id="app-state">モデルを読み込む準備ができました</span></span><span>VRMpose <span class="footer-version">v0.1</span><span class="footer-divider">/</span>CREATE SOMETHING YOU.</span></footer>
  <input id="vrm-input" type="file" accept=".vrm" hidden>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <dialog id="save-dialog" class="dialog"><form id="save-form"><div class="dialog-title"><h2 id="save-dialog-title">ポーズを保存</h2><button type="button" class="icon-button" data-close-dialog="save-dialog" aria-label="閉じる">${icon('close')}</button></div><p class="dialog-description">ボーン・表情・モデルの位置をまとめて保存します。</p><label class="field-label" for="save-name">ポーズの名前</label><input id="save-name" class="text-field" type="text" maxlength="100" required placeholder="お気に入りのポーズ"><div class="dialog-actions"><button type="button" class="button button-quiet" data-close-dialog="save-dialog">キャンセル</button><button class="button button-accent" id="save-submit" type="submit">${icon('save')}保存する</button></div><p id="save-error" class="inline-error" role="alert" hidden></p></form></dialog>
  <dialog id="help-dialog" class="dialog help-dialog"><div class="dialog-title"><h2>スタジオの使い方</h2><button class="icon-button" data-close-dialog="help-dialog" aria-label="閉じる">${icon('close')}</button></div><ol class="help-steps"><li><strong>VRMモデルを開く</strong><p>VRM 0.xと1.0のモデルを読み込めます。モデルの利用規約に沿ってお使いください。</p></li><li><strong>ポーズと表情をつくる</strong><p>無料の日本語指示やプリセットを適用して、右側のボーンと表情で細かく調整します。自由な指示はChatGPTの回答を貼り付けて使えます。</p></li><li><strong>構図を決める</strong><p>ドラッグで回転、右ドラッグで移動、ホイールでズーム。出力の縦横比を選んでから調整してください。</p></li><li><strong>保存・書き出し</strong><p>マイポーズに保存すると、後から別のモデルにも呼び出せます。PNGは透過背景で書き出されます。追加ボーンは同じモデルでの再利用に適しています。</p></li></ol><p class="helper-text">${isDesktop ? 'ポーズはこのPCのアプリ保存領域に保存されます。' : 'ブラウザ版のポーズは、このブラウザに保存されます。大切なポーズはJSONでも書き出してください。'}</p><button class="button button-accent button-full" data-close-dialog="help-dialog">つくり始める</button></dialog>
  <dialog id="copy-dialog" class="dialog"><div class="dialog-title"><h2>ChatGPT用の指示</h2><button class="icon-button" data-close-dialog="copy-dialog" aria-label="閉じる">${icon('close')}</button></div><p class="dialog-description">選択した指示を Ctrl+C（Macは⌘C）でコピーして、ChatGPTに貼り付けてください。</p><textarea id="copy-manual-text" class="text-field code-field" rows="10" readonly aria-label="コピーするChatGPT用の指示"></textarea><div class="dialog-actions"><button class="button button-accent" data-close-dialog="copy-dialog">完了</button></div></dialog>
`;

const $ = selector => document.querySelector(selector);
let viewport;
let rendererError;
try { viewport = new PoseViewport($('#viewport'), { onBoneSelect: selectBone }); }
catch (error) { rendererError = error; }
const state = { model: null, selectedBone: null, library: [], poseName: '無題のポーズ', loading: false, exporting: false, saving: false, saveTarget: null, size: 'landscape' };
const sizes = { landscape: [3840, 2160, 'LANDSCAPE / 16:9'], portrait: [2160, 3840, 'PORTRAIT / 9:16'], square: [4096, 4096, 'SQUARE / 1:1'] };
let toastTimer;

function notify(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').classList.toggle('toast-error', error);
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 6500 : 4000);
  $('#app-state').textContent = message;
}

function showPromptError(error) {
  $('#prompt-error').textContent = error?.message || String(error);
  $('#prompt-error').hidden = false;
}

function clearPromptError() { $('#prompt-error').hidden = true; }

function syncEnabled() {
  const busy = state.loading || state.exporting;
  const ready = Boolean(state.model) && !busy;
  ['#apply-local', '#apply-chatgpt', '#save-current', '#reset-pose', '#reset-bone', '#bone-search', '#bone-select'].forEach(selector => { $(selector).disabled = !ready; });
  $('#export-png').disabled = !ready || state.exporting;
  $('#open-model').disabled = busy || !viewport;
  $('#open-model-empty').disabled = busy || !viewport;
  ['#camera-view', '#reset-view', '#show-helpers', '#output-size'].forEach(selector => { $(selector).disabled = busy || !viewport; });
  document.querySelectorAll('.model-control, .preset-card').forEach(control => { control.disabled = !ready; });
  document.querySelectorAll('.library-apply').forEach(control => { control.disabled = !ready; });
}

function setPoseName(name) {
  state.poseName = name || '無題のポーズ';
  $('#current-pose-name').textContent = state.poseName;
  $('#pose-name-badge').hidden = !state.model;
}

function markAdjusted() {
  if (!state.poseName.endsWith('・調整済み')) setPoseName(`${state.poseName.replace(/・調整済み$/, '')}・調整済み`);
}

function getPose() { return viewport.capturePose(state.poseName); }

function updateInspector() {
  if (!state.model) return;
  const pose = getPose();
  const key = state.selectedBone;
  const bone = state.model.bones.find(item => item.key === key);
  const rotation = bone?.extra ? (pose.extraBones?.[key] || [0, 0, 0]) : (pose.bones[key] || [0, 0, 0]);
  ['x', 'y', 'z'].forEach((axis, index) => {
    $(`#rotation-${axis}`).value = rotation[index];
    $(`#rotation-${axis}-number`).value = Math.round(rotation[index] * 10) / 10;
    $(`#position-${axis}`).value = pose.hipsPosition[index];
    $(`#position-${axis}-number`).value = Math.round(pose.hipsPosition[index] * 100) / 100;
  });
  state.model.expressions.forEach(expression => {
    const input = document.querySelector(`input[data-expression-index="${state.model.expressions.indexOf(expression)}"]`);
    const number = document.querySelector(`input[data-expression-number="${state.model.expressions.indexOf(expression)}"]`);
    if (input) input.value = pose.expressions[expression.key] || 0;
    if (number) number.value = Math.round((pose.expressions[expression.key] || 0) * 100) / 100;
  });
}

function selectBone(key) {
  if (!state.model || !state.model.bones.some(bone => bone.key === key)) return;
  state.selectedBone = key;
  if (![...$('#bone-select').options].some(option => option.value === key)) {
    $('#bone-search').value = '';
    renderBoneOptions();
  }
  $('#bone-select').value = key;
  $('#selected-bone-label').textContent = state.model.bones.find(bone => bone.key === key)?.label || key;
  viewport.setSelectedBone(key);
  updateInspector();
}

function renderBoneOptions() {
  if (!state.model) return;
  const search = $('#bone-search').value.trim().toLowerCase();
  const list = state.model.bones.filter(bone => !search || `${bone.label} ${bone.key}`.toLowerCase().includes(search));
  $('#bone-select').replaceChildren();
  for (const bone of list) {
    const option = document.createElement('option');
    option.value = bone.key;
    option.textContent = `${bone.extra ? '◇ ' : ''}${bone.label}`;
    $('#bone-select').append(option);
  }
  if (!list.length) {
    const option = document.createElement('option');
    option.textContent = '該当するボーンがありません';
    option.disabled = true;
    $('#bone-select').append(option);
  }
  if (list.some(bone => bone.key === state.selectedBone)) $('#bone-select').value = state.selectedBone;
  else $('#bone-select').selectedIndex = -1;
}

function createAxisControls(type, min, max, step, suffix) {
  const host = $(`#${type}-controls`);
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div');
    row.className = 'axis-control';
    row.innerHTML = `<label class="axis-label axis-${axis}" for="${type}-${axis}">${axis.toUpperCase()}</label><input class="model-control range-input" id="${type}-${axis}" type="range" min="${min}" max="${max}" step="${step}" value="0" disabled><div class="number-wrapper"><input class="model-control number-input" id="${type}-${axis}-number" type="number" min="${min}" max="${max}" step="${step}" value="0" aria-label="${type === 'rotation' ? '回転' : '位置'}${axis.toUpperCase()}" disabled><span>${suffix}</span></div>`;
    host.append(row);
    const range = row.querySelector('.range-input');
    const number = row.querySelector('.number-input');
    const change = (source, target) => {
      const value = Number(source.value);
      if (!Number.isFinite(value)) return;
      source.value = Math.min(max, Math.max(min, value));
      target.value = source.value;
      try {
        const values = ['x', 'y', 'z'].map(item => Number($(`#${type}-${item}`).value));
        if (type === 'rotation') viewport.setBone(state.selectedBone, values);
        else viewport.setHipsPosition(values);
        markAdjusted();
      } catch (error) { notify(error.message, true); }
    };
    range.addEventListener('input', () => change(range, number));
    number.addEventListener('change', () => change(number, range));
  }
}

createAxisControls('rotation', -180, 180, 0.5, '°');
createAxisControls('position', -5, 5, 0.01, 'm');

function renderExpressions() {
  $('#expression-controls').replaceChildren();
  if (!state.model.expressions.length) {
    const message = document.createElement('p');
    message.className = 'inspector-empty';
    message.textContent = 'このモデルには表情パラメータがありません。';
    $('#expression-controls').append(message);
    return;
  }
  state.model.expressions.forEach((expression, index) => {
    const row = document.createElement('div');
    row.className = 'expression-row';
    const label = document.createElement('label');
    label.textContent = expression.label;
    label.htmlFor = `expression-${index}`;
    const number = document.createElement('input');
    number.className = 'model-control number-input';
    number.type = 'number'; number.min = 0; number.max = 1; number.step = 0.01; number.value = 0;
    number.dataset.expressionNumber = index;
    number.setAttribute('aria-label', `${expression.label}の値`);
    const range = document.createElement('input');
    range.className = 'model-control range-input';
    range.type = 'range'; range.min = 0; range.max = 1; range.step = 0.01; range.value = 0;
    range.id = `expression-${index}`; range.dataset.expressionIndex = index;
    const change = (source, target) => {
      const value = Number(source.value);
      if (!Number.isFinite(value)) return;
      source.value = Math.min(1, Math.max(0, value)); target.value = source.value;
      viewport.setExpression(expression.key, Number(source.value)); markAdjusted();
    };
    range.addEventListener('input', () => change(range, number));
    number.addEventListener('change', () => change(number, range));
    row.append(label, number, range);
    $('#expression-controls').append(row);
  });
}

async function applyPose(pose) {
  if (!state.model) { notify('先にVRMモデルを読み込んでください。'); return; }
  if (state.loading || state.exporting) { notify('モデルの読み込み・書き出しが終わってから適用してください。'); return; }
  viewport.applyPose(pose);
  setPoseName(pose.name);
  updateInspector();
  clearPromptError();
  notify(`「${pose.name}」を適用しました`);
}

async function loadModel(file) {
  if (!file || state.loading || state.exporting || !viewport) return;
  if (!file.name.toLowerCase().endsWith('.vrm')) { notify('拡張子が .vrm のモデルを選んでください。', true); return; }
  state.loading = true;
  syncEnabled();
  $('#empty-stage').classList.add('is-loading');
  $('#empty-description').textContent = 'モデルを読み込んでいます…';
  $('#app-state').textContent = 'VRMモデルを読み込み中…';
  try {
    state.model = await viewport.loadFile(file);
    $('#model-name').textContent = state.model.name || file.name;
    $('#model-name').title = file.name;
    $('#model-format').textContent = `VRM ${state.model.version}`;
    $('#model-ready-dot').classList.add('ready');
    $('#empty-stage').hidden = true;
    $('#bone-search').value = '';
    state.selectedBone = state.model.bones.find(bone => bone.key === 'hips')?.key || state.model.bones[0]?.key;
    renderBoneOptions();
    $('#bone-count').textContent = `${state.model.bones.length}ボーン · ◇ はモデル固有の追加ボーン`;
    renderExpressions();
    if (state.selectedBone) selectBone(state.selectedBone);
    setPoseName('初期ポーズ');
    viewport.setAspect(sizes[state.size][0] / sizes[state.size][1]);
    viewport.setView($('#camera-view').value);
    updateInspector();
    notify(`${file.name} を読み込みました`);
  } catch (error) {
    notify(error.message || 'モデルを読み込めませんでした。', true);
    if (!viewport.hasModel) {
      state.model = null;
      $('#empty-stage').hidden = false;
    }
  } finally {
    state.loading = false;
    $('#empty-stage').classList.remove('is-loading');
    $('#empty-description').innerText = 'VRMファイルを読み込んで始めましょう。\nポーズも表情も、思いのままに。';
    $('#vrm-input').value = '';
    syncEnabled();
  }
}

function requestModel() { if (!state.loading && !state.exporting && viewport) $('#vrm-input').click(); }
$('#open-model').addEventListener('click', requestModel);
$('#open-model-empty').addEventListener('click', requestModel);
$('#vrm-input').addEventListener('change', () => loadModel($('#vrm-input').files?.[0]));
$('#bone-search').addEventListener('input', renderBoneOptions);
$('#bone-select').addEventListener('change', () => selectBone($('#bone-select').value));

for (const mode of ['local', 'chatgpt']) {
  $(`#mode-${mode}`).addEventListener('click', () => {
    for (const item of ['local', 'chatgpt']) {
      $(`#mode-${item}`).classList.toggle('active', mode === item);
      $(`#mode-${item}`).setAttribute('aria-selected', String(mode === item));
      $(`#${item}-panel`).hidden = mode !== item;
    }
    clearPromptError();
  });
}

for (const tab of ['bones', 'expressions']) {
  $(`#tab-${tab}`).addEventListener('click', () => {
    for (const item of ['bones', 'expressions']) {
      $(`#tab-${item}`).classList.toggle('active', tab === item);
      $(`#tab-${item}`).setAttribute('aria-selected', String(tab === item));
      $(`#${item}-panel`).hidden = tab !== item;
    }
  });
}

document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  $('#pose-prompt').value = button.dataset.prompt;
  $('#pose-prompt').focus();
}));

$('#apply-local').addEventListener('click', async () => {
  try {
    const prompt = $('#pose-prompt').value.trim();
    if (!prompt) throw new Error('作りたいポーズを入力してください。');
    await applyPose(await generateLocalPose(prompt));
  } catch (error) { showPromptError(error); }
});

$('#copy-chatgpt').addEventListener('click', async () => {
  try {
    const prompt = $('#chatgpt-prompt').value.trim();
    if (!prompt) throw new Error('作りたいポーズを入力してください。');
    const text = createChatGPTPrompt(prompt, state.model?.expressions.map(expression => expression.key) || []);
    try {
      await navigator.clipboard.writeText(text);
      notify('指示をコピーしました。ChatGPTに貼り付けてください。');
    } catch {
      $('#copy-manual-text').value = text;
      $('#copy-dialog').showModal();
      $('#copy-manual-text').focus();
      $('#copy-manual-text').select();
    }
  } catch (error) { showPromptError(error); }
});

$('#apply-chatgpt').addEventListener('click', async () => {
  try {
    const text = $('#chatgpt-result').value.trim();
    if (!text) throw new Error('ChatGPTの回答を貼り付けてください。');
    await applyPose(parseChatGPTPose(text, state.model.expressions.map(expression => expression.key)));
  } catch (error) { showPromptError(error); }
});

const presetSymbols = { stand: '◇', wave: '↗', raise: '↑', sit: '∟', bow: '⌁', cross: '×', smile: '♡', tpose: '↔' };
PRESETS.forEach((preset, index) => {
  const button = document.createElement('button');
  button.className = 'preset-card';
  button.disabled = true;
  button.title = preset.description;
  const mark = document.createElement('span'); mark.className = 'preset-mark'; mark.textContent = presetSymbols[preset.id] || '✦';
  const label = document.createElement('span'); label.textContent = preset.name;
  button.append(mark, label);
  button.addEventListener('click', () => { applyPose(preset.pose).catch(error => notify(error.message, true)); });
  $('#preset-list').append(button);
});

$('#reset-bone').addEventListener('click', () => {
  if (!state.selectedBone) return;
  viewport.setBone(state.selectedBone, [0, 0, 0]);
  updateInspector(); markAdjusted();
});

$('#reset-pose').addEventListener('click', () => {
  viewport.resetPose(); setPoseName('初期ポーズ'); updateInspector(); notify('ポーズをリセットしました');
});

$('#camera-view').addEventListener('change', () => viewport?.setView($('#camera-view').value));
$('#reset-view').addEventListener('click', () => { $('#camera-view').value = 'three-quarter'; viewport?.setView('three-quarter'); });
$('#show-helpers').addEventListener('change', () => viewport?.setHelpers($('#show-helpers').checked));
$('#output-size').addEventListener('change', () => {
  state.size = $('#output-size').value;
  const [width, height, label] = sizes[state.size];
  viewport?.setAspect(width / height);
  $('#composition-label').textContent = label;
});
viewport?.setAspect(16 / 9);

$('#export-png').addEventListener('click', async () => {
  if (!state.model || state.exporting) return;
  state.exporting = true; syncEnabled();
  $('#export-png').classList.add('is-loading');
  $('#export-png span').textContent = '書き出し中…';
  try {
    const [width, height] = sizes[state.size];
    const blob = await viewport.exportPNG({ width, height });
    const result = await platform.savePNG(blob, `${state.poseName}-${width}x${height}`);
    if (!result?.canceled) notify(`${width} × ${height} の透過PNGを書き出しました`);
  } catch (error) { notify(error.message || 'PNGを書き出せませんでした。', true); }
  finally {
    state.exporting = false; syncEnabled();
    $('#export-png').classList.remove('is-loading');
    $('#export-png span').textContent = 'PNGを書き出す';
  }
});

async function refreshLibrary() {
  state.library = await platform.listPoses();
  renderLibrary();
  syncEnabled();
}

function renderLibrary() {
  $('#library-count').textContent = state.library.length;
  $('#library-list').replaceChildren();
  if (!state.library.length) {
    const empty = document.createElement('div'); empty.className = 'library-empty';
    empty.innerHTML = `${icon('save')}<p>お気に入りのポーズを、ここに。</p><span>右上の ＋ で現在のポーズを保存できます。</span>`;
    $('#library-list').append(empty);
    return;
  }
  for (const entry of state.library) {
    const item = document.createElement('div'); item.className = 'library-item';
    const apply = document.createElement('button'); apply.className = 'library-apply';
    const glyph = document.createElement('span'); glyph.className = 'library-glyph'; glyph.innerHTML = icon('bone');
    const copy = document.createElement('span'); copy.className = 'library-item-copy';
    const title = document.createElement('strong'); title.textContent = entry.pose.name;
    const date = document.createElement('span');
    const timestamp = new Date(entry.createdAt);
    date.textContent = Number.isNaN(timestamp.valueOf()) ? '保存したポーズ' : timestamp.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
    copy.append(title, date); apply.append(glyph, copy);
    apply.title = `${entry.pose.name} を適用`;
    apply.addEventListener('click', () => { applyPose(entry.pose).catch(error => notify(error.message, true)); });
    const actions = document.createElement('div'); actions.className = 'library-item-actions';
    for (const [action, glyphName, label] of [['rename', 'edit', '名前を変更'], ['export', 'download', 'JSONを書き出す'], ['delete', 'trash', '削除']]) {
      const button = document.createElement('button'); button.className = 'icon-button'; button.innerHTML = icon(glyphName); button.title = label; button.setAttribute('aria-label', `${entry.pose.name}: ${label}`);
      button.addEventListener('click', async () => {
        if (action === 'rename') { openSave(entry); return; }
        button.disabled = true;
        try {
          if (action === 'export') {
            const result = await platform.exportPose(entry.pose);
            if (!result?.canceled) notify('ポーズJSONを書き出しました');
          } else {
            await platform.deletePose(entry.id); await refreshLibrary(); notify(`「${entry.pose.name}」を削除しました`);
          }
        } catch (error) { notify(error.message, true); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    item.append(apply, actions); $('#library-list').append(item);
  }
}

function openSave(entry = null) {
  if (!entry && !state.model) return;
  state.saveTarget = entry;
  $('#save-dialog-title').textContent = entry ? 'ポーズの名前を変更' : 'ポーズを保存';
  $('#save-name').value = entry ? entry.pose.name : state.poseName.replace(/・調整済み$/, '');
  $('#save-error').hidden = true;
  $('#save-dialog').showModal();
  $('#save-name').focus(); $('#save-name').select();
}

$('#save-current').addEventListener('click', () => openSave());
$('#save-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.saving) return;
  const name = $('#save-name').value.trim();
  if (!name) return;
  state.saving = true; $('#save-submit').disabled = true;
  try {
    const pose = state.saveTarget ? { ...state.saveTarget.pose, name } : { ...getPose(), name };
    await platform.savePose(pose);
    if (state.saveTarget) await platform.deletePose(state.saveTarget.id);
    else setPoseName(name);
    await refreshLibrary();
    $('#save-dialog').close();
    notify(`「${name}」を保存しました`);
  } catch (error) { $('#save-error').textContent = error.message; $('#save-error').hidden = false; }
  finally { state.saving = false; $('#save-submit').disabled = false; }
});

$('#import-pose').addEventListener('click', async () => {
  $('#import-pose').disabled = true;
  try {
    const pose = await platform.importPose();
    if (!pose) return;
    await platform.savePose(pose); await refreshLibrary();
    if (state.model) await applyPose(pose);
    else notify(`「${pose.name}」をマイポーズに読み込みました`);
  } catch (error) { notify(error.message, true); }
  finally { $('#import-pose').disabled = false; }
});

$('#show-help').addEventListener('click', () => $('#help-dialog').showModal());
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
$('#storage-note').textContent = isDesktop ? 'このPCに保存 · JSONでも持ち出せます' : 'このブラウザに保存 · JSONでバックアップ';

document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'o') { event.preventDefault(); requestModel(); }
  if (event.key.toLowerCase() === 's' && state.model) { event.preventDefault(); openSave(); }
  if (event.key.toLowerCase() === 'e' && event.shiftKey && state.model) { event.preventDefault(); $('#export-png').click(); }
});

const stageFrame = $('.stage-frame');
stageFrame.addEventListener('dragover', event => { event.preventDefault(); stageFrame.classList.add('drag-over'); });
stageFrame.addEventListener('dragleave', () => stageFrame.classList.remove('drag-over'));
stageFrame.addEventListener('drop', event => { event.preventDefault(); stageFrame.classList.remove('drag-over'); loadModel(event.dataTransfer.files?.[0]); });

refreshLibrary().catch(error => notify(error.message, true));
syncEnabled();
if (rendererError) {
  $('#empty-stage h2').textContent = '3Dプレビューを開始できません';
  $('#empty-description').textContent = 'WebGL対応のブラウザ、またはグラフィック機能が使えるPCで開いてください。';
  notify(rendererError.message || 'この環境ではWebGLを使用できません。', true);
}
window.addEventListener('beforeunload', () => viewport?.dispose());
