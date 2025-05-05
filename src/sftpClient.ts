import { Client, SFTPWrapper } from 'ssh2';
import { loadConfig } from './config';
import { showSftpError } from './utils';
import { ErrorCode, showError } from './errors';

let activeSftp: SFTPWrapper | null = null;
let sftpClient: Client | null = null;

// SFTPクライアント接続処理
export async function getSftpClient(): Promise<SFTPWrapper> {
  if (activeSftp) {
    return activeSftp;
  }
  // 常に最新の設定を取得
  const cfg = loadConfig();
  sftpClient = new Client();
  return new Promise((resolve, reject) => {
    sftpClient!
      .on('ready', () => {
        console.log('SFTP接続に成功しました');
        sftpClient!.sftp((err, sftp) => {
          if (err) {
            console.error(`SFTPエラー: ${err}`);
            reject(err);
          } else {
            activeSftp = sftp;
            resolve(sftp);
          }
        });
      })
      .on('error', (err) => {
        console.error(`SFTP接続エラー: ${err}`);
        reject(err);
      })
      .connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.user,
        password: cfg.password
      });
  });
}

// SFTP接続を閉じる
export function closeSftpClient(): void {
  if (activeSftp) {
    activeSftp = null;
  }
  if (sftpClient) {
    sftpClient.end();
    sftpClient = null;
    console.log('SFTP接続を閉じました');
  }
}

// エラー表示付きで SFTP接続を取得する
export async function safeGetSftpClient(
  fallbackPrefix: string
): Promise<SFTPWrapper | undefined> {
  // 取得を試行する関数（再帰的に呼び出すことでリトライを実現）
  async function tryGetClient(): Promise<SFTPWrapper | undefined> {
    try {
      return await getSftpClient();
    } catch (error) {
      const settingsUpdated = await showSftpError(error, fallbackPrefix);
      
      // 設定が更新された場合は再試行
      if (settingsUpdated) {
        console.log('設定を更新したため、接続を再試行します');
        // 再帰的に呼び出して再試行（何度でも繰り返し可能）
        return await tryGetClient();
      }
      
      // 設定が更新されなかった場合（ユーザーがキャンセルした場合など）
      return undefined;
    }
  }
  
  // 最初の試行を開始
  return await tryGetClient();
} 