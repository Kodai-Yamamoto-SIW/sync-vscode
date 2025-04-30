import * as vscode from 'vscode';
import * as path from 'path';

// SFTP接続エラーを詳細に表示するヘルパー
export function showSftpError(error: unknown, fallbackPrefix?: string) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const cfg = vscode.workspace.getConfiguration('ftpSync');
  const host = cfg.get<string>('host') || '';
  const user = cfg.get<string>('user') || '';

  let message: string;
  if ((error as any).code === 'ENOTFOUND' || errMsg.includes('getaddrinfo') || errMsg.includes('ECONNREFUSED')) {
    message = `ホスト「${host}」に接続できませんでした`;
  } else if (
    errMsg.includes('No such user') ||
    errMsg.includes('All configured authentication methods failed') ||
    errMsg.includes('Permission denied')
  ) {
    message = 'ユーザー名またはパスワードが正しくありません';
  } else if (fallbackPrefix) {
    message = `${fallbackPrefix}: ${errMsg}`;
  } else {
    message = errMsg;
  }
  vscode.window.showErrorMessage(message);
}

// パスをローカル形式に変換する
export function toLocalPath(p: string): string {
  return p.replaceAll(path.posix.sep, path.sep);
}

// パスを POSIX 形式に変換する
export function toPosixPath(p: string): string {
  return p.replaceAll(path.sep, path.posix.sep);
} 