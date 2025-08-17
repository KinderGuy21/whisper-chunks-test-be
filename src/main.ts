import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  console.log('🚀 Starting Whisper Chunks Test application...');
  console.log('📋 Environment variables:');
  console.log(`   - PORT: ${process.env.PORT ?? '3000 (default)'}`);
  console.log(`   - NODE_ENV: ${process.env.NODE_ENV ?? 'development'}`);

  const startTime = Date.now();

  try {
    console.log('🔧 Creating NestJS application...');
    const app = await NestFactory.create(AppModule);
    console.log('✅ NestJS application created successfully');

    const port = process.env.PORT ?? 3000;
    console.log(`🌐 Starting HTTP server on port ${port}...`);
    await app.listen(port);

    app.enableCors({
      origin: 'http://localhost:5173', // your React dev server
      credentials: true,
      allowedHeaders: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });

    const bootTime = Date.now() - startTime;
    console.log(`🎉 Application started successfully in ${bootTime}ms`);
    console.log(`🚀 Server is running on http://localhost:${port}`);
    console.log('📊 Health check available at /health');
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  console.error('💥 Bootstrap failed:', error);
  process.exit(1);
});
