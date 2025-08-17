import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        console.log('🗄️  Initializing TypeORM database connection...');
        console.log(`   - Host: ${cfg.get('PG_HOST')}`);
        console.log(`   - Port: ${cfg.get('PG_PORT') ?? 5432}`);
        console.log(`   - Database: ${cfg.get('PG_DB')}`);
        console.log(`   - User: ${cfg.get('PG_USER')}`);
        console.log(`   - Synchronize: true (POC mode)`);

        return {
          type: 'postgres',
          host: cfg.get('PG_HOST'),
          port: Number(cfg.get('PG_PORT') ?? 5432),
          username: cfg.get('PG_USER'),
          password: cfg.get('PG_PASS'),
          database: cfg.get('PG_DB'),
          entities: [Session, Chunk, Segment],
          synchronize: true, // POC only
          onConnect: () => {
            console.log('✅ Database connection established successfully');
          },
          onError: (error) => {
            console.error('❌ Database connection error:', error);
          },
        };
      },
    }),
    TypeOrmModule.forFeature([Session, Chunk, Segment]),
  ],
  controllers: [
    UploadController,
    CallbackController,
    FinalizeController,
    SessionsController,
  ],
  providers: [
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
      'RabbitService',
      'ConsumerService',
      'S3Service',
      'StateService',
      'SummarizerService',
    ]);
  }
}
