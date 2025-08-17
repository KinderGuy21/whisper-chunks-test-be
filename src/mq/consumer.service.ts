import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitService } from './rabbit.service';
import { S3Service } from '../s3/s3.service';
import { ConfigService } from '@nestjs/config';
import { Chunk } from '../db/chunk.entity';
import { RedisService } from '../db/redis.service';

@Injectable()
export class ConsumerService implements OnModuleInit {
  private readonly log = new Logger(ConsumerService.name);
  private endpoint: string;
  private apiKey: string;
  private callbackBase: string;
  private model: string;

  constructor(
    private rabbit: RabbitService,
    private s3: S3Service,
    cfg: ConfigService,
    private redis: RedisService,
  ) {
    console.log('👂 Initializing ConsumerService...');
    this.endpoint = cfg.get<string>('RUNPOD_ENDPOINT')!;
    this.apiKey = cfg.get<string>('RUNPOD_API_KEY')!;
    this.callbackBase = cfg.get<string>('CALLBACK_BASE')!;
    this.model = cfg.get<string>('WHISPER_MODEL') || 'medium';

    console.log(`   - RunPod Endpoint: ${this.endpoint}`);
    console.log(
      `   - RunPod API Key: ${this.apiKey ? '***' + this.apiKey.slice(-4) : 'NOT SET'}`,
    );
    console.log(`   - Callback Base: ${this.callbackBase}`);
    console.log(`   - Whisper Model: ${this.model}`);
    console.log('✅ ConsumerService initialized');
  }

  async onModuleInit() {
    console.log('🚀 ConsumerService starting up...');
    console.log('👂 Starting message consumer...');

    // start consumer
    await this.rabbit.consume(async (msg) => {
      const payload = JSON.parse(msg.content.toString());
      console.log(`📥 Consumer received message:`, payload);
      await this.handleMessage(payload);
    });

    console.log('✅ ConsumerService startup complete');
  }

  private enc(v: string) {
    return encodeURIComponent(v);
  }

  private async handleMessage(payload: {
    bucket: string;
    key: string;
    sessionId: string;
    seq: number;
    startMs: number;
    endMs: number;
  }) {
    const { bucket, key, sessionId, seq, startMs, endMs } = payload;
    console.log(`🔄 Processing message for session ${sessionId}, seq ${seq}`);
    console.log(`   - Bucket: ${bucket}`);
    console.log(`   - Key: ${key}`);
    console.log(`   - Start Time: ${startMs}ms`);
    console.log(`   - End Time: ${endMs}ms`);

    const startTime = Date.now();

    try {
      console.log('🔗 Generating presigned S3 URL...');
      const audioUrl = await this.s3.presignGet(key);
      console.log(
        `✅ Presigned URL generated: ${audioUrl.substring(0, 100)}...`,
      );

      const webhook = `${this.callbackBase}?sessionId=${this.enc(sessionId)}&seq=${seq}&startMs=${startMs}&endMs=${endMs}&bucket=${this.enc(bucket)}&key=${this.enc(key)}`;
      console.log(`🔗 Webhook URL: ${webhook}`);

      const body = {
        input: {
          word_timestamps: true,
          model: this.model,
          audio: audioUrl,
          language: 'he',
          enable_vad: true,

          transcription: 'formatted_text',
          condition_on_previous_text: false,
        },
        webhook,
      };

      console.log('📤 Submitting to RunPod API...');
      console.log(`   - Endpoint: ${this.endpoint}`);
      console.log(`   - Model: ${this.model}`);
      console.log(`   - Word Timestamps: true`);
      console.log(`   - VAD Filter: true`);
      console.log(`   - Audio URL: ${audioUrl.substring(0, 100)}...`);

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      console.log(`📊 RunPod API Response: ${res.status} ${res.statusText}`);

      if (!res.ok) {
        const t = await res.text();
        console.error(`❌ RunPod API failed: ${res.status} ${t}`);
        throw new Error(`Runpod submit failed ${res.status} ${t}`);
      }

      const j: any = await res.json().catch(() => ({}));
      const jobId = j?.id ?? j?.jobId ?? null;

      console.log(`✅ RunPod job submitted successfully`);
      console.log(`   - Job ID: ${jobId || 'NOT PROVIDED'}`);
      console.log(`   - Response:`, j);

      // set QUEUED_REMOTE
      console.log('💾 Updating chunk status to QUEUED_REMOTE...');
      await this.redis.updateChunk(sessionId, seq, {
        status: 'QUEUED_REMOTE',
        runpodJobId: jobId || null,
      });
      console.log('✅ Chunk status updated successfully');

      const totalTime = Date.now() - startTime;
      console.log(
        `🎉 Message processing completed successfully in ${totalTime}ms`,
      );
    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error(
        `❌ Message processing failed after ${totalTime}ms:`,
        error,
      );
      throw error;
    }
  }
}
