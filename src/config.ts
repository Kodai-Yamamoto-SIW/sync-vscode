export interface SftpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath_posix: string;
  updateInterval: number;
  maxUploadSize: number; // 追加: ファイルサイズ上限（バイト）
}

import * as vscode from 'vscode';

export function loadConfig(): SftpConfig {
  const config = vscode.workspace.getConfiguration('ftpSync');
  return {
    host: config.get('host') || '',
    port: config.get('port') || 22,
    user: config.get('user') || '',
    password: config.get('password') || '',
    remotePath_posix: config.get('remotePath') || '/',
    updateInterval: config.get('updateInterval') || 10,
    maxUploadSize: config.get('maxUploadSize') || 20971520 // 20MB
  };
}

export async function saveConfig(cfg: SftpConfig): Promise<void> {
  const config = vscode.workspace.getConfiguration('ftpSync');
  const TARGET = vscode.ConfigurationTarget.Global;
  await config.update('host', cfg.host, TARGET);
  await config.update('port', cfg.port, TARGET);
  await config.update('user', cfg.user, TARGET);
  await config.update('password', cfg.password, TARGET);
  await config.update('remotePath', cfg.remotePath_posix, TARGET);
  await config.update('updateInterval', cfg.updateInterval, TARGET);
  await config.update('maxUploadSize', cfg.maxUploadSize, TARGET);
}