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
    console.log(`   - Queue Name: ${this.queue}`);
    console.log(`   - AMQP URL: ${cfg.get<string>('AMQP_URL') ? 'SET' : 'NOT SET'}`);
    console.log('✅ RabbitService initialized');
  }

  async ensureChannel() {
    if (this.ch) {
      console.log('🔗 Channel already exists, reusing...');
      return this.ch;
    }
    
    console.log('🔌 Connecting to RabbitMQ...');
    const amqpUrl = this.cfg.get<string>('AMQP_URL')!;
    console.log(`   - AMQP URL: ${amqpUrl}`);
    
    try {
      this.conn = await amqplib.connect(amqpUrl);
      console.log('✅ Connected to RabbitMQ successfully');
      
      console.log('📺 Creating channel...');
      this.ch = await this.conn.createChannel();
      console.log('✅ Channel created successfully');
      
      console.log(`🔒 Asserting queue: ${this.queue}`);
      await this.ch.assertQueue(this.queue, { durable: true });
      console.log(`✅ Queue "${this.queue}" asserted successfully`);
      
      return this.ch;
    } catch (error) {
      console.error('❌ Failed to establish RabbitMQ connection:', error);
      throw error;
    }
  }

  async publish(msg: any, opts?: Options.Publish) {
    console.log('📨 Publishing message to RabbitMQ...');
    console.log(`   - Queue: ${this.queue}`);
    console.log(`   - Message:`, msg);
    console.log(`   - Options:`, opts);
    
    const startTime = Date.now();
    
    try {
      const ch = await this.ensureChannel();
      const messageBuffer = Buffer.from(JSON.stringify(msg));
      console.log(`   - Message size: ${messageBuffer.length} bytes`);
      
      ch.sendToQueue(this.queue, messageBuffer, {
        persistent: true,
        ...opts,
      });
      
      const duration = Date.now() - startTime;
      console.log(`✅ Message published successfully in ${duration}ms`);
      console.log(`   - Message ID: ${msg.sessionId}-${msg.seq}`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ Failed to publish message after ${duration}ms:`, error);
      throw error;
    }
  }

  async consume(
    onMsg: (msg: amqplib.ConsumeMessage, ch: Channel) => Promise<void>,
  ) {
    console.log('👂 Setting up message consumer...');
    console.log(`   - Queue: ${this.queue}`);
    console.log(`   - Prefetch: 4`);
    
    try {
      const ch = await this.ensureChannel();
      await ch.prefetch(4);
      console.log('✅ Prefetch set to 4');
      
      console.log('🎧 Starting message consumption...');
      await ch.consume(this.queue, async (msg) => {
        if (!msg) {
          console.log('⚠️  Received null message, skipping...');
          return;
        }
        
        const messageContent = JSON.parse(msg.content.toString());
        console.log(`📥 Message received:`, messageContent);
        console.log(`   - Message ID: ${messageContent.sessionId}-${messageContent.seq}`);
        console.log(`   - Content size: ${msg.content.length} bytes`);
        
        const startTime = Date.now();
        
        try {
          console.log('🔄 Processing message...');
          await onMsg(msg, ch);
          
          const duration = Date.now() - startTime;
          console.log(`✅ Message processed successfully in ${duration}ms`);
          console.log('✅ Acknowledging message...');
          
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
      
      console.log('✅ Message consumer started successfully');
      
    } catch (error) {
      console.error('❌ Failed to set up message consumer:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    console.log('🔄 RabbitService shutting down...');
    
    try {
      if (this.ch) {
        console.log('📺 Closing channel...');
        await this.ch.close();
        console.log('✅ Channel closed successfully');
      }
    } catch (error) {
      console.error('❌ Error closing channel:', error);
    }
    
    try {
      if (this.conn) {
        console.log('🔌 Closing connection...');
        await this.conn.close();
        console.log('✅ Connection closed successfully');
      }
    } catch (error) {
      console.error('❌ Error closing connection:', error);
    }
    
    console.log('✅ RabbitService shutdown complete');
  }
}
