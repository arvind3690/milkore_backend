import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './bootstrap';
import { AppConfig } from './config/app-config.service';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  configureApp(app);

  const config = app.get(AppConfig);
  if (!config.isProduction) {
    const doc = new DocumentBuilder()
      .setTitle('Milkore API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }

  const port = config.get('PORT');
  await app.listen(port);
  app.get(Logger).log(`Milkore API listening on :${port}/${API_PREFIX} (${config.get('NODE_ENV')})`);
}

void main();
