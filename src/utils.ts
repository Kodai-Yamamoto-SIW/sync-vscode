import * as vscode from 'vscode';
import * as path from 'path';
import { ErrorCode, showError } from './errors';
import { saveConfig, loadConfig } from './config';

// SFTP接続エラーを詳細に表示するヘルパー
export async function showSftpError(error: unknown, fallbackPrefix?: string): Promise<boolean> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const cfg = loadConfig();
  const host = cfg.host;

  if ((error as any).code === 'ENOTFOUND' || errMsg.includes('getaddrinfo') || errMsg.includes('ECONNREFUSED')) {
    showError(ErrorCode.HostConnectionFailed, fallbackPrefix);
    return await promptHostReentry();
  } else if (
    errMsg.includes('No such user') ||
    errMsg.includes('All configured authentication methods failed')
  ) {
    showError(ErrorCode.AuthFailed, fallbackPrefix);
    return await promptAuthReentry();
  } else if (
    errMsg.includes('Timed out') || 
    errMsg.includes('timeout') || 
    errMsg.includes('handshake')
  ) {
    showError(ErrorCode.ConnectionTimeout, fallbackPrefix);
    return await promptPortReentry();
  } else if (errMsg.includes('Permission denied')) {
    showError(ErrorCode.PermissionDenied, fallbackPrefix);
    return await promptRemotePathReentry();
  } else if (fallbackPrefix) {
    showError(ErrorCode.Unknown, fallbackPrefix);
    return false;
  } else {
    showError(ErrorCode.Unknown, errMsg);
    return false;
  }
}

// ホスト名の再入力を促す
async function promptHostReentry(): Promise<boolean> {
  const config = loadConfig();
  const newHost = await vscode.window.showInputBox({
    prompt: 'ホスト名を再入力してください',
    value: config.host
  });
  
  if (newHost !== undefined) {
    await saveConfig({
      ...config,
      host: newHost
    });
    // 設定が確実に反映されるよう少し待機
    await new Promise(resolve => setTimeout(resolve, 100));
    vscode.window.showInformationMessage(`ホスト名を更新しました: ${newHost}`);
    return true;
  }
  return false;
}

// ユーザー名とパスワードの再入力を促す
async function promptAuthReentry(): Promise<boolean> {
  const config = loadConfig();
  
  const newUser = await vscode.window.showInputBox({
    prompt: 'ユーザー名を再入力してください',
    value: config.user
  });
  
  if (newUser === undefined) return false;
  
  const newPassword = await vscode.window.showInputBox({
    prompt: 'パスワードを再入力してください',
    password: true,
    value: config.password
  });
  
  if (newPassword !== undefined) {
    await saveConfig({
      ...config,
      user: newUser,
      password: newPassword
    });
    // 設定が確実に反映されるよう少し待機
    await new Promise(resolve => setTimeout(resolve, 100));
    vscode.window.showInformationMessage('ユーザー名とパスワードを更新しました');
    return true;
  }
  return false;
}

// ポート番号の再入力を促す
async function promptPortReentry(): Promise<boolean> {
  const config = loadConfig();
  const newPortStr = await vscode.window.showInputBox({
    prompt: 'ポート番号を再入力してください',
    value: config.port.toString()
  });
  
  if (newPortStr !== undefined) {
    const newPort = parseInt(newPortStr, 10);
    if (isNaN(newPort) || newPort <= 0 || newPort > 65535) {
      vscode.window.showErrorMessage('無効なポート番号です。1〜65535の範囲で指定してください。');
      return false;
    }
    
    await saveConfig({
      ...config,
      port: newPort
    });
    // 設定が確実に反映されるよう少し待機
    await new Promise(resolve => setTimeout(resolve, 100));
    vscode.window.showInformationMessage(`ポート番号を更新しました: ${newPort}`);
    return true;
  }
  return false;
}

// リモートパスの再入力を促す
async function promptRemotePathReentry(): Promise<boolean> {
  const config = loadConfig();
  const newRemotePath = await vscode.window.showInputBox({
    prompt: 'リモートのベースパスを再入力してください',
    value: config.remotePath_posix
  });
  
  if (newRemotePath !== undefined) {
    await saveConfig({
      ...config,
      remotePath_posix: newRemotePath
    });
    // 設定が確実に反映されるよう少し待機
    await new Promise(resolve => setTimeout(resolve, 100));
    vscode.window.showInformationMessage(`リモートのベースパスを更新しました: ${newRemotePath}`);
    return true;
  }
  return false;
}

// パスを POSIX 形式に変換する
export function toPosixPath(p: string): string {
  return p.replaceAll(path.sep, path.posix.sep);
}