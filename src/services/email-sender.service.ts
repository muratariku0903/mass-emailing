import {
  SESv2Client,
  SendBulkEmailCommand,
  SendEmailCommand,
  type BulkEmailEntry,
} from '@aws-sdk/client-sesv2';
import type { Recipient, RecipientSendResult, AppConfig } from '../types/send-email.types';

/** SESv2Client シングルトン（warm invocation で再利用） */
let sesClient: SESv2Client | null = null;

function getSesClient(region: string): SESv2Client {
  if (!sesClient) {
    sesClient = new SESv2Client({ region });
  }
  return sesClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * バッチ開始間隔の目標値を算出する（ミリ秒）
 *
 * SES レート200通/秒、バッチサイズ50件の場合:
 *   50 / 200 * 1000 = 250ms
 *   → 1秒あたり4バッチ × 50件 = 200件/秒
 */
function calculateTargetIntervalMs(config: AppConfig): number {
  if (config.sesRatePerSecond <= 0) return 0;
  return Math.ceil((config.sesBatchSize / config.sesRatePerSecond) * 1000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 宛先リストを SES SendBulkEmail で送信する
 *
 * - sesBatchSize（デフォルト50件）ごとにチャンク分割
 * - 各バッチの開始間隔が targetIntervalMs になるようレート制御
 *   → API 応答が速ければ残り時間をスリープ
 *   → API 応答が遅ければスリープなしで即次バッチ
 * - バッチ単位で SES API 例外をキャッチし、該当バッチを request_failed にして続行
 */
export async function sendEmailsInBatches(
  recipients: Recipient[],
  campaignId: number,
  subject: string,
  bodyHtml: string,
  bodyText: string,
  fromAddress: string,
  config: AppConfig,
): Promise<RecipientSendResult[]> {
  const chunks = chunkArray(recipients, config.sesBatchSize);
  const targetIntervalMs = calculateTargetIntervalMs(config);
  const allResults: RecipientSendResult[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const batchStartTime = Date.now();
    const chunk = chunks[i];

    try {
      const batchResults = await sendSingleBatch(
        chunk,
        campaignId,
        subject,
        bodyHtml,
        bodyText,
        fromAddress,
        config,
      );
      allResults.push(...batchResults);
    } catch (error) {
      // SES API 例外（バッチ全体が失敗）→ 全件 request_failed にして次バッチへ続行
      console.error(JSON.stringify({
        message: 'SES API exception for batch',
        campaignId,
        batchIndex: i,
        chunkSize: chunk.length,
        error: (error as Error).message,
      }));

      const failedResults: RecipientSendResult[] = chunk.map((r) => ({
        recipientId: r.id,
        status: 'request_failed' as const,
        errorMessage: `SES_API_EXCEPTION: ${(error as Error).message}`,
      }));
      allResults.push(...failedResults);
    }

    // レート制御: バッチ開始からの経過時間を計測し、残り時間だけスリープ
    // 最終バッチの後はスリープ不要
    if (i < chunks.length - 1 && targetIntervalMs > 0) {
      const elapsedMs = Date.now() - batchStartTime;
      const remainingSleepMs = targetIntervalMs - elapsedMs;
      if (remainingSleepMs > 0) {
        await sleep(remainingSleepMs);
      }
    }
  }

  return allResults;
}

// ===========================================================================
// 方式B: SendEmail × Promise.allSettled（比較用）
// ===========================================================================

/**
 * 宛先リストを SES SendEmail（単発）× Promise.allSettled で送信する
 *
 * - sesRatePerSecond 件ずつ Promise.allSettled で並列送信
 * - 各ラウンドの開始間隔が 1秒になるようレート制御
 * - 個別の SendEmail が reject されても他の送信には影響しない
 *
 * メリット:
 *   - ロジックがシンプル（200件並列 → 1秒待つ → 次の200件）
 *   - テンプレート不要（SendEmail は直接 subject/body を指定）
 *
 * デメリット:
 *   - API コール数が多い（20万件 → 20万回 vs SendBulkEmail なら 4,000回）
 *   - API コールレートのスロットリングリスク（200並列 HTTPS リクエスト）
 *   - 1件ずつ HTTP オーバーヘッドが発生するため実効速度が低下する可能性
 */
export async function sendEmailsIndividually(
  recipients: Recipient[],
  campaignId: number,
  subject: string,
  bodyHtml: string,
  bodyText: string,
  fromAddress: string,
  config: AppConfig,
): Promise<RecipientSendResult[]> {
  const client = getSesClient(config.awsRegion);
  const chunks = chunkArray(recipients, config.sesRatePerSecond);
  const allResults: RecipientSendResult[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const roundStartTime = Date.now();
    const chunk = chunks[i];

    // sesRatePerSecond 件を Promise.allSettled で一斉送信
    const promises = chunk.map((recipient) =>
      sendSingleEmail(client, recipient, campaignId, subject, bodyHtml, bodyText, fromAddress, config),
    );

    const settled = await Promise.allSettled(promises);

    // fulfilled / rejected を RecipientSendResult にマッピング
    const roundResults: RecipientSendResult[] = settled.map((result, index) => {
      const recipient = chunk[index];

      if (result.status === 'fulfilled') {
        return result.value;
      }

      return {
        recipientId: recipient.id,
        status: 'request_failed' as const,
        errorMessage: `SES_API_EXCEPTION: ${result.reason?.message ?? 'Unknown error'}`,
      };
    });

    allResults.push(...roundResults);

    // レート制御: ラウンド開始から1秒経つまでスリープ（最終ラウンドは不要）
    if (i < chunks.length - 1) {
      const elapsedMs = Date.now() - roundStartTime;
      const remainingSleepMs = 1000 - elapsedMs;
      if (remainingSleepMs > 0) {
        await sleep(remainingSleepMs);
      }
    }
  }

  return allResults;
}

/**
 * 1件の宛先に対して SES SendEmail を呼び出す
 */
async function sendSingleEmail(
  client: SESv2Client,
  recipient: Recipient,
  campaignId: number,
  subject: string,
  bodyHtml: string,
  bodyText: string,
  fromAddress: string,
  config: AppConfig,
): Promise<RecipientSendResult> {
  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: {
      ToAddresses: [recipient.emailAddress],
    },
    Content: {
      Simple: {
        Subject: { Data: subject },
        Body: {
          Html: { Data: bodyHtml },
          Text: { Data: bodyText },
        },
      },
    },
    EmailTags: [
      { Name: 'campaign_id', Value: String(campaignId) },
      { Name: 'recipient_id', Value: String(recipient.id) },
    ],
    ...(config.configurationSetName && {
      ConfigurationSetName: config.configurationSetName,
    }),
  });

  const response = await client.send(command);

  return {
    recipientId: recipient.id,
    status: 'request_success',
    sesMessageId: response.MessageId,
  };
}

// ---------------------------------------------------------------------------
// Internal: 1バッチ（最大50件）の SES SendBulkEmail 呼び出し
// ---------------------------------------------------------------------------

/**
 * 最大50件の宛先に対して SES SendBulkEmail を1回呼び出す
 *
 * - SES メッセージタグで campaign_id / recipient_id を付与（イベント追跡用）
 * - BulkEmailEntryResults を解析し、宛先ごとに success/failed を返す
 */
async function sendSingleBatch(
  recipients: Recipient[],
  campaignId: number,
  subject: string,
  bodyHtml: string,
  bodyText: string,
  fromAddress: string,
  config: AppConfig,
): Promise<RecipientSendResult[]> {
  const client = getSesClient(config.awsRegion);

  const bulkEmailEntries: BulkEmailEntry[] = recipients.map((recipient) => ({
    Destination: {
      ToAddresses: [recipient.emailAddress],
    },
    ReplacementEmailTags: [
      { Name: 'recipient_id', Value: String(recipient.id) },
    ],
  }));

  const command = new SendBulkEmailCommand({
    FromEmailAddress: fromAddress,
    DefaultEmailTags: [
      { Name: 'campaign_id', Value: String(campaignId) },
    ],
    DefaultContent: {
      Template: {
        TemplateContent: {
          Subject: subject,
          Html: bodyHtml,
          Text: bodyText,
        },
      },
    },
    BulkEmailEntries: bulkEmailEntries,
    ...(config.configurationSetName && {
      ConfigurationSetName: config.configurationSetName,
    }),
  });

  const response = await client.send(command);

  // BulkEmailEntryResults は入力と同じ順序で1:1対応
  return recipients.map((recipient, index) => {
    const entry = response.BulkEmailEntryResults?.[index];

    if (entry?.Status === 'SUCCESS') {
      return {
        recipientId: recipient.id,
        status: 'request_success' as const,
        sesMessageId: entry.MessageId,
      };
    }

    return {
      recipientId: recipient.id,
      status: 'request_failed' as const,
      errorMessage: entry?.Error || entry?.Status || 'UNKNOWN_ERROR',
    };
  });
}
