import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Session } from './db/session.entity';
import { Chunk } from './db/chunk.entity';
import { Segment } from './db/segment.entity';
import { UploadController } from './routes/upload.controller';
import { RabbitService } from './mq/rabbit.service';
import { ConsumerService } from './mq/consumer.service';
import { S3Service } from './s3/s3.service';
import { StateService } from './state/state.service';
import { CallbackController } from './routes/callback.controller';
import { FinalizeController } from './routes/finalize.controller';
import { SummarizerService } from './summary/summarizer.service';
import { SessionsController } from './routes/sessions.controller';
import { RedisService } from './db/redis.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [
    UploadController,
    CallbackController,
    FinalizeController,
    SessionsController,
  ],
  providers: [
    RedisService,
    RabbitService,
    ConsumerService,
    S3Service,
    StateService,
    SummarizerService,
  ],
})
export class AppModule {
  onModuleInit() {
    console.log('🏗️  AppModule initialized');
    console.log('📊 Controllers loaded:', [
      'UploadController',
      'CallbackController',
      'FinalizeController',
    ]);
    console.log('🔧 Services loaded:', [
      'RedisService',
      'RabbitService',
      'ConsumerService',
      'S3Service',
      'StateService',
      'SummarizerService',
    ]);
  }
}
