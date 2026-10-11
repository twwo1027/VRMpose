const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const MAX_POSE_BYTES = 2 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;
const MAX_PNG_BYTES = 128 * 1024 * 1024;
const MAX_POSES = 500;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let mainWindow;
let rendererURL;
let poseTools;
let libraryQueue = Promise.resolve();
let dialogOpen = false;

class UserError extends Error {}
function fail(message) { throw new UserError(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function dataFile(name) { return path.join(app.getPath('userData'), name); }
function enqueue(task) {
  const result = libraryQueue.then(task);
  libraryQueue = result.catch(() => {});
  return result;
}
async function readBounded(file, maximum) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) fail('ファイルが大きすぎるか、形式が正しくありません。');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maximum + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum || length > stat.size) fail('読み込み中にファイルが変更されました。もう一度お試しください。');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
async function atomicWrite(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
async function persist(file, value, maximum) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.length > maximum) fail('保存データが大きすぎます。不要なポーズを削除してください。');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, bytes);
}
function normalize(value) {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_POSE_BYTES) fail('ポーズデータが大きすぎます。');
    return poseTools.normalizePose(value);
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail('ポーズの形式が正しくありません。VRMpose形式のJSONを指定してください。');
  }
}
async function loadLibrary() {
  let saved;
  try { saved = JSON.parse((await readBounded(dataFile('poses.json'), MAX_LIBRARY_BYTES)).toString('utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    fail('ポーズ履歴を読み込めません。既存の履歴は変更していません。');
  }
  try {
    if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > MAX_POSES) throw new Error();
    const ids = new Set();
    return saved.entries.map(entry => {
      if (!object(entry) || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) ||
          typeof entry.createdAt !== 'string' || entry.createdAt.length > 32 || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error();
      ids.add(entry.id);
      return { id: entry.id, createdAt: entry.createdAt, pose: normalize(entry.pose) };
    });
  } catch { fail('ポーズ履歴が壊れています。既存の履歴は変更していません。'); }
}
async function savePose(value) {
  const pose = normalize(value);
  const entries = await loadLibrary();
  if (entries.length >= MAX_POSES) fail(`保存できるポーズは${MAX_POSES}件までです。不要なポーズを削除してください。`);
  const entry = { id: randomUUID(), createdAt: new Date().toISOString(), pose };
  entries.unshift(entry);
  await persist(dataFile('poses.json'), { version: 1, entries }, MAX_LIBRARY_BYTES);
  return entry;
}
async function deletePose(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('ポーズIDが正しくありません。');
  const entries = await loadLibrary();
  const remaining = entries.filter(entry => entry.id !== id);
  if (remaining.length !== entries.length) await persist(dataFile('poses.json'), { version: 1, entries: remaining }, MAX_LIBRARY_BYTES);
  return { deleted: remaining.length !== entries.length };
}
function filename(value, extension) {
  let name = typeof value === 'string' ? value.trim().slice(0, 100) : '';
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'VRMpose';
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}
async function withDialog(task) {
  if (dialogOpen) fail('開いているファイルダイアログを閉じてから、もう一度お試しください。');
  dialogOpen = true;
  try { return await task(); } finally { dialogOpen = false; }
}
function pngBytes(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_PNG_BYTES) fail('PNGファイルが大きすぎます。');
    bytes = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_PNG_BYTES) fail('PNGファイルが大きすぎます。');
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (Array.isArray(value) && value.length <= MAX_PNG_BYTES && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    bytes = Buffer.from(value);
  } else { fail('PNGデータの形式が正しくありません。'); }
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(bytes.length - 12) !== 0 || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') {
    fail('PNGデータの形式が正しくありません。');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) fail('PNGの長辺は4096ピクセル以下にしてください。');
  return bytes;
}
async function savePNG(value) {
  if (!object(value)) fail('PNGデータの形式が正しくありません。');
  const bytes = pngBytes(value.bytes);
  return withDialog(async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '透過PNGを保存', defaultPath: filename(value.defaultName, '.png'),
      filters: [{ name: 'PNG画像', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await atomicWrite(result.filePath, bytes);
    return { canceled: false, path: result.filePath };
  });
}
async function exportPose(value) {
  const pose = normalize(value);
  return withDialog(async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'ポーズJSONを保存', defaultPath: filename(pose.name, '.vrmpose.json'),
      filters: [{ name: 'ポーズJSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await atomicWrite(result.filePath, Buffer.from(`${JSON.stringify(pose, null, 2)}\n`, 'utf8'));
    return { canceled: false, path: result.filePath };
  });
}
async function importPose() {
  return withDialog(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'ポーズJSONを読み込む', properties: ['openFile'], filters: [{ name: 'ポーズJSON', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    let parsed;
    try { parsed = JSON.parse((await readBounded(result.filePaths[0], MAX_POSE_BYTES)).toString('utf8')); }
    catch { fail('ポーズJSONを読み込めません。ファイルの形式とサイズを確認してください。'); }
    return normalize(parsed);
  });
}
function trustedSender(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame && event.senderFrame.url === rendererURL;
}
function registerIPC() {
  const handlers = {
    'poses:list': () => enqueue(loadLibrary),
    'poses:save': value => enqueue(() => savePose(value)),
    'poses:delete': value => enqueue(() => deletePose(value)),
    'file:png': savePNG, 'file:export-pose': exportPose, 'file:import-pose': importPose,
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, value) => {
      if (!trustedSender(event)) throw new Error('この画面からの操作は許可されていません。');
      try { return await handler(value); }
      catch (error) {
        throw new Error(error instanceof UserError ? error.message : '処理に失敗しました。保存先の権限や空き容量を確認してください。');
      }
    });
  }
}
function createWindow() {
  const development = process.env.VRMPOSE_DEV_URL;
  rendererURL = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  if (development) {
    const url = new URL(development);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '5173' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('VRMPOSE_DEV_URL must be http://127.0.0.1:5173/ or http://localhost:5173/');
    }
    rendererURL = url.href;
  }
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 680, show: false, title: 'VRMpose', backgroundColor: '#151923',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== rendererURL) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.loadURL(rendererURL).catch(() => {
    dialog.showErrorBox('VRMpose', '画面を読み込めません。アプリのビルドまたは実行ファイルを確認してください。');
    app.quit();
  });
}

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    poseTools = await import('../shared/pose.mjs');
    registerIPC();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(() => {
    dialog.showErrorBox('VRMpose', 'アプリを起動できません。設定またはインストール状態を確認してください。');
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
