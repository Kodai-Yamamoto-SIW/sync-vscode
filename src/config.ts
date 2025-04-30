export interface SftpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath_posix: string;
  updateInterval: number;
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
    updateInterval: config.get('updateInterval') || 10
  };
}

export async function saveConfig(cfg: SftpConfig): Promise<void> {
  const config = vscode.workspace.getConfiguration('ftpSync');
  await config.update('host', cfg.host, vscode.ConfigurationTarget.Global);
  await config.update('port', cfg.port, vscode.ConfigurationTarget.Global);
  await config.update('user', cfg.user, vscode.ConfigurationTarget.Global);
  await config.update('password', cfg.password, vscode.ConfigurationTarget.Global);
  await config.update('remotePath', cfg.remotePath_posix, vscode.ConfigurationTarget.Global);
  await config.update('updateInterval', cfg.updateInterval, vscode.ConfigurationTarget.Global);
} 