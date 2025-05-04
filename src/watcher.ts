import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as pathUtil from 'path';
import * as fs from 'fs';
import { safeGetSftpClient, closeSftpClient } from './sftpClient';
import { sftpMkdirRecursive, listRemoteFilesRecursiveRelative, listLocalFilesRecursiveRelative, handleDelete } from './sftpUtils';
import { showSftpError, toPosixPath } from './utils';
import { loadConfig } from './config';

let watcher: chokidar.FSWatcher | undefined;
let syncTimerId: NodeJS.Timeout | undefined;
let isSyncing = false;
const changedRelativePaths = new Map<string, 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'>();

// 変更ファイルを記録
function addChangedFile(relativePath: string, type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir') {
  changedRelativePaths.set(relativePath, type);
}

// 同期処理
async function syncChangedFiles() {
  console.log('syncChangedFiles: 処理開始');
  if (isSyncing) return;
  isSyncing = true;
  try {
    if (changedRelativePaths.size === 0) return;
    const config = loadConfig();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const sftp = await safeGetSftpClient('同期処理に失敗しました');
    if (!sftp) return;

    // 変更を種類ごとに分類
    const deleteFiles: string[] = [];
    const deleteDirs: string[] = [];
    const addDirs: string[] = [];
    const upsertFiles: string[] = [];
    for (const [rel, type] of changedRelativePaths) {
      switch (type) {
        case 'unlink': deleteFiles.push(rel); break;
        case 'unlinkDir': deleteDirs.push(rel); break;
        case 'addDir': addDirs.push(rel); break;
        case 'add':
        case 'change': upsertFiles.push(rel); break;
      }
    }
    // デバッグ: 対象一覧をログ出力
    console.log(`リモートルートパス: ${config.remotePath_posix}`);
    console.log('同期対象一覧:', { deleteFiles, deleteDirs, addDirs, upsertFiles });

    // 1. ファイル削除
    if (deleteFiles.length > 0) {
      console.log('ファイル削除処理開始');
      for (const rel of deleteFiles) {
        console.log(`→ 削除: ${rel}`);
        try {
          await handleDelete(sftp, pathUtil.posix.join(config.remotePath_posix, rel));
          console.log(`✔ 削除完了: ${rel}`);
          changedRelativePaths.delete(rel);
        } catch (err) {
          console.error(`✖ 削除失敗: ${rel} - ${err}`);
        }
      }
    }

    // 2. ディレクトリ削除
    if (deleteDirs.length > 0) {
      console.log('ディレクトリ削除処理開始');
      deleteDirs.sort((a, b) => b.length - a.length);
      for (const rel of deleteDirs) {
        console.log(`→ 削除ディレクトリ: ${rel}`);
        try {
          await handleDelete(sftp, pathUtil.posix.join(config.remotePath_posix, rel));
          console.log(`✔ ディレクトリ削除完了: ${rel}`);
          changedRelativePaths.delete(rel);
        } catch (err) {
          console.error(`✖ ディレクトリ削除失敗: ${rel} - ${err}`);
        }
      }
    }

    // 3. ディレクトリ作成
    if (addDirs.length > 0) {
      console.log('ディレクトリ作成処理開始');
      addDirs.sort((a, b) => a.length - b.length);
      for (const rel of addDirs) {
        console.log(`→ 作成ディレクトリ: ${rel}`);
        try {
          await sftpMkdirRecursive(sftp, pathUtil.posix.join(config.remotePath_posix, rel));
          console.log(`✔ ディレクトリ作成完了: ${rel}`);
          changedRelativePaths.delete(rel);
        } catch (err) {
          console.error(`✖ ディレクトリ作成失敗: ${rel} - ${err}`);
        }
      }
    }

    // 4. ファイルアップロード
    if (upsertFiles.length > 0) {
      console.log('ファイルアップロード処理開始');
      for (const rel of upsertFiles) {
        const localPath = pathUtil.join(workspaceRoot, rel);
        const remotePath = pathUtil.posix.join(config.remotePath_posix, rel);
        try {
          const stat = fs.statSync(localPath);
          if (stat.size > config.maxUploadSize) {
            vscode.window.showWarningMessage(`「${rel}」はファイルサイズが上限(${(config.maxUploadSize / 1024 / 1024).toFixed(1)}MB)を超えているため送信しません。`);
            console.warn(`スキップ: ${rel} サイズ: ${stat.size} > ${config.maxUploadSize}`);
            changedRelativePaths.delete(rel);
            continue;
          }
        } catch (err) {
          console.error(`ファイルサイズ取得失敗: ${rel} - ${err}`);
          continue;
        }
        console.log(`→ アップロード: ${rel}`);
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, err => err ? reject(err) : resolve());
          });
          console.log(`✔ アップロード完了: ${rel}`);
          changedRelativePaths.delete(rel);
        } catch (err) {
          console.error(`✖ アップロード失敗: ${rel} - ${err}`);
        }
      }
    }
    console.log('syncChangedFiles: 処理終了');
  } catch (error) {
    showSftpError(error, '同期エラー');
  } finally {
    isSyncing = false;
  }
}

export async function startWatching() {
  console.log(`startWatching: ファイル監視開始 at ${new Date().toISOString()}`);
  if (watcher) {
    vscode.window.showInformationMessage('ファイル監視は既に開始されています');
    return;
  }
  const config = loadConfig();
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) throw new Error('ワークスペースがありません');
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  try {
    const sftp = await safeGetSftpClient('同期の開始に失敗しました');
    if (!sftp) return;

    console.log(`Watcher: リモート初期化 ${config.remotePath_posix}`);
    await sftpMkdirRecursive(sftp, config.remotePath_posix);
    // 初期同期: リモートにのみ存在するファイル/フォルダを削除
    const remotePaths = await listRemoteFilesRecursiveRelative(config.remotePath_posix);
    const localPaths = await listLocalFilesRecursiveRelative(workspaceRoot);

    // ローカルとリモートのパスを正規化して比較
    const normalizedLocalPaths = new Set(localPaths.map(p => toPosixPath(p)));
    const extraPaths = remotePaths.filter(rel => !normalizedLocalPaths.has(rel));

    // 子から親の順に削除
    extraPaths.sort((a, b) => b.length - a.length);
    for (const rel of extraPaths) {
      console.log(`初期同期: リモートのみ存在, 削除: ${rel}`);
      try {
        await handleDelete(sftp, pathUtil.posix.join(config.remotePath_posix, rel));
        console.log(`✔ 初期同期削除成功: ${rel}`);
      } catch (err) {
        console.error(`✖ 初期同期削除失敗: ${rel} - ${err}`);
      }
    }

    watcher = chokidar.watch(workspaceRoot, {
      ignored: [/(^|[\\/])\../, '**/node_modules/**', '**/out/**'],
      persistent: true,
      ignorePermissionErrors: true // ← 追加
    });
    watcher.on('ready', () => console.log('Watcher is ready'));
    const valid = new Set(['add', 'addDir', 'change', 'unlink', 'unlinkDir']);
    watcher.on('all', (evt, path_) => {
      console.log(`Watcher event: ${evt} ${path_}`);
      if (!valid.has(evt)) return;
      const rel = toPosixPath(pathUtil.relative(workspaceRoot, path_));
      addChangedFile(rel, evt as any);
    });
    watcher.on('error', async err => {
      console.error(`Watcher error: ${err}`);
      await stopWatching();
    });

    syncTimerId = setInterval(syncChangedFiles, config.updateInterval * 1000);
    console.log('startWatching: 同期タイマー開始', config.updateInterval);
    vscode.window.showInformationMessage('SFTP同期を開始しました');
  } catch (err) {
    await stopWatching();
    showSftpError(err, '同期の開始に失敗しました');
  }
}

export async function stopWatching() {
  console.log('stopWatching: ファイル監視停止');
  if (syncTimerId) {
    clearInterval(syncTimerId);
    syncTimerId = undefined;
  }
  if (watcher) {
    await watcher.close();
    watcher = undefined;
  }
  closeSftpClient();
  changedRelativePaths.clear();
}

// ウォッチャーが動作中かを返す
export function isWatching(): boolean {
  return watcher !== undefined;
}