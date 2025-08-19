import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);

    const port = process.env.PORT ?? 3000;
    app.enableCors({
      origin: 'http://localhost:5173', // your React dev server
      credentials: true,
      allowedHeaders: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });

    await app.listen(port);
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  console.error('💥 Bootstrap failed:', error);
  process.exit(1);
});
