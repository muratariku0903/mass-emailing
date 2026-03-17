/**
 * SQS メッセージのペイロード
 * Step Functions Map State（waitForTaskToken パターン）から送信される
 */
export interface SendEmailPayload {
  taskToken: string;
  campaignId: number;
  offset: number;
  limit: number;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  fromAddress: string;
}

/**
 * DB から取得した宛先情報（送信に必要な最小限のフィールド）
 */
export interface Recipient {
  id: number;
  emailAddress: string;
}

/**
 * 宛先ごとの送信結果
 */
export interface RecipientSendResult {
  recipientId: number;
  status: 'request_success' | 'request_failed';
  sesMessageId?: string;
  errorMessage?: string;
}

/**
 * 環境変数から読み込むアプリケーション設定
 */
export interface AppConfig {
  sesRatePerSecond: number;
  sesBatchSize: number;
  awsRegion: string;
  configurationSetName?: string;
}
