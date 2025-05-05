export interface SftpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath_posix: string;
  maxUploadSize: number; // 追加: ファイルサイズ上限（バイト）
}

import * as vscode from 'vscode';

export function loadConfig(): SftpConfig {
  // 最新の設定を取得するため、キャッシュを使わずに設定を読み込む
  const config = vscode.workspace.getConfiguration('ftpSync', null);
  return {
    host: config.get('host') || '',
    port: config.get('port') || 22,
    user: config.get('user') || '',
    password: config.get('password') || '',
    remotePath_posix: config.get('remotePath') || '/',
    maxUploadSize: config.get('maxUploadSize') || 20971520 // 20MB
  };
}

export async function saveConfig(cfg: SftpConfig): Promise<void> {
  const config = vscode.workspace.getConfiguration('ftpSync');
  const TARGET = vscode.ConfigurationTarget.Global;
  
  // 順次設定を保存
  await config.update('host', cfg.host, TARGET);
  await config.update('port', cfg.port, TARGET);
  await config.update('user', cfg.user, TARGET);
  await config.update('password', cfg.password, TARGET);
  await config.update('remotePath', cfg.remotePath_posix, TARGET);
  await config.update('maxUploadSize', cfg.maxUploadSize, TARGET);
  
  // 設定更新のイベントが確実に処理されるよう少し待機
  await new Promise(resolve => setTimeout(resolve, 100));
}