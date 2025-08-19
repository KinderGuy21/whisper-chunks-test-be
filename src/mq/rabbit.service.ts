import { Injectable, OnModuleDestroy } from '@nestjs/common';
import amqplib, { Channel, Connection, Options } from 'amqplib';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RabbitService implements OnModuleDestroy {
  private conn!: Connection;
  private ch!: Channel;
  private queue: string;

  constructor(private cfg: ConfigService) {
    console.log('🐰 Initializing RabbitService...');
    this.queue = cfg.get<string>('RABBIT_QUEUE') || 'transcribe_chunks';
    console.log('✅ RabbitService initialized');
  }

  async ensureChannel() {
    if (this.ch) {
      console.log('🔗 Channel already exists, reusing...');
      return this.ch;
    }

    const amqpUrl = this.cfg.get<string>('AMQP_URL')!;

    try {
      this.conn = await amqplib.connect(amqpUrl);
      console.log('✅ Connected to RabbitMQ successfully');

      this.ch = await this.conn.createChannel();

      await this.ch.assertQueue(this.queue, { durable: true });

      return this.ch;
    } catch (error) {
      console.error('❌ Failed to establish RabbitMQ connection:', error);
      throw error;
    }
  }

  async publish(msg: any, opts?: Options.Publish) {
    const startTime = Date.now();

    try {
      const ch = await this.ensureChannel();
      const messageBuffer = Buffer.from(JSON.stringify(msg));

      ch.sendToQueue(this.queue, messageBuffer, {
        persistent: true,
        ...opts,
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Message published successfully in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ Failed to publish message after ${duration}ms:`, error);
      throw error;
    }
  }

  async consume(
    onMsg: (msg: amqplib.ConsumeMessage, ch: Channel) => Promise<void>,
  ) {
    try {
      const ch = await this.ensureChannel();
      await ch.prefetch(4);

      await ch.consume(this.queue, async (msg) => {
        if (!msg) {
          console.log('⚠️  Received null message, skipping...');
          return;
        }

        const messageContent = JSON.parse(msg.content.toString());

        const startTime = Date.now();

        try {
          await onMsg(msg, ch);

          const duration = Date.now() - startTime;
          console.log(`✅ Message processed successfully in ${duration}ms`);

          ch.ack(msg);
          console.log('✅ Message acknowledged');
        } catch (e) {
          const duration = Date.now() - startTime;
          console.error(`❌ Message processing failed after ${duration}ms:`, e);
          console.log('❌ Negative acknowledging message...');

          ch.nack(msg, false, false); // simple POC, send to DLQ in prod
          console.log('❌ Message negative acknowledged');
        }
      });
    } catch (error) {
      console.error('❌ Failed to set up message consumer:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      if (this.ch) {
        await this.ch.close();
      }
    } catch (error) {
      console.error('❌ Error closing channel:', error);
    }

    try {
      if (this.conn) {
        await this.conn.close();
        console.log('✅ Connection closed successfully');
      }
    } catch (error) {
      console.error('❌ Error closing connection:', error);
    }

    console.log('✅ RabbitService shutdown complete');
  }
}
