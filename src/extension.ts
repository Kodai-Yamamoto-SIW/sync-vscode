// SFTP自動同期拡張機能
import * as vscode from 'vscode';
import { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import * as fs from 'fs';
import * as pathUtil from 'path';
import { Client } from 'ssh2';
import * as chokidar from 'chokidar';

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

// 拡張機能のアクティベーション関数
export function activate(context: vscode.ExtensionContext) {
  console.log('SFTP Sync拡張機能がアクティブになりました (activate)');

  // SFTPクライアントの初期化
  const sftpClient = new Client();

  // 監視中のファイル変更を保持するマップ
  let changedRelativePaths_posix = new Map<string, 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'>();

  // タイマーID
  let syncTimerId: NodeJS.Timeout | undefined;

  // 設定の読み込み
  let config = loadConfig();

  // コマンドの登録
  let startSyncCommand = vscode.commands.registerCommand('ftp-sync.startSync', async () => {
    if (syncTimerId) {
      vscode.window.showInformationMessage('同期は既に開始されています');
      return;
    }

    // 設定が完了しているか確認
    if (!config.host || !config.user) {
      vscode.window.showErrorMessage('SFTP設定が不完全です。設定を確認してください');
      vscode.commands.executeCommand('ftp-sync.configureSettings');
      return;
    }

    try {
      await startWatching();
    } catch (error) {
      await stopWatching();
      vscode.window.showErrorMessage(`同期の開始に失敗しました: ${error}`);
    }
  });

  let stopSyncCommand = vscode.commands.registerCommand('ftp-sync.stopSync', async () => {
    await stopWatching();
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

    // 設定の保存
    config = {
      host,
      port: parseInt(port),
      user,
      password,
      remotePath_posix: remotePath,
      updateInterval: parseInt(updateInterval)
    };

    saveConfig(config);
    vscode.window.showInformationMessage('SFTP設定を保存しました');

    // 同期中の場合は再起動
    if (syncTimerId) {
      vscode.window.showInformationMessage('SFTP設定が変更されたため、同期を再起動します');
      await stopWatching();
      try {
        await startWatching();
      } catch (error) {
        vscode.window.showErrorMessage(`同期の再起動に失敗しました: ${error}`);
      }
    }
  });

  let watcher: chokidar.FSWatcher | undefined;

  // 新しい関数: SFTPクライアント接続処理をまとめる（多重接続防止）
  async function getSftpClient(): Promise<SFTPWrapper> {
    if (activeSftp) {
      return activeSftp; // 既存の接続を再利用
    }

    return new Promise((resolve, reject) => {
      sftpClient.connect({
        host: config.host,
        port: config.port,
        username: config.user,
        password: config.password
      })
        .on('ready', () => {
          console.log('SFTP接続に成功しました');
          sftpClient.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
            if (err) {
              console.error(`SFTPエラー: ${err}`);
              reject(err);
            } else {
              activeSftp = sftp; // 接続を保存
              resolve(sftp);
            }
          });
        })
        .on('error', (err) => {
          console.error(`SFTP接続エラー: ${err}`);
          reject(err);
        });
    });
  }

  // SFTP接続を閉じる関数
  function closeSftpClient() {
    if (activeSftp) {
      activeSftp = null;
      sftpClient.end();
      console.log('SFTP接続を閉じました');
    }
  }

  // ファイル監視を開始する関数
  async function startWatching() {
    if (watcher) {
      console.log('ファイル監視は既に開始されています');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      throw new Error('開いているワークスペースがありません');
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    try {
      const sftp = await getSftpClient();

      // リモートディレクトリの削除登録
      await registerFileDeletions();

      // ファイル監視の設定
      watcher = chokidar.watch(workspaceRoot, {
        ignored: /(^|[\/\\])\../, // 隠しファイルを無視
        persistent: true
      });

      // ファイル変更イベントのハンドリング
      watcher
        .on('all', (eventName, path) => {
          const relativePath_posix = toPosixPath(pathUtil.relative(workspaceRoot, path));
          addChangedFile(relativePath_posix, eventName as 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir');
        });

      console.log('ファイル監視を開始しました');

      // 監視を停止する関数
      watcher.on('ready', () => {
        console.log('Watcher is ready');
      });
      // 監視が終了したら、同期を停止
      watcher.on('end', async () => {
        console.log('Watcher has ended');
        await stopWatching();
      });
      // 監視がエラーになったら、同期を停止
      watcher.on('error', async (error) => {
        console.error(`Watcher error: ${error}`);
        await stopWatching();
      });

      // 定期的な同期処理の開始
      syncTimerId = setInterval(syncChangedFiles, config.updateInterval * 1000);

      vscode.window.showInformationMessage('SFTP同期を開始しました');
      startStopStatusBarItem.text = 'SFTP同期停止';
      startStopStatusBarItem.tooltip = 'SFTP同期を停止します';
      startStopStatusBarItem.command = 'ftp-sync.stopSync';
      startStopStatusBarItem.show();
    } catch (error) {
      await stopWatching();
      vscode.window.showErrorMessage(`同期の開始に失敗しました: ${error}`);
    }
  }

  // パスをローカル形式に変換する関数
  function toLocalPath(path: string): string {
    return path.replaceAll(pathUtil.posix.sep, pathUtil.sep);
  }

  // パスをPOSIX形式に変換する関数
  function toPosixPath(path: string): string {
    return path.replaceAll(pathUtil.sep, pathUtil.posix.sep);
  }

  // 新しい関数: 再帰的にディレクトリを作成する関数
  async function sftpMkdirRecursive(sftp: SFTPWrapper, dirPath_posix: string): Promise<void> {
    const rootPath_posix = pathUtil.parse(dirPath_posix).root;
    const pathParts = dirPath_posix.slice(rootPath_posix.length).split(pathUtil.posix.sep);

    let currentPath = rootPath_posix;
    for (const pathPart of pathParts) {
      currentPath = pathUtil.posix.join(currentPath, pathPart);
      await new Promise<void>((resolve, reject) => {
        sftp.stat(currentPath, (statErr: Error | undefined) => {
          if (statErr && statErr.message.includes('No such file')) {
            sftp.mkdir(currentPath, (mkdirErr?: Error | null) => {
              if (mkdirErr) {
                console.error(`Failed to create directory ${currentPath}: ${mkdirErr.message}`);
                reject(mkdirErr);
              } else {
                console.log(`Created directory: ${currentPath}`);
                resolve();
              }
            });
          } else if (statErr) {
            console.error(`Failed to stat directory ${currentPath}: ${statErr.message}`);
            reject(statErr);
          } else {
            resolve(); // Directory already exists
          }
        });
      });
    }
  }

  // 監視を停止する関数
  async function stopWatching() {
    if (syncTimerId) {
      clearInterval(syncTimerId);
      syncTimerId = undefined;
    }

    // ファイル監視を停止
    if (watcher) {
      await watcher.close();
      watcher = undefined;
    }

    // SFTPクライアントを閉じる
    closeSftpClient();

    // ステータスバーアイテムを更新して、同期を開始できることを示す
    startStopStatusBarItem.text = 'SFTP同期開始';
    startStopStatusBarItem.tooltip = 'SFTP同期を開始します';
    startStopStatusBarItem.command = 'ftp-sync.startSync';

    changedRelativePaths_posix.clear();
  }

  // ファイル削除を登録する関数
  async function registerFileDeletions() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      throw new Error('開いているワークスペースがありません');
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const remotePath_posix = config.remotePath_posix;

    const sftp = await getSftpClient();

    // リモートディレクトリが存在するか確認し、存在しない場合は作成
    await sftpMkdirRecursive(sftp, remotePath_posix);

    // リモートのファイルとディレクトリをリストアップ
    const remoteRelativeFilePaths = await listRemoteFilesRecursiveRelative(remotePath_posix);

    // ローカルのファイルとディレクトリをリストアップ
    const localRelativeFilePaths = await listLocalFilesRecursiveRelative(workspaceRoot);

    console.log('リモートファイル:', remoteRelativeFilePaths);
    console.log('ローカルファイル:', localRelativeFilePaths);

    // リモートに存在し、ローカルに存在しないファイルを削除登録
    for (const remoteRelativeFilePath of remoteRelativeFilePaths) {
      if (!localRelativeFilePaths.includes(remoteRelativeFilePath)) {
        const remoteFilePath = pathUtil.posix.join(remotePath_posix, remoteRelativeFilePath);
        try {
          const isDirectory = await new Promise<boolean>((resolve, reject) => {
            sftp.stat(remoteFilePath, (err: Error | undefined, stats: Stats) => {
              if (err) {
                if (err.message.includes('No such file')) {
                  resolve(false); // Treat as non-existent
                } else {
                  reject(err);
                }
              } else {
                resolve(stats.isDirectory());
              }
            });
          });

          const changeType = isDirectory ? 'unlinkDir' : 'unlink';
          addChangedFile(remoteRelativeFilePath, changeType);
          console.log(`Registered for deletion (${changeType}): ${remoteFilePath}`);
        } catch (error) {
          console.error(`Failed to stat remote path: ${remoteFilePath} - ${error}`);
        }
      }
    }
  }

  // リモートのファイルとディレクトリを再帰的にリストアップする関数
  async function listRemoteFilesRecursiveRelative(remotePath_posix: string): Promise<string[]> {
    const sftp = await getSftpClient();
    const remotePaths_posix: string[] = [];

    async function walk(path_posix: string) {
      return new Promise<void>((resolve, reject) => {
        sftp.readdir(path_posix, async (err: Error | undefined, list: FileEntryWithStats[]) => {
          if (err) {
            console.error(`SFTPエラー: ${err}`);
            reject(err);
            return;
          }

          for (const item of list) {
            const itemPath_posix = pathUtil.posix.join(path_posix, item.filename);
            const relativePath_posix = pathUtil.posix.relative(remotePath_posix, itemPath_posix);
            remotePaths_posix.push(relativePath_posix);

            if (item.attrs.isDirectory()) {
              await walk(itemPath_posix);
            }
          }
          resolve();
        });
      });
    }

    await walk(remotePath_posix);
    return remotePaths_posix;
  }

  // ローカルのファイルとディレクトリを再帰的にリストアップする関数
  async function listLocalFilesRecursiveRelative(workspaceRoot: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = pathUtil.join(dir, item);
        const relativePath = pathUtil.relative(workspaceRoot, itemPath);
        files.push(relativePath);

        if (fs.statSync(itemPath).isDirectory()) {
          await walk(itemPath);
        }
      }
    }

    await walk(workspaceRoot);
    return files;
  }

  // 新しい関数: ファイルまたはディレクトリの削除を処理
  async function handleDelete(sftp: SFTPWrapper, remoteFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.stat(remoteFilePath, (statErr: Error | undefined, stats: Stats) => {
        if (statErr) {
          if (statErr.message.includes('No such file')) {
            console.log(`File or directory does not exist: ${remoteFilePath}. Treating as success.`);
            vscode.window.showInformationMessage(`削除成功(存在しないため): ${remoteFilePath}`);
            resolve();
          } else {
            console.error(`Failed to stat ${remoteFilePath}: ${statErr?.message}`);
            reject(statErr);
          }
          return;
        }

        const deleteAction = stats.isDirectory() ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);

        deleteAction(remoteFilePath, (err?: Error | null) => {
          if (err) {
            console.error(`Failed to delete ${remoteFilePath}: ${err.message}`);
            reject(err);
          } else {
            console.log(`Deleted: ${remoteFilePath}`);
            resolve();
          }
        });
      });
    });
  }

  // リモートファイルを削除する関数
  async function deleteRemoteFile(remoteFilePath: string): Promise<void> {
    const sftp = await getSftpClient();
    await handleDelete(sftp, remoteFilePath);
  }

  // 設定の読み込み
  function loadConfig(): SftpConfig {
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

  // 設定の保存
  function saveConfig(ftpConfig: SftpConfig) {
    const config = vscode.workspace.getConfiguration('ftpSync');
    config.update('host', ftpConfig.host, vscode.ConfigurationTarget.Global);
    config.update('port', ftpConfig.port, vscode.ConfigurationTarget.Global);
    config.update('user', ftpConfig.user, vscode.ConfigurationTarget.Global);
    config.update('password', ftpConfig.password, vscode.ConfigurationTarget.Global);
    config.update('remotePath', ftpConfig.remotePath_posix, vscode.ConfigurationTarget.Global);
    config.update('updateInterval', ftpConfig.updateInterval, vscode.ConfigurationTarget.Global);
  }

  // 変更ファイルを記録する関数
  function addChangedFile(relativePath_posix: string, type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir') {
    // 変更情報をマップに追加
    changedRelativePaths_posix.set(relativePath_posix, type);
    console.log(`${type}: ${relativePath_posix}`);
  }

  // 変更されたファイルを同期する関数
  async function syncChangedFiles() {
    console.log('syncChangedFiles 関数が実行されました');

    if (changedRelativePaths_posix.size === 0) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const sftp = await getSftpClient();

    // 変更を種類ごとに分類
    const addDirPaths_posix: string[] = [];
    const addOrChangePaths_posix: string[] = [];
    const fileDeletionPaths_posix: string[] = [];
    const dirDeletionPaths_posix: string[] = [];

    for (const [changedRelativePath_posix, type] of changedRelativePaths_posix) {
      switch (type) {
        case 'addDir':
          addDirPaths_posix.push(changedRelativePath_posix);
          break;
        case 'add':
        case 'change':
          addOrChangePaths_posix.push(changedRelativePath_posix);
          break;
        case 'unlink':
          fileDeletionPaths_posix.push(changedRelativePath_posix);
          break;
        case 'unlinkDir':
          dirDeletionPaths_posix.push(changedRelativePath_posix);
          break;
        default:
          console.error(`Unknown change type: ${type}`);
          break;
      }
    }

    try {
      // 1. ファイル削除を先に実行
      for (const relativePath_posix of fileDeletionPaths_posix) {
        const remoteFilePath_posix = pathUtil.posix.join(config.remotePath_posix, relativePath_posix);
        try {
          await handleDelete(sftp, remoteFilePath_posix);
          changedRelativePaths_posix.delete(relativePath_posix);
        } catch (error) {
          console.error(`Failed to delete file ${remoteFilePath_posix}: ${error}`);
        }
      }

      // 2. フォルダ削除を次に実行（深い階層から削除）
      dirDeletionPaths_posix.sort((a, b) => b.length - a.length);
      for (const relativePath_posix of dirDeletionPaths_posix) {
        const remoteDirPath_posix = pathUtil.posix.join(config.remotePath_posix, relativePath_posix);
        try {
          await handleDelete(sftp, remoteDirPath_posix);
          changedRelativePaths_posix.delete(relativePath_posix);
        } catch (error) {
          console.error(`Failed to delete directory ${remoteDirPath_posix}: ${error}`);
        }
      }

      // 3. フォルダ作成を次に実行（浅い階層から作成）
      addDirPaths_posix.sort((a, b) => a.length - b.length);
      for (const relativePath_posix of addDirPaths_posix) {
        const remoteDirPath_posix = pathUtil.posix.join(config.remotePath_posix, relativePath_posix);
        try {
          await sftpMkdirRecursive(sftp, remoteDirPath_posix);
          changedRelativePaths_posix.delete(relativePath_posix);
        } catch (error) {
          console.error(`Failed to create directory ${remoteDirPath_posix}: ${error}`);
        }
      }

      // 4. ファイルのアップロードを最後に実行
      for (const relativePath_posix of addOrChangePaths_posix) {
        const localFilePath = pathUtil.join(workspaceRoot, toLocalPath(relativePath_posix));
        const remoteFilePath_posix = pathUtil.posix.join(config.remotePath_posix, relativePath_posix);
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.fastPut(localFilePath, remoteFilePath_posix, (err?: Error | null) => {
              if (err) {
                console.error(`Upload failed: ${localFilePath} -> ${remoteFilePath_posix} - ${err.message}`);
                reject(err);
              } else {
                console.info(`Upload successful: ${localFilePath} -> ${remoteFilePath_posix}`);
                changedRelativePaths_posix.delete(relativePath_posix);
                resolve();
              }
            });
          });
        } catch (error) {
          console.error(`Failed to upload ${localFilePath}: ${error}`);
        }
      }
    } catch (error) {
      console.error(`Sync error: ${error}`);
      vscode.window.showErrorMessage(`同期エラー: ${error}`);
    }
  }

  // ステータスバーにボタンを追加
  const configStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  configStatusBarItem.text = 'SFTP設定';
  configStatusBarItem.command = 'ftp-sync.configureSettings';
  configStatusBarItem.tooltip = 'SFTP設定を開きます';
  configStatusBarItem.show();

  let startStopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  startStopStatusBarItem.text = syncTimerId ? 'SFTP同期停止' : 'SFTP同期開始';
  startStopStatusBarItem.command = syncTimerId ? 'ftp-sync.stopSync' : 'ftp-sync.startSync';
  startStopStatusBarItem.tooltip = syncTimerId ? 'SFTP同期を停止します' : 'SFTP同期を開始します';
  startStopStatusBarItem.show();

  context.subscriptions.push(startSyncCommand, stopSyncCommand, configureCommand, configStatusBarItem, startStopStatusBarItem);
}

// 拡張機能の非アクティブ化関数
export function deactivate() {
  console.log('SFTP Sync拡張機能が非アクティブになりました');
}