import { Injectable } from '@nestjs/common';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ConfigService } from '@nestjs/config';
import { S3Service } from '../s3/s3.service';
import { Segment } from '../db/segment.entity';
import { Session } from '../db/session.entity';
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
  private arn: string;
  private s3raw: S3Client;

  constructor(
    cfg: ConfigService,
    private s3: S3Service,
    private redis: RedisService,
  ) {
    const region = cfg.get('AWS_REGION');
    this.lambda = new LambdaClient({ region });
    this.s3raw = new S3Client({ region });
    this.arn = cfg.get<string>('SUMMARY_LAMBDA_ARN')!;
  }

  async invokeChunkSummarizer(
    sessionId: string,
    segmentIndex: number,
    segInputKey: string,
  ) {
    await this.redis.updateSegment(sessionId, segmentIndex, {
      status: 'SUMMARIZING',
    });

    // load segment raw text from S3
    const obj = await this.s3raw.send(
      new GetObjectCommand({ Bucket: this.s3.bucketName(), Key: segInputKey }),
    );
    const text = await streamToString(obj.Body as any);

    // pull ids from session
    const s = await this.redis.getSession(sessionId);

    const payload = {
      // your lambda needs these
      therapistId: s?.therapistId,
      patientId: s?.patientId,
      organizationId: s?.organizationId,
      appointmentId: s?.appointmentId,
      userId: s?.therapistId, // map therapist -> userId if your lambda still expects userId
      // chunks contract: one chunk per segment in this POC
      chunks: [{ index: segmentIndex, start: 0, end: 0, text }],
    };

    const out = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.arn,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );

    let j: any = {};
    try {
      j = JSON.parse(Buffer.from(out.Payload || []).toString('utf8') || '{}');
    } catch {}

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
    const finalKey = `sessions/${sessionId}/final/summary.json`;
    const body = JSON.stringify(
      {
        sessionId,
        summaries: summaryKeys.map((k) => ({
          bucket: this.s3.bucketName(),
          key: k,
        })),
      },
      null,
      2,
    );
    await this.s3.putObject(finalKey, Buffer.from(body), 'application/json');
    return finalKey;
  }
}
