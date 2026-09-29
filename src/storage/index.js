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
    region: env.S3_REGION || 'auto',
    // Sin credenciales explícitas, el SDK usa las de AWS_* del entorno o el rol de la máquina.
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
      : {}),
    // R2 / B2 / MinIO: endpoint propio y rutas por bucket.
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  return s3Client;
}

/** Clave real en el bucket: dentro de la carpeta del CRM (S3_PREFIX, por defecto "crm/"). */
const s3Key = (key) => `${env.S3_PREFIX ?? ''}${key}`;

export const storageInfo = () => ({ driver: env.STORAGE_DRIVER, bucket: env.STORAGE_DRIVER === 's3' ? env.S3_BUCKET : null, prefix: env.S3_PREFIX ?? '' });

export async function putObject(key, buffer, contentType) {
  if (env.STORAGE_DRIVER === 's3') {
    const { PutObjectCommand } = await loadS3Sdk();
    const client = await getS3();
    await client.send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: s3Key(key), Body: buffer, ContentType: contentType })
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
    const result = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: s3Key(key) }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  try {
    return await fs.readFile(path.resolve(env.STORAGE_LOCAL_DIR, key));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Causa típica en Railway: lo guardó el servicio web y lo busca el worker (discos distintos).
      const e = new Error(
        'El archivo no está en este servidor: con STORAGE_DRIVER=local cada servicio (web y worker) tiene su propio disco y se borra en cada despliegue. Configura el almacenamiento en S3 (AWS_BUCKET_NAME, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY en web y worker) y vuelve a subir el archivo.'
      );
      e.code = 'ENOENT';
      throw e;
    }
    throw err;
  }
}

/** Borra un archivo; nunca lanza (un archivo que ya no está no debe frenar un borrado). */
export async function deleteObject(key) {
  try {
    if (env.STORAGE_DRIVER === 's3') {
      const { DeleteObjectCommand } = await loadS3Sdk();
      const client = await getS3();
      await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: s3Key(key) }));
    } else {
      await fs.rm(path.resolve(env.STORAGE_LOCAL_DIR, key), { force: true });
    }
    return true;
  } catch (err) {
    logger.warn({ key, err: err.message }, 'No se pudo borrar el archivo');
    return false;
  }
}
