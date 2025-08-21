import { Injectable } from '@nestjs/common';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ConfigService } from '@nestjs/config';
import { S3Service } from '../s3/s3.service';
import { Segment } from '../db/segment.entity';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RedisService } from '../db/redis.service';

async function streamToString(stream: any): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

@Injectable()
export class SummarizerService {
  private lambda: LambdaClient;
  private chunkLambdaArn: string;
  private finalizerLambdaArn: string;
  private s3raw: S3Client;

  constructor(
    cfg: ConfigService,
    private s3: S3Service,
    private redis: RedisService,
  ) {
    const region = cfg.get('AWS_REGION');
    this.lambda = new LambdaClient({
      region,
      credentials: {
        accessKeyId: cfg.get('LAMBDA_USER_ACCESS_KEY')!,
        secretAccessKey: cfg.get('LAMBDA_USER_SECRET_KEY')!,
      },
    });
    this.chunkLambdaArn = cfg.get<string>('SUMMARY_LAMBDA_ARN')!;
    this.finalizerLambdaArn = cfg.get<string>('FINALIZER_LAMBDA_ARM')!;
  }

  async invokeFinalizerSummarizer(
    sessionId: string,
    segmentIndex: number,
    segInputKey: string,
  ) {
    await this.redis.updateSegment(sessionId, segmentIndex, {
      status: 'SUMMARIZING',
    });

    const text = await this.s3.getObjectText(segInputKey);
    console.log('object text:', text);
    const s = await this.redis.getSession(sessionId);

    const payload = {
      therapistId: s?.therapistId,
      patientId: s?.patientId,
      organizationId: s?.organizationId,
      appointmentId: s?.appointmentId,
      userId: s?.therapistId,
      sessionId: s?.sessionId,
      chunks: [{ index: segmentIndex, start: 0, end: 0, text }],
    };
    console.log('SUMMARY_LAMBDA_INVOKED:', payload);
    const out = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.chunkLambdaArn,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );

    let j: unknown = {};
    try {
      j = JSON.parse(Buffer.from(out.Payload || []).toString('utf8') || '{}');
    } catch (e) {
      console.log(e);
    }

    // store summary content back to S3
    const summaryKey = `sessions/${sessionId}/segments/segment-${segmentIndex}-summary.json`;
    await this.s3.putObject(
      summaryKey,
      Buffer.from(JSON.stringify(j, null, 2)),
      'application/json',
    );

    await this.redis.updateSegment(sessionId, segmentIndex, {
      status: 'SUCCEEDED',
      summaryS3Key: summaryKey,
    });
  }

  async invokeChunkSummarizer(
    sessionId: string,
    segmentIndex: number,
    text: string,
  ) {
    await this.redis.updateSegment(sessionId, segmentIndex, {
      status: 'SUMMARIZING',
    });

    console.log('object text:', text);
    const s = await this.redis.getSession(sessionId);

    const payload = {
      therapistId: s?.therapistId,
      patientId: s?.patientId,
      organizationId: s?.organizationId,
      appointmentId: s?.appointmentId,
      userId: s?.therapistId,
      sessionId: s?.sessionId,
      chunks: [{ index: segmentIndex, start: 0, end: 0, text }],
    };
    console.log('SUMMARY_LAMBDA_INVOKED:', payload);
    const out = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.chunkLambdaArn,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );

    let j: unknown = {};
    try {
      j = JSON.parse(Buffer.from(out.Payload || []).toString('utf8') || '{}');
    } catch (e) {
      console.log(e);
    }

    // store summary content back to S3
    const summaryKey = `sessions/${sessionId}/segments/segment-${segmentIndex}-summary.json`;
    await this.s3.putObject(
      summaryKey,
      Buffer.from(JSON.stringify(j, null, 2)),
      'application/json',
    );

    await this.redis.updateSegment(sessionId, segmentIndex, {
      status: 'SUCCEEDED',
      summaryS3Key: summaryKey,
    });
  }

  async combineSegments(sessionId: string, summaryKeys: string[]) {
    console.log(
      `🔄 Consolidating ${summaryKeys.length} segment summaries for session ${sessionId}`,
    );

    // Read all segment summaries and combine them
    const consolidatedSummaries: any[] = [];
    for (const summaryKey of summaryKeys) {
      try {
        const summaryText = await this.s3.getObjectText(summaryKey);
        const summary = JSON.parse(summaryText);
        consolidatedSummaries.push({
          s3Key: summaryKey,
          content: summary,
        });
      } catch (error) {
        console.error(`❌ Failed to read summary ${summaryKey}:`, error);
      }
    }

    // Create consolidated summary file
    const consolidatedKey = `sessions/${sessionId}/final/consolidated-summary.json`;
    const consolidatedBody = {
      sessionId,
      totalSegments: summaryKeys.length,
      consolidatedAt: new Date().toISOString(),
      segments: consolidatedSummaries,
    };

    await this.s3.putObject(
      consolidatedKey,
      Buffer.from(JSON.stringify(consolidatedBody, null, 2)),
      'application/json',
    );

    console.log(`✅ Consolidated summary created: ${consolidatedKey}`);
    return consolidatedKey;
  }

  async invokeFinalizerLambda(
    sessionId: string,
    consolidatedSummaryKey: string,
  ) {
    console.log(`🚀 Invoking finalizer lambda for session ${sessionId}`);

    const session = await this.redis.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const payload = {
      sessionId,
      therapistId: session.therapistId,
      patientId: session.patientId,
      organizationId: session.organizationId,
      appointmentId: session.appointmentId,
      userId: session.therapistId,
      consolidatedSummary: {
        bucket: this.s3.bucketName(),
        key: consolidatedSummaryKey,
      },
    };

    console.log('📤 Invoking finalizer lambda with payload:', payload);

    const out = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.finalizerLambdaArn,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );

    let result: unknown = {};
    try {
      result = JSON.parse(
        Buffer.from(out.Payload || []).toString('utf8') || '{}',
      );
    } catch (e) {
      console.error('❌ Failed to parse finalizer lambda response:', e);
    }

    console.log('✅ Finalizer lambda response:', result);
    return result;
  }
}
