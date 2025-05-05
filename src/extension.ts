// SFTP自動同期拡張機能
import * as vscode from 'vscode';
import { loadConfig, saveConfig } from './config';
import { safeGetSftpClient, closeSftpClient } from './sftpClient';
import { toPosixPath } from './utils';
import { startWatching as watcherStart, stopWatching as watcherStop, isWatching } from './watcher';
import { StatusBarController } from './statusBarController';
import { ErrorCode, showError } from './errors';

export let statusBarControllerInstance: StatusBarController;

// 拡張機能のアクティベーション関数
export function activate(context: vscode.ExtensionContext) {
  console.log('SFTP Sync拡張機能がアクティブになりました (activate)');

  // ステータスバーコントローラーを初期化
  const statusBarController = new StatusBarController();
  statusBarControllerInstance = statusBarController;
  context.subscriptions.push(statusBarController);

  
  // 設定変更イベントをリッスン
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      // ftpSync設定のいずれかが変更された場合
      if (event.affectsConfiguration('ftpSync')) {
        console.log('SFTP設定が変更されました');
        
        // 設定変更時にSFTP接続をリセット
        closeSftpClient();
        
        // 監視中なら再起動を提案
        if (isWatching()) {
          vscode.window.showInformationMessage(
            'SFTP設定が変更されました。同期を再起動しますか？', 
            '再起動する'
          ).then(selection => {
            if (selection === '再起動する') {
              watcherStop().then(() => {
                watcherStart().catch(error => {
                  showError(ErrorCode.SyncRestartFailed, error instanceof Error ? error.message : String(error));
                });
              });
            }
          });
        }
      }
    })
  );

  // コマンドの登録
  let startSyncCommand = vscode.commands.registerCommand('ftp-sync.startSync', async () => {
    // 同期開始コマンド
    // 設定の読み込み
    const config = loadConfig();

    // 設定が完了しているか確認
    if (!config.host || !config.user) {
      showError(ErrorCode.IncompleteSettings);
      await vscode.commands.executeCommand('ftp-sync.configureSettings');
      const newcfg = loadConfig();
      if (!newcfg.host || !newcfg.user) {
        return;
      }
    }

    try {
      // 同期開始中の状態に変更
      statusBarController.setState('starting');
      
      await watcherStart();
      if (isWatching()) {
        statusBarController.setState('running');
      }
    } catch (error) {
      await watcherStop();
      statusBarController.setState('idle');
      showError(ErrorCode.SyncStartFailed, error instanceof Error ? error.message : String(error));
    }
  });

  let stopSyncCommand = vscode.commands.registerCommand('ftp-sync.stopSync', async () => {
    await watcherStop();
    statusBarController.setState('idle');
    vscode.window.showInformationMessage('SFTP同期を停止しました');
  });

  let configureCommand = vscode.commands.registerCommand('ftp-sync.configureSettings', async () => {
    // 設定を毎回新しく読み込む（キャッシュを使わない）
    const config = loadConfig();
    
    // SFTP設定の入力
    const host = await vscode.window.showInputBox({
      prompt: 'SFTPホスト名を入力してください',
      value: config.host || ''
    });
    if (!host) return;

    const port = await vscode.window.showInputBox({
      prompt: 'SFTPポート番号を入力してください',
      value: config.port?.toString() || '22'
    });
    if (!port) return;

    const portNumber = parseInt(port, 10);
    if (isNaN(portNumber) || portNumber <= 0) {
      showError(ErrorCode.InvalidPort);
      return;
    }

    const user = await vscode.window.showInputBox({
      prompt: 'SFTPユーザー名を入力してください',
      value: config.user || ''
    });
    if (!user) return;

    const password = await vscode.window.showInputBox({
      prompt: 'SFTPパスワードを入力してください',
      value: config.password || '',
      password: true
    });
    if (!password) return;

    const remotePath = await vscode.window.showInputBox({
      prompt: 'リモートのベースパスを入力してください',
      value: config.remotePath_posix || '/'
    });
    if (!remotePath) return;

    // 設定の保存
    const newcfg = {
      host,
      port: portNumber,
      user,
      password,
      remotePath_posix: toPosixPath(remotePath),
      maxUploadSize: config.maxUploadSize
    };

    await saveConfig(newcfg);
    vscode.window.showInformationMessage('SFTP設定を保存しました');
    closeSftpClient();

    const testSftp = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SFTP接続テスト中です...' },
      () => safeGetSftpClient('接続テストに失敗しました')
    );
    if (testSftp) {
      closeSftpClient();
      vscode.window.showInformationMessage('SFTP接続テストに成功しました');
    }

    // 設定変更後は同期を再起動（動作中なら）
    if (isWatching()) {
      vscode.window.showInformationMessage('SFTP設定が変更されたため、同期を再起動します');
      await watcherStop();
      try {
        await watcherStart();
        if (isWatching()) {
          statusBarController.setState('running');
        }
      } catch (error) {
        showError(ErrorCode.SyncRestartFailed, error instanceof Error ? error.message : String(error));
      }
    }
  });

  // コマンド登録
  context.subscriptions.push(startSyncCommand, stopSyncCommand, configureCommand);
  context.subscriptions.push({ dispose: () => { watcherStop().catch(err => console.error(`停止時のエラー: ${err}`)); } });
}

// 拡張機能の非アクティブ化関数
export function deactivate() {
  console.log('SFTP Sync拡張機能が非アクティブになりました');
}