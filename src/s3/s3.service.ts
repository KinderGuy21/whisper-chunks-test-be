import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';

@Injectable()
export class S3Service {
  private s3: S3Client;
  private bucket: string;

  constructor(cfg: ConfigService) {
    console.log('🔧 Initializing S3Service...');
    console.log(`   - Region: ${cfg.get('AWS_REGION')}`);
    console.log(`   - Bucket: ${cfg.get('S3_BUCKET')}`);
    console.log(
      `   - Access Key: ${cfg.get('S3_ACCESS_KEY') ? '***' + cfg.get('S3_ACCESS_KEY')?.slice(-4) : 'NOT SET'}`,
    );

    this.s3 = new S3Client({
      region: cfg.get('AWS_REGION')!,
      credentials: {
        accessKeyId: cfg.get<string>('S3_ACCESS_KEY')!,
        secretAccessKey: cfg.get<string>('S3_SECRET_KEY')!,
      },
    });
    this.bucket = cfg.get<string>('S3_BUCKET')!;

    console.log('✅ S3Service initialized successfully');
  }
  async getObject(
    key: string,
    opts?: { range?: string; ifMatch?: string; ifNoneMatch?: string },
  ): Promise<GetObjectCommandOutput> {
    console.log(`📥 S3 GET Object: ${key}`);
    console.log(`   - Bucket: ${this.bucket}`);
    if (opts?.range) console.log(`   - Range: ${opts.range}`);

    const startTime = Date.now();
    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: opts?.range,
          IfMatch: opts?.ifMatch,
          IfNoneMatch: opts?.ifNoneMatch,
        }),
      );
      const duration = Date.now() - startTime;
      console.log(`✅ S3 GET Object successful: ${key} (${duration}ms)`);
      return res;
    } catch (error) {
      console.error(`❌ S3 GET Object failed: ${key}`, error);
      throw error;
    }
  }

  async getObjectStream(key: string): Promise<Readable> {
    const res = await this.getObject(key);
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error('GetObject returned empty Body');
    return body;
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const stream = await this.getObjectStream(key);
    return await this.streamToBuffer(stream);
  }

  async getObjectText(
    key: string,
    encoding: BufferEncoding = 'utf-8',
  ): Promise<string> {
    const buf = await this.getObjectBuffer(key);
    return buf.toString(encoding);
  }

  async getObjectJson<T = unknown>(key: string): Promise<T> {
    const text = await this.getObjectText(key);
    return JSON.parse(text) as T;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer),
      );
    }
    return Buffer.concat(chunks);
  }
  async putObject(key: string, body: Buffer, contentType?: string) {
    console.log(`📤 S3 PUT Object: ${key}`);
    console.log(`   - Bucket: ${this.bucket}`);
    console.log(
      `   - Content Type: ${contentType || 'application/octet-stream'}`,
    );
    console.log(`   - Body Size: ${body.length} bytes`);

    const startTime = Date.now();

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );

      const duration = Date.now() - startTime;
      console.log(`✅ S3 PUT Object successful: ${key} (${duration}ms)`);
    } catch (error) {
      console.error(`❌ S3 PUT Object failed: ${key}`, error);
      throw error;
    }
  }

  async presignGet(key: string, expiresIn = 3600) {
    console.log(`🔗 S3 Presign GET: ${key}`);
    console.log(`   - Bucket: ${this.bucket}`);
    console.log(`   - Expires In: ${expiresIn} seconds`);

    const startTime = Date.now();

    try {
      const url = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      );

      const duration = Date.now() - startTime;
      console.log(`✅ S3 Presign GET successful: ${key} (${duration}ms)`);
      console.log(`   - URL: ${url.substring(0, 100)}...`);

      return url;
    } catch (error) {
      console.error(`❌ S3 Presign GET failed: ${key}`, error);
      throw error;
    }
  }

  bucketName() {
    console.log(`📦 S3 Bucket Name requested: ${this.bucket}`);
    return this.bucket;
  }
}
