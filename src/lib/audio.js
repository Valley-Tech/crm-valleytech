import { spawn } from 'node:child_process';
import env from '../config/env.js';
import logger from './logger.js';

/**
 * Conversión opcional de audio con ffmpeg.
 *
 * WhatsApp manda las notas de voz en audio/ogg (códec opus). Chrome, Firefox,
 * Edge y Safari desde iOS 18.4 lo reproducen; iPhones más viejos no. Si el
 * servidor tiene ffmpeg (ver nixpacks.toml), la nota se convierte a mp3 al
 * guardarla. Si no hay ffmpeg, se guarda tal cual y no pasa nada.
 */

let available = null; // null = sin comprobar

export async function ffmpegAvailable() {
  if (available !== null) return available;
  if (env.MEDIA_TRANSCODE_AUDIO === false) { available = false; return false; }
  available = await new Promise((resolve) => {
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  logger.info({ ffmpeg: available }, available ? 'ffmpeg disponible: las notas de voz se convierten a mp3' : 'ffmpeg no disponible: las notas de voz se guardan en ogg');
  return available;
}

/** Devuelve { buffer, mimeType } en mp3, o null si no se puede/necesita convertir. */
export async function transcodeAudio(buffer, mimeType = '') {
  if (!buffer?.length) return null;
  if (mimeType === 'audio/mpeg') return null;
  if (!(await ffmpegAvailable())) return null;

  return new Promise((resolve) => {
    const chunks = [];
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 60000);
    let stderr = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { stderr += c.toString(); });
    p.on('error', (err) => { clearTimeout(timer); logger.warn({ err: err.message }, 'ffmpeg falló'); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || chunks.length === 0) {
        logger.warn({ code, stderr: stderr.slice(0, 300) }, 'ffmpeg no pudo convertir el audio: se guarda el original');
        return resolve(null);
      }
      resolve({ buffer: Buffer.concat(chunks), mimeType: 'audio/mpeg' });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buffer);
  });
}
