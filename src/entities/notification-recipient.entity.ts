import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('notification_recipients')
@Index('idx_recipients_campaign_status', ['campaignId', 'status'])
@Index('idx_recipients_campaign_id', ['campaignId', 'id'])
@Index('idx_recipients_ses_message_id', ['sesMessageId'])
@Index('idx_recipients_email_status', ['emailAddress', 'status'])
export class NotificationRecipient {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ name: 'campaign_id', type: 'bigint' })
  campaignId!: number;

  @Column({ name: 'email_address', type: 'varchar', length: 255 })
  emailAddress!: string;

  @Column({ name: 'ses_message_id', type: 'varchar', length: 255, nullable: true })
  sesMessageId!: string | null;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'unsent' })
  status!: string;

  @Column({ name: 'sent_at', type: 'timestamp', nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'bounce_type', type: 'varchar', length: 20, nullable: true })
  bounceType!: string | null;

  @Column({ name: 'bounce_sub_type', type: 'varchar', length: 50, nullable: true })
  bounceSubType!: string | null;

  @Column({ name: 'diagnostic_code', type: 'text', nullable: true })
  diagnosticCode!: string | null;

  @Column({ name: 'bounce_at', type: 'timestamp', nullable: true })
  bounceAt!: Date | null;

  @Column({ name: 'complaint_type', type: 'varchar', length: 50, nullable: true })
  complaintType!: string | null;

  @Column({ name: 'complaint_at', type: 'timestamp', nullable: true })
  complaintAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
