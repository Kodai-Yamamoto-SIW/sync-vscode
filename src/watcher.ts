import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as pathUtil from 'path';
import * as fs from 'fs';
import { safeGetSftpClient, closeSftpClient } from './sftpClient';
import { sftpMkdirRecursive, listRemoteFilesRecursiveRelative, listLocalFilesRecursiveRelative, handleDelete, sftpRmdirRecursive } from './sftpUtils';
import { showSftpError, toPosixPath } from './utils';
import { loadConfig } from './config';

let watcher: vscode.FileSystemWatcher | undefined;
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

    // 1. ファイル/ディレクトリを再帰的に削除
    const deletePaths = [...deleteDirs, ...deleteFiles];
    if (deletePaths.length > 0) {
      console.log('削除処理開始');
      deletePaths.sort((a, b) => b.length - a.length);
      for (const rel of deletePaths) {
        console.log(`→ 削除: ${rel}`);
        try {
          await sftpRmdirRecursive(sftp, pathUtil.posix.join(config.remotePath_posix, rel));
          console.log(`✔ 削除完了: ${rel}`);
          changedRelativePaths.delete(rel);
        } catch (err) {
          console.error(`✖ 削除失敗: ${rel} - ${err}`);
        }
      }
    }

    // 2. ディレクトリ作成
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

    // 3. ファイルアップロード
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
    // pending changes exist? resync immediately
    if (changedRelativePaths.size > 0) {
      console.log('syncChangedFiles: 保留中の変更があるため再同期');
      syncChangedFiles();
    }
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

    // 初期同期: ローカルにのみ存在するファイル/フォルダをアップロード
    const normalizedRemote = new Set(remotePaths);
    const localOnly = localPaths.map(p => toPosixPath(p)).filter(rel => !normalizedRemote.has(rel));
    localOnly.sort((a, b) => a.length - b.length);
    for (const rel of localOnly) {
      const localFull = pathUtil.join(workspaceRoot, rel);
      const remoteFull = pathUtil.posix.join(config.remotePath_posix, rel);
      try {
        const stat = fs.statSync(localFull);
        if (stat.isDirectory()) {
          console.log(`初期同期: 作成ディレクトリ: ${rel}`);
          await sftpMkdirRecursive(sftp, remoteFull);
          console.log(`✔ 初期同期ディレクトリ作成: ${rel}`);
        } else {
          console.log(`初期同期: アップロードファイル: ${rel}`);
          await new Promise<void>((resolve, reject) => {
            sftp.fastPut(localFull, remoteFull, err => err ? reject(err) : resolve());
          });
          console.log(`✔ 初期同期アップロード完了: ${rel}`);
        }
      } catch (err) {
        console.error(`✖ 初期同期アップロード失敗: ${rel} - ${err}`);
      }
    }

    // 初期同期: ローカルとリモート両方に存在するファイルで、ローカルが新しければアップロード
    const both = localPaths.map(p => toPosixPath(p)).filter(rel => normalizedRemote.has(rel));
    both.sort((a, b) => a.length - b.length);
    for (const rel of both) {
      const localFull = pathUtil.join(workspaceRoot, rel);
      let statLocal: fs.Stats;
      try { statLocal = fs.statSync(localFull); } catch { continue; }
      if (!statLocal.isFile()) continue;
      const remoteFull = pathUtil.posix.join(config.remotePath_posix, rel);
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.stat(remoteFull, (err, stats) => {
            if (err) return resolve();
            const remoteMtimeMs = (stats as any).mtime * 1000;
            if (statLocal.mtimeMs > remoteMtimeMs) {
              console.log(`初期同期: 更新ファイルアップロード: ${rel}`);
              sftp.fastPut(localFull, remoteFull, err2 => err2 ? reject(err2) : resolve());
            } else {
              resolve();
            }
          });
        });
        console.log(`✔ 初期同期更新完了: ${rel}`);
      } catch (err) {
        console.error(`✖ 初期同期更新失敗: ${rel} - ${err}`);
      }
    }

    // VS Code FileSystemWatcher で監視（Windowsのファイルロックを回避）
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolders[0], '**/*'),
      false, false, false
    );
    const ignoreRe = /(^|[\\/])\.|[\\/]node_modules[\\/]|[\\/]out[\\/]/;
    watcher.onDidCreate(uri => {
      const fsPath = uri.fsPath;
      if (ignoreRe.test(fsPath)) return;
      const rel = toPosixPath(pathUtil.relative(workspaceRoot, fsPath));
      try {
        const stat = fs.statSync(fsPath);
        addChangedFile(rel, stat.isDirectory() ? 'addDir' : 'add');
      } catch {
        return;
      }
      syncChangedFiles();
    });
    watcher.onDidChange(uri => {
      const fsPath = uri.fsPath;
      if (ignoreRe.test(fsPath)) return;
      const rel = toPosixPath(pathUtil.relative(workspaceRoot, fsPath));
      addChangedFile(rel, 'change');
      syncChangedFiles();
    });
    watcher.onDidDelete(uri => {
      const fsPath = uri.fsPath;
      if (ignoreRe.test(fsPath)) return;
      const rel = toPosixPath(pathUtil.relative(workspaceRoot, fsPath));
      addChangedFile(rel, 'unlink');
      syncChangedFiles();
    });

    console.log('startWatching: ファイル変更時に即時同期モード');
    vscode.window.showInformationMessage('SFTP同期を開始しました');
  } catch (err) {
    await stopWatching();
    showSftpError(err, '同期の開始に失敗しました');
  }
}

export async function stopWatching() {
  console.log('stopWatching: ファイル監視停止');
  if (watcher) {
    watcher.dispose();
    watcher = undefined;
  }
  closeSftpClient();
  changedRelativePaths.clear();
}

// ウォッチャーが動作中かを返す
export function isWatching(): boolean {
  return watcher !== undefined;
}