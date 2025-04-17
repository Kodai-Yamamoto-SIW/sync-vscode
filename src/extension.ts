// SFTP自動同期拡張機能

// 必要なパッケージのインポート
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'ssh2';
import * as chokidar from 'chokidar';

// SFTP接続設定インターフェース
interface SftpConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	remotePath: string;
	updateInterval: number;
}

// 拡張機能のアクティベーション関数
export function activate(context: vscode.ExtensionContext) {
	console.log('SFTP Sync拡張機能がアクティブになりました');

	// SFTPクライアントの初期化
	const sftpClient = new Client();

	// 監視中のファイル変更を保持するセット
	let changedFiles = new Set<string>();

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
			vscode.window.showInformationMessage('SFTP同期を開始しました');
		} catch (error) {
			vscode.window.showErrorMessage(`同期の開始に失敗しました: ${error}`);
		}
	});

	let stopSyncCommand = vscode.commands.registerCommand('ftp-sync.stopSync', () => {
		stopWatching();
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
			value: config.remotePath || '/'
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
			remotePath,
			updateInterval: parseInt(updateInterval)
		};

		saveConfig(config);
		vscode.window.showInformationMessage('SFTP設定を保存しました');
	});

	// ファイル監視を開始する関数
	async function startWatching() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			throw new Error('開いているワークスペースがありません');
		}

		const workspaceRoot = workspaceFolders[0].uri.fsPath;

		// SFTPクライアントに接続
		try {
			sftpClient.connect({
				host: config.host,
				port: config.port,
				username: config.user,
				password: config.password
			});

			sftpClient.on('ready', () => {
				console.log('SFTP接続に成功しました');

				// リモートディレクトリに移動
				sftpClient.sftp((err: Error | undefined, sftp: any) => {
					if (err) {
						throw new Error(`SFTPエラー: ${err}`);
					}
					sftp.mkdir(config.remotePath, { recursive: true }, (err: Error) => {
						if (err) {
							throw new Error(`リモートディレクトリ作成エラー: ${err.message}`);
						}

						// ファイル監視の設定
						const watcher = chokidar.watch(workspaceRoot, {
							ignored: /(^|[\/\\])\../, // 隠しファイルを無視
							persistent: true
						});

						// ファイル変更イベントのハンドリング
						watcher
							.on('add', path => addChangedFile(path))
							.on('change', path => addChangedFile(path))
							.on('unlink', path => {
								// ファイル削除の処理（将来的な拡張のため）
								console.log(`File ${path} has been removed`);
							});

						// 定期的な同期処理の開始
						syncTimerId = setInterval(syncChangedFiles, config.updateInterval * 1000);
					});
				});
			});

			sftpClient.on('error', (err) => {
				throw new Error(`SFTP接続エラー: ${err}`);
			});

			sftpClient.on('end', () => {
				console.log('SFTP接続を閉じました');
			});
		} catch (error) {
			throw new Error(`SFTP接続に失敗しました: ${error}`);
		}
	}

	// 監視を停止する関数
	function stopWatching() {
		if (syncTimerId) {
			clearInterval(syncTimerId);
			syncTimerId = undefined;
		}

		// SFTPクライアントを閉じる
		sftpClient.end();

		changedFiles.clear();
	}

	// 変更ファイルを記録する関数
	function addChangedFile(filePath: string) {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) return;

		const workspaceRoot = workspaceFolders[0].uri.fsPath;

		// ワークスペースからの相対パスに変換
		const relativePath = path.relative(workspaceRoot, filePath);

		// node_modules やその他無視すべきパターンを除外
		if (relativePath.startsWith('node_modules') ||
			relativePath.includes('.git') ||
			relativePath.endsWith('.log')) {
			return;
		}

		changedFiles.add(filePath);
		console.log(`File changed: ${filePath}`);
	}

	// 変更されたファイルを同期する関数
	async function syncChangedFiles() {
		if (changedFiles.size === 0) return;

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) return;

		const workspaceRoot = workspaceFolders[0].uri.fsPath;

		try {
			// SFTPクライアントが接続されていない場合は再接続
			// @ts-ignore
			if (!sftpClient._channel) {
				sftpClient.connect({
					host: config.host,
					port: config.port,
					username: config.user,
					password: config.password
				});
			}

			// 変更のあったファイルをアップロード
			sftpClient.sftp((err: Error | undefined, sftp: any) => {
				if (err) {
					console.error(`SFTPエラー: ${err}`);
					vscode.window.showErrorMessage(`同期エラー: ${err}`);
					return;
				}

				for (const file of changedFiles) {
					try {
						const relativePath = path.relative(workspaceRoot, file);
						const remoteFilePath = path.join(config.remotePath, relativePath).replace(/\\/g, '/');
						// ファイルのアップロード
						sftp.fastPut(file, remoteFilePath, (err: Error) => {
							if (err) {
								console.error(`Failed to upload ${file}: ${err.message}`);
							} else {
								console.log(`Uploaded: ${file} -> ${remoteFilePath}`);
								// 成功したらセットから削除
								changedFiles.delete(file);
							}
						});
					} catch (error) {
						console.error(`Failed to upload ${file}: ${error}`);
					}
				}
			});
		} catch (error) {
			console.error(`Sync error: ${error}`);
			vscode.window.showErrorMessage(`同期エラー: ${error}`);
		}
	}

	// 設定の読み込み
	function loadConfig(): SftpConfig {
		const config = vscode.workspace.getConfiguration('ftpSync');
		return {
			host: config.get('host') || '',
			port: config.get('port') || 22,
			user: config.get('user') || '',
			password: config.get('password') || '',
			remotePath: config.get('remotePath') || '/',
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
		config.update('remotePath', ftpConfig.remotePath, vscode.ConfigurationTarget.Global);
		config.update('updateInterval', ftpConfig.updateInterval, vscode.ConfigurationTarget.Global);
	}

	context.subscriptions.push(startSyncCommand, stopSyncCommand, configureCommand);
}

// 拡張機能の非アクティブ化関数
export function deactivate() {
	console.log('SFTP Sync拡張機能が非アクティブになりました');
}