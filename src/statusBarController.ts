import * as vscode from 'vscode';
import { loadConfig } from './config';

/**
 * 同期状態に応じてステータスバーのボタンを表示・更新するコントローラー
 */
export class StatusBarController implements vscode.Disposable {
  private syncItem: vscode.StatusBarItem;
  private configItem: vscode.StatusBarItem;
  private state: 'idle' | 'running' = 'idle';

  constructor() {
    // 同期開始/停止ボタン（右側、優先度99）
    this.syncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    // 初期設定が完了していなければ同期ボタンは非表示
    const cfg = loadConfig();
    if (cfg.host && cfg.user) {
      this.updateSyncItem();
      this.syncItem.show();
    }
    // 設定ボタン（右側、優先度100）
    this.configItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.configItem.text = '$(gear) SFTP 設定';
    this.configItem.command = 'ftp-sync.configureSettings';
    this.configItem.tooltip = 'SFTP設定を開きます';
    this.configItem.show();
  }

  /**
   * 同期状態を更新してボタン表示を切り替えます
   */
  public setState(state: 'idle' | 'running') {
    this.state = state;
    this.updateSyncItem();
  }

  /**
   * ステータスバーアイテムの内容を更新します
   */
  private updateSyncItem() {
    if (this.state === 'idle') {
      this.syncItem.text = '$(cloud-upload) SFTP 同期開始';
      this.syncItem.command = 'ftp-sync.startSync';
      this.syncItem.tooltip = 'クリックで SFTP 同期を開始';
    } else {
      this.syncItem.text = '$(sync~spin) SFTP 同期停止';
      this.syncItem.command = 'ftp-sync.stopSync';
      this.syncItem.tooltip = 'クリックで SFTP 同期を停止';
    }
  }

  public dispose() {
    this.syncItem.dispose();
    this.configItem.dispose();
  }
} 