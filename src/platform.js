import { normalizePose } from '../shared/pose.mjs';

const LIBRARY_KEY = 'vrmpose.pose-library.v1';
export const isDesktop = Boolean(window.desktop);

function safeName(name) {
  return (String(name || 'pose').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'pose').slice(0, 100);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readBrowserLibrary() {
  let entries;
  try {
    entries = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]');
  } catch {
    throw new Error('保存したポーズを読み込めません。ブラウザの保存領域を確認してください。');
  }
  if (!Array.isArray(entries)) throw new Error('保存したポーズの形式が正しくありません。');
  return entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.createdAt !== 'string') {
      throw new Error('保存したポーズの形式が正しくありません。');
    }
    return { id: entry.id, createdAt: entry.createdAt, pose: normalizePose(entry.pose) };
  });
}

function writeBrowserLibrary(entries) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
  } catch {
    throw new Error('ポーズを保存できません。保存領域の空き容量を確認してください。');
  }
}

export const platform = {
  async listPoses() {
    const entries = isDesktop ? await window.desktop.listPoses() : readBrowserLibrary();
    if (!Array.isArray(entries)) throw new Error('ポーズ一覧を読み込めませんでした。');
    return entries.map(entry => ({ ...entry, pose: normalizePose(entry.pose) }));
  },

  async savePose(pose) {
    const normalized = normalizePose(pose);
    if (isDesktop) return window.desktop.savePose(normalized);
    const entries = readBrowserLibrary();
    if (entries.length >= 500) throw new Error('保存できるポーズは500件までです。不要なポーズを削除してください。');
    const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), pose: normalized };
    entries.unshift(entry);
    writeBrowserLibrary(entries);
    return entry;
  },

  async deletePose(id) {
    if (isDesktop) return window.desktop.deletePose(id);
    writeBrowserLibrary(readBrowserLibrary().filter(entry => entry.id !== id));
  },

  async savePNG(blob, name) {
    const defaultName = `${safeName(name)}.png`;
    if (isDesktop) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return window.desktop.savePNG({ bytes, defaultName });
    }
    download(blob, defaultName);
    return { canceled: false };
  },

  async exportPose(pose) {
    const normalized = normalizePose(pose);
    if (isDesktop) return window.desktop.exportPose(normalized);
    download(new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' }), `${safeName(normalized.name)}.json`);
    return { canceled: false };
  },

  async importPose() {
    if (isDesktop) {
      const result = await window.desktop.importPose();
      return result ? normalizePose(result) : null;
    }
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        try {
          if (file.size > 1024 * 1024) throw new Error('ポーズJSONは1MB以内のファイルを選択してください。');
          resolve(normalizePose(JSON.parse(await file.text())));
        } catch (error) {
          reject(error instanceof SyntaxError ? new Error('JSONファイルの書式が正しくありません。') : error);
        }
      }, { once: true });
      input.click();
    });
  },
};
