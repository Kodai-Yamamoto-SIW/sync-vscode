import * as vscode from 'vscode';
import * as path from 'path';
import { ErrorCode, showError } from './errors';

// SFTP接続エラーを詳細に表示するヘルパー
export function showSftpError(error: unknown, fallbackPrefix?: string) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const cfg = vscode.workspace.getConfiguration('ftpSync');
  const host = cfg.get<string>('host') || '';

  if ((error as any).code === 'ENOTFOUND' || errMsg.includes('getaddrinfo') || errMsg.includes('ECONNREFUSED')) {
    showError(ErrorCode.HostConnectionFailed);
  } else if (
    errMsg.includes('No such user') ||
    errMsg.includes('All configured authentication methods failed')
  ) {
    showError(ErrorCode.AuthFailed);
  } else if (
    errMsg.includes('Timed out') || 
    errMsg.includes('timeout') || 
    errMsg.includes('handshake')
  ) {
    showError(ErrorCode.ConnectionTimeout);
  } else if (fallbackPrefix) {
    showError(ErrorCode.Unknown, fallbackPrefix);
  } else {
    showError(ErrorCode.Unknown, errMsg);
  }
}

// パスを POSIX 形式に変換する
export function toPosixPath(p: string): string {
  return p.replaceAll(path.sep, path.posix.sep);
}