import { SFTPWrapper, FileEntryWithStats, Stats } from 'ssh2';
import * as fs from 'fs';
import * as pathUtil from 'path';
import { safeGetSftpClient } from './sftpClient';

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
  const sftpOptional = await safeGetSftpClient('リモートファイルリスト取得に失敗しました');
  if (!sftpOptional) {
    return [];
  }
  const sftpClient: SFTPWrapper = sftpOptional;
  const remotePaths: string[] = [];

  async function walk(p: string) {
    return new Promise<void>((resolve, reject) => {
      sftpClient.readdir(p, async (err: Error | undefined, list: FileEntryWithStats[]) => {
        if (err) {
          console.error(`SFTPエラー: ${err}`);
          reject(err);
        } else {
          for (const item of list) {
            const itemPath = pathUtil.posix.join(p, item.filename);
            const rel = pathUtil.posix.relative(remotePath_posix, itemPath);
            remotePaths.push(rel);
            if (item.attrs.isDirectory()) {
              await walk(itemPath);
            }
          }
          resolve();
        }
      });
    });
  }
  await walk(remotePath_posix);
  return remotePaths;
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

// リモートファイル削除
export async function deleteRemoteFile(remoteFilePath: string): Promise<void> {
  const sftp = await safeGetSftpClient('リモートファイル削除に失敗しました');
  if (!sftp) return;
  await handleDelete(sftp, remoteFilePath);
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