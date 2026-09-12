import fs from 'node:fs/promises';
import path from 'node:path';
import env from '../config/env.js';
import logger from '../lib/logger.js';

/**
 * Almacenamiento de multimedia con dos controladores.
 *
 * Por defecto escribe en disco para que el CRM funcione en tu computador sin
 * credenciales de AWS. Con STORAGE_DRIVER=s3 usa S3/R2; el SDK se importa de
 * forma diferida para no exigirlo en instalaciones que no lo usan.
 */

let s3Client = null;

async function loadS3Sdk() {
  try {
    return await import('@aws-sdk/client-s3');
  } catch {
    throw new Error(
      'STORAGE_DRIVER=s3 requiere el SDK de AWS. Instálalo con: npm install @aws-sdk/client-s3'
    );
  }
}

async function getS3() {
  if (s3Client) return s3Client;
  const { S3Client } = await loadS3Sdk();
  s3Client = new S3Client({
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  return s3Client;
}

export async function putObject(key, buffer, contentType) {
  if (env.STORAGE_DRIVER === 's3') {
    const { PutObjectCommand } = await loadS3Sdk();
    const client = await getS3();
    await client.send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType })
    );
    return key;
  }

  const target = path.resolve(env.STORAGE_LOCAL_DIR, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  logger.debug({ key }, 'Archivo guardado en disco');
  return key;
}

export async function getObject(key) {
  if (env.STORAGE_DRIVER === 's3') {
    const { GetObjectCommand } = await loadS3Sdk();
    const client = await getS3();
    const result = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  return fs.readFile(path.resolve(env.STORAGE_LOCAL_DIR, key));
}