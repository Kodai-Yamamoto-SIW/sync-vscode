import * as vscode from 'vscode';

export enum ErrorCode {
    IncompleteSettings = 'incompleteSettings',
    InvalidPort = 'invalidPort',
    WorkspaceMissing = 'workspaceMissing',
    PermissionDenied = 'permissionDenied',
    HostConnectionFailed = 'hostConnectionFailed',
    AuthFailed = 'authFailed',
    SyncStartFailed = 'syncStartFailed',
    SyncRestartFailed = 'syncRestartFailed',
    SyncError = 'syncError',
    Unknown = 'unknown',
}

const messages: Record<ErrorCode, string> = {
    [ErrorCode.IncompleteSettings]: 'SFTP設定が不完全です。設定を確認してください。',
    [ErrorCode.InvalidPort]: '無効なポート番号です。',
    [ErrorCode.WorkspaceMissing]: 'ワークスペースがありません。',
    [ErrorCode.PermissionDenied]: 'アクセス権限がありません。',
    [ErrorCode.HostConnectionFailed]: 'ホストに接続できませんでした。',
    [ErrorCode.AuthFailed]: 'ユーザー名またはパスワードが正しくありません。',
    [ErrorCode.SyncStartFailed]: '同期の開始に失敗しました。',
    [ErrorCode.SyncRestartFailed]: '同期の再起動に失敗しました。',
    [ErrorCode.SyncError]: '同期エラーが発生しました。',
    [ErrorCode.Unknown]: '不明なエラーが発生しました。',
};

export function showError(code: ErrorCode, detail?: string) {
    const msg = detail ? `${messages[code]} ${detail}` : messages[code];
    vscode.window.showErrorMessage(msg);
}