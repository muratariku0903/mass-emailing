import { DataSource } from 'typeorm';
import { NotificationRecipient } from '../entities/notification-recipient.entity';

/**
 * Lambda 最適化された TypeORM DataSource シングルトン
 *
 * - モジュールレベルで保持し、warm invocation 間で再利用
 * - 接続プール max=1（Lambda 1インスタンス = 1接続）
 * - RDS Proxy 経由で接続（セッションピン留めを回避するため SET 文は使わない）
 */
let dataSource: DataSource | null = null;

export async function getDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) {
    return dataSource;
  }

  dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    entities: [NotificationRecipient],
    synchronize: false,
    logging: false,
    extra: {
      max: 1,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 5000,
    },
  });

  await dataSource.initialize();
  return dataSource;
}
