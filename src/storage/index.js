import fs from 'node:fs/promises';
import path from 'node:path';
import env from '../config/env.js';
import logger from '../lib/logger.js';

/**
 * Almacenamiento de multimedia con dos controladores.
 *
 * Por defecto escribe en disco para que el CRM funcione en tu computador sin
 * credenciales de AWS. Con S3 (AWS_BUCKET_NAME…) usa el bucket, sin SDK.
 */

import { S3Lite } from './s3lite.js';

let s3Client = null;

/**
 * Cliente S3. Sin dependencias: usa el cliente propio (firma SigV4 sobre
 * HTTPS). Si el proyecto tiene instalado @aws-sdk/client-s3 se usa el SDK,
 * pero no hace falta (evita regenerar el package-lock en cada despliegue).
 */
async function getS3() {
  if (s3Client) return s3Client;
  const config = {
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    endpoint: env.S3_ENDPOINT || '',
  };
  try {
    const sdk = await import('@aws-sdk/client-s3');
    const client = new sdk.S3Client({
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
    s3Client = {
      put: async (key, body, contentType) => { await client.send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType })); return key; },
      get: async (key) => {
        const result = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const chunks = [];
        for await (const chunk of result.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
      },
      delete: async (key) => { await client.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key })); return true; },
    };
    logger.info({ bucket: config.bucket }, 'Almacenamiento S3 con el SDK de AWS');
  } catch {
    s3Client = new S3Lite(config);
    logger.info({ bucket: config.bucket, prefix: env.S3_PREFIX }, 'Almacenamiento S3 (cliente integrado, sin SDK)');
  }
  return s3Client;
}

/** Clave real en el bucket: dentro de la carpeta del CRM (S3_PREFIX, por defecto "crm/"). */
const s3Key = (key) => `${env.S3_PREFIX ?? ''}${key}`;

export const storageInfo = () => ({ driver: env.STORAGE_DRIVER, bucket: env.STORAGE_DRIVER === 's3' ? env.S3_BUCKET : null, prefix: env.S3_PREFIX ?? '' });

export async function putObject(key, buffer, contentType) {
  if (env.STORAGE_DRIVER === 's3') {
    const client = await getS3();
    await client.put(s3Key(key), buffer, contentType);
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
    const client = await getS3();
    return client.get(s3Key(key));
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
      const client = await getS3();
      await client.delete(s3Key(key));
    } else {
      await fs.rm(path.resolve(env.STORAGE_LOCAL_DIR, key), { force: true });
    }
    return true;
  } catch (err) {
    logger.warn({ key, err: err.message }, 'No se pudo borrar el archivo');
    return false;
  }
}
