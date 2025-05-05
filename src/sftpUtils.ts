import { SFTPWrapper, FileEntryWithStats, Stats } from 'ssh2';
import * as fs from 'fs';
import * as pathUtil from 'path';
import { safeGetSftpClient } from './sftpClient';
import * as vscode from 'vscode';
import { showSftpError } from './utils';
import { ErrorCode, showError } from './errors';
import { loadConfig } from './config';

// 再帰的にディレクトリを作成
export async function sftpMkdirRecursive(sftp: SFTPWrapper, dirPath_posix: string): Promise<void> {
  const rootPath_posix = pathUtil.parse(dirPath_posix).root;
  const parts = dirPath_posix.slice(rootPath_posix.length).split(pathUtil.posix.sep);
  let current = rootPath_posix;
  for (const part of parts) {
    current = pathUtil.posix.join(current, part);
    await new Promise<void>((resolve, reject) => {
      sftp.stat(current, (statErr: Error | undefined) => {
        if (statErr && statErr.message.includes('No such file')) {
          sftp.mkdir(current, (mkdirErr?: Error | null) => {
            if (mkdirErr) reject(mkdirErr);
            else resolve();
          });
        } else if (statErr) {
          reject(statErr);
        } else {
          resolve();
        }
      });
    });
  }
}

// リモートのファイル・ディレクトリを再帰的にリスト
export async function listRemoteFilesRecursiveRelative(remotePath_posix: string): Promise<string[]> {
  // SFTPクライアントを取得 - safeGetSftpClientは既に再試行ロジックを含む
  const sftpOptional = await safeGetSftpClient('リモートファイルリスト取得に失敗しました');
  if (!sftpOptional) {
    return [];
  }
  
  // 実際のファイルリスト取得処理を行う関数（再帰的に呼び出してリトライを実現）
  async function tryListFiles(sftp: SFTPWrapper): Promise<string[]> {
    const remotePaths: string[] = [];
    
    async function walk(p: string): Promise<void> {
      try {
        const list = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
          sftp.readdir(p, (err, list) => {
            if (err) {
              console.error(`SFTPエラー: ${err}`);
              reject(err);
            } else {
              resolve(list);
            }
          });
        });
  
        for (const item of list) {
          const itemPath = pathUtil.posix.join(p, item.filename);
          const rel = pathUtil.posix.relative(remotePath_posix, itemPath);
          remotePaths.push(rel);
          if (item.attrs.isDirectory()) {
            await walk(itemPath);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('Permission denied')) {
          showError(ErrorCode.PermissionDenied, `リモートのパス「${remotePath_posix}」内の「${p}」にアクセスできませんでした`);
          
          // 権限エラーの場合、再入力を促す
          const settingsUpdated = await showSftpError(err, 'リモートのベースパスにアクセスできませんでした');
          if (settingsUpdated) {
            // 設定が更新された場合、新しいSFTPクライアントで再試行
            const newSftp = await safeGetSftpClient('リモートファイルリスト取得に失敗しました');
            if (newSftp) {
              // walk処理を中断して、新しい試行を行う
              throw new RetryWithNewSettingsError(newSftp);
            }
          }
        } else {
          // その他のエラーの場合も再入力を促す
          const settingsUpdated = await showSftpError(err, 'リモートファイルリスト取得に失敗しました');
          if (settingsUpdated) {
            // 設定が更新された場合、新しいSFTPクライアントで再試行
            const newSftp = await safeGetSftpClient('リモートファイルリスト取得に失敗しました');
            if (newSftp) {
              // walk処理を中断して、新しい試行を行う
              throw new RetryWithNewSettingsError(newSftp);
            }
          }
        }
      }
    }
  
    try {
      // ベースパスから開始
      // 常に最新の設定を取得
      const config = loadConfig();
      await walk(config.remotePath_posix);
      return remotePaths;
    } catch (error) {
      // リトライ専用のエラーの場合は新しい設定で再試行
      if (error instanceof RetryWithNewSettingsError) {
        return await tryListFiles(error.sftp);
      }
      // その他の例外は上位で処理
      throw error;
    }
  }
  
  // 設定更新による再試行を制御するためのカスタムエラークラス
  class RetryWithNewSettingsError extends Error {
    constructor(public sftp: SFTPWrapper) {
      super('設定が更新されたため再試行します');
      this.name = 'RetryWithNewSettingsError';
    }
  }
  
  // 初回の試行を開始
  return await tryListFiles(sftpOptional);
}

// ローカルのファイル・ディレクトリを再帰的にリスト
export async function listLocalFilesRecursiveRelative(workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string) {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.') || item === 'node_modules' || item === 'out') continue;
      const itemPath = pathUtil.join(dir, item);
      const rel = pathUtil.relative(workspaceRoot, itemPath);
      files.push(rel);
      if (fs.statSync(itemPath).isDirectory()) await walk(itemPath);
    }
  }
  await walk(workspaceRoot);
  return files;
}

// ファイル/ディレクトリを削除
export async function handleDelete(sftp: SFTPWrapper, remoteFilePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.stat(remoteFilePath, (err: Error | undefined, stats: Stats) => {
      if (err) {
        if ((err as any).code === 'ENOENT' || err.message.includes('No such file')) return resolve();
        return reject(err);
      }
      const action = stats.isDirectory() ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
      action(remoteFilePath, (e?: Error | null) => {
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

// リモートのファイル/ディレクトリを再帰的に削除
export async function sftpRmdirRecursive(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        if ((err as any).code === 'ENOENT' || err.message.includes('No such file')) return resolve();
        return reject(err);
      }
      if (stats.isDirectory()) {
        sftp.readdir(remotePath, async (err2, list) => {
          if (err2) return reject(err2);
          try {
            for (const item of list) {
              const itemPath = pathUtil.posix.join(remotePath, item.filename);
              await sftpRmdirRecursive(sftp, itemPath);
            }
            sftp.rmdir(remotePath, (err3) => err3 ? reject(err3) : resolve());
          } catch (e) {
            reject(e);
          }
        });
      } else {
        sftp.unlink(remotePath, (errUn) => errUn ? reject(errUn) : resolve());
      }
    });
  });
}