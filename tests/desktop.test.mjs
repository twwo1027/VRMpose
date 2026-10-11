import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as poseTools from '../shared/pose.mjs';

const require = createRequire(import.meta.url);
const electronDirectory = fileURLToPath(new URL('../electron/', import.meta.url));
const mainSource = await readFile(path.join(electronDirectory, 'main.cjs'), 'utf8');
const preloadSource = await readFile(path.join(electronDirectory, 'preload.cjs'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const pose = { version: 1, name: 'テスト', bones: { leftUpperArm: [10, 0, -60] }, expressions: { happy: 0.5 } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vrmpose-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map();
  const dialogs = { save: { canceled: true }, open: { canceled: true, filePaths: [] }, saveCalls: 0 };
  let window;
  class MockWindow {
    constructor(options) {
      this.options = options;
      this.events = new Map();
      this.webContents = {
        mainFrame: { url: '' }, events: new Map(),
        session: {
          setPermissionRequestHandler(fn) { this.request = fn; },
          setPermissionCheckHandler(fn) { this.check = fn; },
        },
        setWindowOpenHandler(fn) { this.popup = fn; },
        on(name, fn) { this.events.set(name, fn); },
      };
      window = this;
    }
    on(name, fn) { this.events.set(name, fn); }
    once(name, fn) { this.events.set(name, fn); }
    isDestroyed() { return false; }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    static getAllWindows() { return [window]; }
  }
  const electron = {
    app: {
      getPath() { return directory; }, on() {}, requestSingleInstanceLock() { return true; },
      whenReady() { return new Promise(() => {}); }, quit() {},
    },
    BrowserWindow: MockWindow,
    ipcMain: { handle(name, fn) { handlers.set(name, fn); } },
    dialog: {
      async showSaveDialog(_window, options) { dialogs.saveCalls++; dialogs.options = options; return dialogs.save; },
      async showOpenDialog() { return dialogs.open; },
      showErrorBox() { throw new Error('Unexpected startup error'); },
    },
  };
  const context = vm.createContext({
    require(name) { return name === 'electron' ? electron : require(name); }, Buffer, URL,
    __dirname: electronDirectory, process: { platform: process.platform, env: {} }, __poseTools: poseTools,
  });
  vm.runInContext(mainSource, context);
  // Supply the real shared validator while replacing only Electron's native runtime.
  vm.runInContext('poseTools = __poseTools; registerIPC(); createWindow();', context);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return {
    directory, dialogs, window, event,
    invoke: (name, value, sender = event) => handlers.get(name)(sender, value),
  };
}

test('concurrent native pose saves preserve every entry and survive rereading the disk', async t => {
  const { invoke, directory } = await harness(t);
  assert.deepEqual(plain(await invoke('poses:list')), []);
  const entries = await Promise.all(Array.from({ length: 8 }, (_, index) => invoke('poses:save', { ...pose, name: `同時保存${index}` })));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 8);
  const stored = JSON.parse(await readFile(path.join(directory, 'poses.json'), 'utf8'));
  assert.equal(stored.entries.length, 8);
  assert.deepEqual(new Set(stored.entries.map(entry => entry.pose.name)), new Set(entries.map(entry => entry.pose.name)));
  assert.equal((await invoke('poses:list')).length, 8);
  assert.deepEqual(plain(entries[0].pose.hipsPosition), [0, 0, 0]);
  assert.deepEqual(plain(await invoke('poses:delete', entries[0].id)), { deleted: true });
  assert.deepEqual(plain(await invoke('poses:delete', entries[0].id)), { deleted: false });
  assert.equal((await invoke('poses:list')).length, 7);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('a corrupt pose library blocks mutations without overwriting the original bytes', async t => {
  const { invoke, directory } = await harness(t);
  const saved = await invoke('poses:save', pose);
  const libraryPath = path.join(directory, 'poses.json');
  const original = await readFile(libraryPath);
  const corruptVariants = ['{ broken', JSON.stringify({ version: 1, entries: [{ ...saved, pose: { ...pose, bones: { missingBone: [0, 0, 0] } } }] })];
  for (const raw of corruptVariants) {
    await writeFile(libraryPath, raw);
    await assert.rejects(invoke('poses:list'), /既存の履歴は変更していません/);
    await assert.rejects(invoke('poses:save', pose), /既存の履歴は変更していません/);
    await assert.rejects(invoke('poses:delete', saved.id), /既存の履歴は変更していません/);
    assert.equal(await readFile(libraryPath, 'utf8'), raw);
  }
  await writeFile(libraryPath, original);
  await invoke('poses:save', pose);
  assert.equal((await invoke('poses:list')).length, 2, 'a rejected operation does not poison later queued saves');
});

test('IPC denies another window, child frame and changed URL before writing a library', async t => {
  const { invoke, directory, event, window } = await harness(t);
  const attackers = [
    { sender: {}, senderFrame: event.senderFrame },
    { sender: window.webContents, senderFrame: { url: event.senderFrame.url } },
  ];
  for (const attacker of attackers) await assert.rejects(invoke('poses:save', pose, attacker), /許可されていません/);
  window.webContents.mainFrame.url = 'https://example.com/';
  await assert.rejects(invoke('poses:save', pose), /許可されていません/);
  assert.deepEqual(await readdir(directory), []);
  let prevented = false;
  window.webContents.events.get('will-navigate')({ preventDefault() { prevented = true; } }, 'https://example.com/');
  assert.equal(prevented, true);
  assert.deepEqual(plain(window.webContents.popup()), { action: 'deny' });
  assert.equal(window.webContents.session.check(), false);
});

test('PNG validation precedes native dialogs and saving writes only the selected file', async t => {
  const { invoke, directory, dialogs } = await harness(t);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(4097, 16);
  await assert.rejects(invoke('file:png', { bytes: oversized }), /4096/);
  await assert.rejects(invoke('file:png', { bytes: new Uint8Array([1, 2, 3]) }), /形式/);
  assert.equal(dialogs.saveCalls, 0);
  assert.deepEqual(plain(await invoke('file:png', { bytes: new Uint8Array(png), defaultName: 'CON.png' })), { canceled: true });
  assert.equal(dialogs.options.defaultPath, 'VRMpose.png', 'Windows device names are replaced');
  assert.deepEqual(await readdir(directory), []);
  const selected = path.join(directory, 'selected.png');
  dialogs.save = { canceled: false, filePath: selected };
  assert.deepEqual(plain(await invoke('file:png', { bytes: png, defaultName: '../../ignored' })), { canceled: false, path: selected });
  assert.deepEqual(await readFile(selected), png);
  assert.deepEqual(await readdir(directory), ['selected.png']);
});

test('native JSON dialogs round-trip normalized poses and reject invalid or oversized files', async t => {
  const { invoke, directory, dialogs } = await harness(t);
  const selected = path.join(directory, 'selected.json');
  dialogs.save = { canceled: false, filePath: selected };
  assert.equal((await invoke('file:export-pose', pose)).path, selected);
  dialogs.open = { canceled: false, filePaths: [selected] };
  assert.deepEqual(plain(await invoke('file:import-pose')), poseTools.normalizePose(pose));
  await writeFile(selected, JSON.stringify({ ...pose, bones: { invalid: [0, 0, 0] } }));
  await assert.rejects(invoke('file:import-pose'), /ポーズの形式/);
  await writeFile(selected, 'not JSON');
  await assert.rejects(invoke('file:import-pose'), /読み込めません/);
  await writeFile(selected, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(invoke('file:import-pose'), /読み込めません/);
  dialogs.open = { canceled: true, filePaths: [] };
  assert.equal(await invoke('file:import-pose'), null);
});

test('sandboxed preload exposes only the six scoped desktop operations', () => {
  let exposed;
  const context = vm.createContext({
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, api) { exposed = { name, api }; } },
        ipcRenderer: { invoke: (...args) => args },
      };
    },
  });
  vm.runInContext(preloadSource, context);
  assert.equal(exposed.name, 'desktop');
  assert.equal(Object.isFrozen(exposed.api), true);
  assert.deepEqual(Object.keys(exposed.api).sort(), ['deletePose', 'exportPose', 'importPose', 'listPoses', 'savePNG', 'savePose']);
  assert.deepEqual(plain(exposed.api.savePose(pose)), ['poses:save', pose]);
  assert.deepEqual(plain(exposed.api.savePNG({ bytes: [1, 2] })), ['file:png', { bytes: [1, 2] }]);
});
