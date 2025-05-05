import * as vscode from 'vscode';
import { loadConfig } from './config';

/**
 * 同期状態に応じてステータスバーのボタンを表示・更新するコントローラー
 */
export class StatusBarController implements vscode.Disposable {
  private syncItem: vscode.StatusBarItem;
  private _state: 'idle' | 'starting' | 'running' = 'idle';

  constructor() {
    // 同期開始/停止ボタン（右側、優先度99）
    this.syncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    // 設定の有無にかかわらず同期ボタンを表示
    this.updateSyncItem();
    this.syncItem.show();
  }

  /**
   * 現在の同期状態を取得します
   */
  public get state(): 'idle' | 'starting' | 'running' {
    return this._state;
  }

  /**
   * 同期状態を更新してボタン表示を切り替えます
   */
  public setState(state: 'idle' | 'starting' | 'running') {
    this._state = state;
    this.updateSyncItem();
  }

  /**
   * ステータスバーアイテムの内容を更新します
   */
  private updateSyncItem() {
    if (this._state === 'idle') {
      this.syncItem.text = '$(cloud-upload) SFTP 同期開始';
      this.syncItem.command = 'ftp-sync.startSync';
      this.syncItem.tooltip = 'クリックで SFTP 同期を開始';
    } else if (this._state === 'starting') {
      this.syncItem.text = '$(sync~spin) SFTP 同期開始中';
      this.syncItem.command = undefined;
      this.syncItem.tooltip = 'SFTP 同期の初期化中...';
    } else {
      this.syncItem.text = '$(sync~spin) SFTP 同期停止';
      this.syncItem.command = 'ftp-sync.stopSync';
      this.syncItem.tooltip = 'クリックで SFTP 同期を停止';
    }
  }

  public dispose() {
    this.syncItem.dispose();
  }
} 