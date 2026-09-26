import axios from 'axios';
import logger from '../lib/logger.js';

/**
 * Rastreo de sitios web para la base de conocimiento.
 *
 * Sin dependencias: HTML → texto con expresiones regulares (suficiente para
 * páginas de negocio: inicio, productos, preguntas frecuentes, políticas).
 * Si el sitio es Shopify, además se lee /products.json, que trae el catálogo
 * completo con variantes y precios de forma estructurada.
 */

const UA = 'Mozilla/5.0 (compatible; CRM-ValleyTech-Bot/1.0; +https://valley-tech.github.io/)';
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|pdf|zip|mp4|mp3|woff2?|ttf)(\?|$)/i;
const SKIP_PATH = /\/(cart|checkout|account|login|admin|cdn|wp-admin|wp-json|feed|tag|search)(\/|$)/i;

const NAMED = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iquest: '¿', iexcl: '¡', ordf: 'ª', ordm: 'º', euro: '€', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·',
};

export function decodeEntities(text = '') {
  return text
    .replace(/&([A-Za-z]+);/g, (m, name) => NAMED[name] ?? m)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** HTML → texto legible (títulos, párrafos, listas), sin menús ni scripts. */
export function htmlToText(html = '') {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|canvas)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|option|figcaption)>/gi, '\n');
  s = s.replace(/<(h[1-6])[^>]*>/gi, (_, tag) => `\n${'#'.repeat(Number(tag[1]))} `);
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<td[^>]*>|<th[^>]*>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\r\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n(?=- )\n+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function titleOf(html = '', fallback = '') {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : fallback;
}

export function extractLinks(html = '', baseUrl) {
  const out = new Set();
  const base = new URL(baseUrl);
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    if (/^(mailto:|tel:|javascript:|#)/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], base);
      if (u.origin !== base.origin) continue;
      if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
      u.hash = '';
      u.search = '';
      out.add(u.toString());
    } catch { /* href inválido */ }
  }
  return [...out];
}

export async function fetchPage(url, { timeout = 20000 } = {}) {
  const response = await axios.get(url, {
    timeout,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'es-CO,es;q=0.9' },
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
    maxContentLength: 5 * 1024 * 1024,
  });
  const type = String(response.headers['content-type'] ?? '');
  if (!/html|xml|text/i.test(type)) throw new Error(`No es una página de texto (${type})`);
  return { html: String(response.data), finalUrl: response.request?.res?.responseUrl ?? url, contentType: type };
}

/**
 * Rastrea un sitio a partir de una URL: misma raíz, hasta `maxPages` páginas,
 * anchura primero. Devuelve [{ url, title, text }].
 */
export async function crawlSite(startUrl, { maxPages = 25, maxDepth = 2, onPage } = {}) {
  const start = new URL(startUrl);
  const queue = [{ url: start.toString(), depth: 0 }];
  const seen = new Set([start.toString()]);
  const pages = [];

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    let page;
    try {
      page = await fetchPage(url);
    } catch (err) {
      logger.debug({ url, err: err.message }, 'Página omitida en el rastreo');
      continue;
    }
    const text = htmlToText(page.html);
    if (text.length > 60) {
      pages.push({ url, title: titleOf(page.html, url), text });
      onPage?.(pages.length, url);
    }
    if (depth < maxDepth) {
      for (const link of extractLinks(page.html, url)) {
        if (!seen.has(link)) {
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------
//  Shopify: catálogo estructurado
// ---------------------------------------------------------------------------

const money = (v, currency = 'COP') => {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
};

/** Descarga /products.json (público en tiendas Shopify). null si no es Shopify. */
export async function fetchShopifyProducts(siteUrl, { maxPages = 5 } = {}) {
  const origin = new URL(siteUrl).origin;
  const products = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      const response = await axios.get(`${origin}/products.json`, {
        params: { limit: 250, page },
        timeout: 20000,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      data = response.data;
    } catch (err) {
      if (page === 1) return null;
      break;
    }
    if (!Array.isArray(data?.products)) return page === 1 ? null : products;
    products.push(...data.products);
    if (data.products.length < 250) break;
  }
  return products;
}

/** Catálogo Shopify → Markdown compacto pensado para que la IA responda precios, colores y tallas. */
export function shopifyCatalogMarkdown(products, origin) {
  const lines = ['# Catálogo de productos (tienda en línea)', '', `Fuente: ${origin}`, ''];
  for (const p of products) {
    const optionNames = (p.options ?? []).map((o) => o.name);
    const variants = p.variants ?? [];
    const prices = [...new Set(variants.map((v) => v.price))];
    const url = `${origin}/products/${p.handle}`;
    lines.push(`## ${p.title}`);
    lines.push(`- Enlace: ${url}`);
    lines.push(`- Precio: ${prices.length === 1 ? money(prices[0]) : prices.map((x) => money(x)).join(' / ')}`);
    const compare = [...new Set(variants.map((v) => v.compare_at_price).filter(Boolean))];
    if (compare.length) lines.push(`- Precio anterior (antes de descuento): ${compare.map((x) => money(x)).join(' / ')}`);
    optionNames.forEach((name, i) => {
      const values = [...new Set(variants.map((v) => v[`option${i + 1}`]).filter((v) => v && v !== 'Default Title'))];
      if (values.length) lines.push(`- ${name}: ${values.join(', ')}`);
    });
    const agotadas = variants.filter((v) => v.available === false).map((v) => v.title);
    if (agotadas.length === variants.length && variants.length) lines.push('- Disponibilidad: AGOTADO (todas las variantes)');
    else if (agotadas.length) lines.push(`- Agotado en: ${agotadas.join('; ')}`);
    else lines.push('- Disponibilidad: disponible');
    const desc = htmlToText(p.body_html ?? '');
    if (desc) lines.push(`- Descripción: ${desc.slice(0, 1500)}`);
    if (p.product_type) lines.push(`- Tipo: ${p.product_type}`);
    if (p.tags?.length) lines.push(`- Etiquetas: ${p.tags.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
