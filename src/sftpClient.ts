import { Client, SFTPWrapper } from 'ssh2';
import { loadConfig } from './config';
import { showSftpError } from './utils';

let activeSftp: SFTPWrapper | null = null;
let sftpClient: Client | null = null;

// SFTPクライアント接続処理
export async function getSftpClient(): Promise<SFTPWrapper> {
  if (activeSftp) {
    return activeSftp;
  }
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
  try {
    return await getSftpClient();
  } catch (error) {
    showSftpError(error, fallbackPrefix);
    return undefined;
  }
} 