import type { SQSEvent } from 'aws-lambda';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { getDataSource } from '../config/data-source';
import { NotificationRecipient } from '../entities/notification-recipient.entity';
import { sendEmailsInBatches } from '../services/email-sender.service';
import type {
  SendEmailPayload,
  Recipient,
  RecipientSendResult,
  AppConfig,
} from '../types/send-email.types';

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

// ---------------------------------------------------------------------------
// Client singletons
// ---------------------------------------------------------------------------
let sfnClient: SFNClient | null = null;

function getSfnClient(region: string): SFNClient {
  if (!sfnClient) {
    sfnClient = new SFNClient({ region });
  }
  return sfnClient;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(): AppConfig {
  return {
    sesRatePerSecond: parseInt(process.env.SES_RATE_PER_SECOND || '200', 10),
    sesBatchSize: parseInt(process.env.SES_BATCH_SIZE || '50', 10),
    awsRegion: process.env.AWS_REGION || 'ap-northeast-1',
    configurationSetName: process.env.SES_CONFIGURATION_SET_NAME,
  };
}

// ===========================================================================
// Lambda Handler
// ===========================================================================
export async function handler(event: SQSEvent): Promise<void> {
  // BatchSize=1 を前提
  const record = event.Records[0];
  const payload: SendEmailPayload = JSON.parse(record.body);
  const config = loadConfig();

  const {
    taskToken,
    campaignId,
    offset,
    limit,
    subject,
    bodyHtml,
    bodyText,
    fromAddress,
  } = payload;

  console.log(JSON.stringify({
    message: 'Processing send-email batch',
    campaignId,
    offset,
    limit,
  }));

  const dataSource = await getDataSource();

  // -------------------------------------------------------------------
  // Step 1: offset/limit で宛先を取得（ORDER BY id で決定的）
  // -------------------------------------------------------------------
  const recipientRepo = dataSource.getRepository(NotificationRecipient);

  const recipientEntities = await recipientRepo
    .createQueryBuilder('r')
    .select(['r.id', 'r.emailAddress'])
    .where('r.campaignId = :campaignId', { campaignId })
    .orderBy('r.id', 'ASC')
    .skip(offset)
    .take(limit)
    .getMany();

  if (recipientEntities.length === 0) {
    console.log(JSON.stringify({
      message: 'No recipients found, signaling task completion',
      campaignId,
      offset,
      limit,
    }));
    await signalTaskSuccess(taskToken, campaignId, config);
    return;
  }

  // -------------------------------------------------------------------
  // Step 2: ステータスを unsent → sending に更新（RDS更新先行方式）
  //         WHERE status = 'unsent' で重複送信を防止
  //         RETURNING で実際に更新された行のみ取得
  // -------------------------------------------------------------------
  const recipientIds = recipientEntities.map((r) => r.id);

  const updateResult: { id: string; email_address: string }[] =
    await dataSource.query(
      `UPDATE notification_recipients
       SET status = 'sending', updated_at = NOW()
       WHERE id = ANY($1) AND status = 'unsent'
       RETURNING id, email_address`,
      [recipientIds],
    );

  const updatedRecipients: Recipient[] = updateResult.map((row) => ({
    id: Number(row.id),
    emailAddress: row.email_address,
  }));

  if (updatedRecipients.length === 0) {
    console.log(JSON.stringify({
      message: 'All recipients already processed (duplicate prevention)',
      campaignId,
      offset,
      limit,
      totalFetched: recipientEntities.length,
    }));
    await signalTaskSuccess(taskToken, campaignId, config);
    return;
  }

  console.log(JSON.stringify({
    message: 'Recipients marked as sending',
    campaignId,
    updated: updatedRecipients.length,
    skipped: recipientEntities.length - updatedRecipients.length,
  }));

  // -------------------------------------------------------------------
  // Step 3: SES SendBulkEmail でメール送信（レート制御付き）
  //         50件ずつチャンク分割 → 経過時間ベースのレート制御はサービス側で管理
  // -------------------------------------------------------------------
  const allResults = await sendEmailsInBatches(
    updatedRecipients,
    campaignId,
    subject,
    bodyHtml,
    bodyText,
    fromAddress,
    config,
  );

  // -------------------------------------------------------------------
  // Step 4: 送信結果に基づきステータスを一括更新
  // -------------------------------------------------------------------
  await updateRecipientStatuses(dataSource, allResults);

  const successCount = allResults.filter((r) => r.status === 'request_success').length;
  const failedCount = allResults.filter((r) => r.status === 'request_failed').length;

  console.log(JSON.stringify({
    message: 'Batch processing complete',
    campaignId,
    offset,
    limit,
    successCount,
    failedCount,
  }));

  // -------------------------------------------------------------------
  // Step 5: Step Functions に完了を通知
  // -------------------------------------------------------------------
  await signalTaskSuccess(taskToken, campaignId, config);
}

// ===========================================================================
// DB更新: 送信結果をまとめて notification_recipients に反映
// ===========================================================================
async function updateRecipientStatuses(
  dataSource: ReturnType<typeof getDataSource> extends Promise<infer T> ? T : never,
  results: RecipientSendResult[],
): Promise<void> {
  const successResults = results.filter((r) => r.status === 'request_success');
  const failedResults = results.filter((r) => r.status === 'request_failed');

  // 成功分: unnest を使ったバッチ UPDATE（SQL インジェクション安全）
  if (successResults.length > 0) {
    const updateChunks = chunkArray(successResults, 500);
    for (const chunk of updateChunks) {
      await dataSource.query(
        `UPDATE notification_recipients AS nr
         SET status = 'request_success',
             ses_message_id = v.ses_message_id,
             sent_at = NOW(),
             updated_at = NOW()
         FROM (
           SELECT unnest($1::bigint[]) AS id,
                  unnest($2::varchar[]) AS ses_message_id
         ) AS v
         WHERE nr.id = v.id`,
        [
          chunk.map((r) => r.recipientId),
          chunk.map((r) => r.sesMessageId ?? null),
        ],
      );
    }
  }

  // 失敗分
  if (failedResults.length > 0) {
    const updateChunks = chunkArray(failedResults, 500);
    for (const chunk of updateChunks) {
      await dataSource.query(
        `UPDATE notification_recipients AS nr
         SET status = 'request_failed',
             error_message = v.error_message,
             updated_at = NOW()
         FROM (
           SELECT unnest($1::bigint[]) AS id,
                  unnest($2::text[]) AS error_message
         ) AS v
         WHERE nr.id = v.id`,
        [
          chunk.map((r) => r.recipientId),
          chunk.map((r) => r.errorMessage ?? null),
        ],
      );
    }
  }
}

// ===========================================================================
// Step Functions: SendTaskSuccess
// ===========================================================================
async function signalTaskSuccess(
  taskToken: string,
  campaignId: number,
  config: AppConfig,
): Promise<void> {
  try {
    const client = getSfnClient(config.awsRegion);
    await client.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ campaignId, status: 'completed' }),
      }),
    );
    console.log(JSON.stringify({
      message: 'SendTaskSuccess called',
      campaignId,
    }));
  } catch (error) {
    // 送信処理は完了済みなので throw しない（SQS リトライによる二重送信を防止）
    // Step Functions 側はタスクタイムアウトでエラーハンドリング
    console.error(JSON.stringify({
      message: 'SendTaskSuccess failed (batch already processed)',
      campaignId,
      error: (error as Error).message,
    }));
  }
}
