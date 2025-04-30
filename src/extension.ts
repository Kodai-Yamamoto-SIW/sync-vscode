// SFTP自動同期拡張機能
import * as vscode from 'vscode';
import { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import * as fs from 'fs';
import * as pathUtil from 'path';
import { Client } from 'ssh2';
import * as chokidar from 'chokidar';
import { loadConfig, saveConfig } from './config';
import { getSftpClient, closeSftpClient, safeGetSftpClient } from './sftpClient';
import { showSftpError, toLocalPath, toPosixPath } from './utils';
import { sftpMkdirRecursive, listRemoteFilesRecursiveRelative, listLocalFilesRecursiveRelative, handleDelete, deleteRemoteFile } from './sftpUtils';
import { startWatching as watcherStart, stopWatching as watcherStop } from './watcher';
import { StatusBarController } from './statusBarController';

// SFTP接続設定インターフェース
interface SftpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath_posix: string;
  updateInterval: number;
}

// 現在のアクティブなSFTP接続を保持する変数
let activeSftp: SFTPWrapper | null = null;

// SFTPクライアントインスタンスを保持（接続毎に再生成）
let sftpClient: Client | null = null;

// 拡張機能のアクティベーション関数
export function activate(context: vscode.ExtensionContext) {
  console.log('SFTP Sync拡張機能がアクティブになりました (activate)');

  // ステータスバーコントローラーを初期化
  const statusBarController = new StatusBarController();
  context.subscriptions.push(statusBarController);

  // 監視中のファイル変更を保持するマップ
  let changedRelativePaths_posix = new Map<string, 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'>();

  // タイマーID
  let syncTimerId: NodeJS.Timeout | undefined;

  // 同時実行を防ぐフラグ
  let isSyncing = false;

  // 設定の読み込み
  let config = loadConfig();

  // 共通のSFTP接続エラー表示関数 (activate スコープ内)
  function showSftpError(error: unknown, fallbackPrefix?: string) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const host = config.host;
    const user = config.user;
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

  // コマンドの登録
  let startSyncCommand = vscode.commands.registerCommand('ftp-sync.startSync', async () => {
    if (syncTimerId) {
      vscode.window.showInformationMessage('同期は既に開始されています');
      return;
    }

    // 設定が完了しているか確認
    if (!config.host || !config.user) {
      vscode.window.showErrorMessage('SFTP設定が不完全です。設定を確認してください');
      await vscode.commands.executeCommand('ftp-sync.configureSettings');
      // 設定完了後に再読み込み
      config = loadConfig();
      if (!config.host || !config.user) {
        return;
      }
    }

    try {
      await watcherStart();
      // 同期開始後、ステータスバー更新
      statusBarController.setState('running');
    } catch (error) {
      await watcherStop();
      statusBarController.setState('idle');
      showSftpError(error, '同期の開始に失敗しました');
    }
  });

  let stopSyncCommand = vscode.commands.registerCommand('ftp-sync.stopSync', async () => {
    await watcherStop();
    // 同期停止後、ステータスバー更新
    statusBarController.setState('idle');
    vscode.window.showInformationMessage('SFTP同期を停止しました');
  });

  let configureCommand = vscode.commands.registerCommand('ftp-sync.configureSettings', async () => {
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
      vscode.window.showErrorMessage('無効なポート番号です');
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

    const updateInterval = await vscode.window.showInputBox({
      prompt: '更新間隔（秒）を入力してください',
      value: config.updateInterval?.toString() || '10'
    });
    if (!updateInterval) return;

    const intervalNumber = parseInt(updateInterval, 10);
    if (isNaN(intervalNumber) || intervalNumber <= 0) {
      vscode.window.showErrorMessage('無効な同期間隔です');
      return;
    }

    // 設定の保存
    config = {
      host,
      port: portNumber,
      user,
      password,
      remotePath_posix: toPosixPath(pathUtil.posix.normalize(remotePath)),
      updateInterval: intervalNumber
    };

    await saveConfig(config);
    vscode.window.showInformationMessage('SFTP設定を保存しました');
    closeSftpClient();

    // 接続テスト（プログレス通知＋詳細エラー表示）
    const testSftp = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SFTP接続テスト中です...' },
      () => safeGetSftpClient('接続テストに失敗しました')
    );
    if (testSftp) {
      closeSftpClient();
      vscode.window.showInformationMessage('SFTP接続テストに成功しました');
    }

    // 同期中の場合は再起動
    if (syncTimerId) {
      vscode.window.showInformationMessage('SFTP設定が変更されたため、同期を再起動します');
      await watcherStop();
      try {
        await watcherStart();
        // 設定変更後も同期中なのでステータスバー更新
        statusBarController.setState('running');
      } catch (error) {
        showSftpError(error, '同期の再起動に失敗しました');
      }
    }
  });

  // ファイル監視 and 同期処理は ./watcher モジュールに委譲しました

  // コマンド登録のみ行う
  context.subscriptions.push(startSyncCommand, stopSyncCommand, configureCommand);
  // 拡張機能の非アクティブ化時にウォッチャーとSFTPをクリーンアップ
  context.subscriptions.push({ dispose: () => { watcherStop().catch((err: unknown) => console.error(`停止時のエラー: ${err}`)); } });
}

// 拡張機能の非アクティブ化関数
export function deactivate() {
  console.log('SFTP Sync拡張機能が非アクティブになりました');
}