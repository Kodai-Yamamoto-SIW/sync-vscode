// SFTP自動同期拡張機能
import * as vscode from 'vscode';
import { loadConfig, saveConfig } from './config';
import { safeGetSftpClient, closeSftpClient } from './sftpClient';
import { toPosixPath } from './utils';
import { startWatching as watcherStart, stopWatching as watcherStop, isWatching } from './watcher';
import { StatusBarController } from './statusBarController';
import { ErrorCode, showError } from './errors';

export let statusBarControllerInstance: StatusBarController;

/**
 * SFTP接続テストを実行する
 * @returns テスト成功したかどうか
 */
async function testSftpConnection(): Promise<boolean> {
  // プログレス通知を表示せずに直接接続テスト
  try {
    const client = await safeGetSftpClient('接続テストに失敗しました');
    if (client) {
      closeSftpClient();
      vscode.window.showInformationMessage('SFTP接続テストに成功しました');
      return true;
    }
  } catch (error) {
    console.error('SFTP接続テストエラー:', error);
  }
  
  return false;
}

/**
 * 同期を開始する共通機能
 * @param statusBarController 
 * @returns 同期の開始に成功したかどうか
 */
async function startSync(statusBarController: StatusBarController): Promise<boolean> {
  try {
    // 同期開始中の状態に変更
    statusBarController.setState('starting');
    
    await watcherStart();
    if (isWatching()) {
      statusBarController.setState('running');
      return true;
    }
  } catch (error) {
    await watcherStop();
    statusBarController.setState('idle');
    showError(ErrorCode.SyncStartFailed, error instanceof Error ? error.message : String(error));
  }
  return false;
}

/**
 * 設定変更後の処理
 * @param statusBarController UIのコントローラー
 * @param startSyncAfterConfig 設定後に同期を開始するかどうか
 */
async function handleConfigChange(
  statusBarController: StatusBarController,
  startSyncAfterConfig: boolean
): Promise<void> {
  // SFTP接続をリセット
  closeSftpClient();
  
  // 監視中だった場合は再起動
  if (isWatching()) {
    try {
      await watcherStop();
      await watcherStart();
      if (isWatching()) {
        statusBarController.setState('running');
      }
    } catch (error) {
      statusBarController.setState('idle');
      showError(ErrorCode.SyncRestartFailed, error instanceof Error ? error.message : String(error));
    }
  } else if (startSyncAfterConfig) {
    // 設定後に同期を開始するよう指定されている場合
    await startSync(statusBarController);
  } else {
    // 監視中でない場合は接続テストのみ実行
    const progressNotification = vscode.window.withProgress(
      { 
        location: vscode.ProgressLocation.Notification, 
        title: 'SFTP接続テスト中です...',
        cancellable: false 
      },
      () => new Promise<void>(async resolve => {
        await testSftpConnection();
        resolve();
      })
    );
    
    // 通知が適切に終了するのを待つ
    await progressNotification;
  }
}

/**
 * 設定を行う関数（コマンドハンドラから分離）
 * @param statusBarController UIコントローラー
 * @param startSyncAfterConfig 設定後に同期を開始するかどうか
 * @returns 設定が完了したかどうか
 */
async function configureSettings(
  statusBarController: StatusBarController,
  startSyncAfterConfig: boolean
): Promise<boolean> {
  // 設定を毎回新しく読み込む（キャッシュを使わない）
  const config = loadConfig();
  
  // SFTP設定の入力
  const host = await vscode.window.showInputBox({
    prompt: 'SFTPホスト名を入力してください',
    value: config.host || ''
  });
  if (!host) return false;

  const port = await vscode.window.showInputBox({
    prompt: 'SFTPポート番号を入力してください',
    value: config.port?.toString() || '22'
  });
  if (!port) return false;

  const portNumber = parseInt(port, 10);
  if (isNaN(portNumber) || portNumber <= 0) {
    showError(ErrorCode.InvalidPort);
    return false;
  }

  const user = await vscode.window.showInputBox({
    prompt: 'SFTPユーザー名を入力してください',
    value: config.user || ''
  });
  if (!user) return false;

  const password = await vscode.window.showInputBox({
    prompt: 'SFTPパスワードを入力してください',
    value: config.password || '',
    password: true
  });
  if (!password) return false;

  const remotePath = await vscode.window.showInputBox({
    prompt: 'リモートのベースパスを入力してください',
    value: config.remotePath_posix || '/'
  });
  if (!remotePath) return false;

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
  
  console.log('SFTP設定が変更されました');
  // 設定変更後の処理を実行（同期開始するかどうかのフラグを渡す）
  await handleConfigChange(statusBarController, startSyncAfterConfig);
  return true;
}

// 拡張機能のアクティベーション関数
export function activate(context: vscode.ExtensionContext) {
  console.log('SFTP Sync拡張機能がアクティブになりました (activate)');

  // ステータスバーコントローラーを初期化
  const statusBarController = new StatusBarController();
  statusBarControllerInstance = statusBarController;
  context.subscriptions.push(statusBarController);

  // コマンドの登録
  let startSyncCommand = vscode.commands.registerCommand('ftp-sync.startSync', async () => {
    // 同期開始コマンド
    // 設定の読み込み
    const config = loadConfig();

    // 設定が完了しているか確認
    if (!config.host || !config.user) {
      showError(ErrorCode.IncompleteSettings);
      // 設定画面を表示し、設定保存後に同期を開始する
      const configCompleted = await configureSettings(statusBarController, true);
      if (!configCompleted) {
        statusBarController.setState('idle');
      }
      // 設定後の同期開始は configureSettings 内で行われるため、ここでは何もしない
      return;
    }

    // 既存の設定がある場合は同期を開始
    await startSync(statusBarController);
  });

  let stopSyncCommand = vscode.commands.registerCommand('ftp-sync.stopSync', async () => {
    await watcherStop();
    statusBarController.setState('idle');
    vscode.window.showInformationMessage('SFTP同期を停止しました');
  });

  let configureCommand = vscode.commands.registerCommand('ftp-sync.configureSettings', async () => {
    // 設定画面を表示するが、設定後の同期は開始しない
    await configureSettings(statusBarController, false);
  });

  // コマンド登録
  context.subscriptions.push(startSyncCommand, stopSyncCommand, configureCommand);
  context.subscriptions.push({ dispose: () => { watcherStop().catch(err => console.error(`停止時のエラー: ${err}`)); } });
}

// 拡張機能の非アクティブ化関数
export function deactivate() {
  console.log('SFTP Sync拡張機能が非アクティブになりました');
}