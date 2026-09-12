/**
 * Verifica la integridad del proyecto CRM ValleyTech.
 *
 *   node verificar.mjs
 *
 * No usa ninguna lista fija: recorre el código real y comprueba que cada
 * import relativo apunte a un archivo que existe. Es exactamente el error que
 * te dio Railway (ERR_MODULE_NOT_FOUND), detectado antes de desplegar.
 */
import fs from 'node:fs';
import path from 'node:path';

const raiz = process.cwd();
const problemas = [];
const avisos = [];

function recorrer(dir, archivos = []) {
  if (!fs.existsSync(dir)) return archivos;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, archivos);
    else if (e.name.endsWith('.js')) archivos.push(p);
  }
  return archivos;
}

const archivos = [
  ...recorrer(path.join(raiz, 'src')),
  ...recorrer(path.join(raiz, 'prisma')),
];

console.log(`Archivos de código revisados: ${archivos.length}`);

// 1. Cada import relativo debe resolver a un archivo existente.
for (const archivo of archivos) {
  const codigo = fs.readFileSync(archivo, 'utf8');
  const sinComentarios = codigo.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of sinComentarios.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const destino = path.resolve(path.dirname(archivo), m[1]);
    if (!fs.existsSync(destino)) {
      problemas.push(`FALTA  ${path.relative(raiz, destino)}   (lo importa ${path.relative(raiz, archivo)})`);
    }
  }
}

// 2. Archivos que el proyecto necesita sí o sí.
for (const obligatorio of [
  'package.json',
  'prisma/schema.prisma',
  'prisma/seed.js',
  'public/index.html',
  'src/server.js',
  'src/worker.js',
]) {
  if (!fs.existsSync(path.join(raiz, obligatorio))) problemas.push(`FALTA  ${obligatorio}`);
}

// 3. Las migraciones tienen que estar en el repo o Railway no crea las tablas.
const dirMigraciones = path.join(raiz, 'prisma', 'migrations');
if (!fs.existsSync(dirMigraciones) || fs.readdirSync(dirMigraciones).filter((d) => !d.endsWith('.toml')).length === 0) {
  problemas.push('FALTA  prisma/migrations/  (genérala con: npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script)');
} else if (!fs.existsSync(path.join(dirMigraciones, 'migration_lock.toml'))) {
  problemas.push('FALTA  prisma/migrations/migration_lock.toml  (contenido: provider = "postgresql")');
}

// 4. Restos del esqueleto anterior.
for (const vieja of ['src/bot', 'src/db', 'src/middleware', 'src/queue', 'src/routes', 'src/utils']) {
  if (fs.existsSync(path.join(raiz, vieja))) avisos.push(`SOBRA  ${vieja}/  (es del proyecto anterior, se puede borrar)`);
}

// 5. El .gitignore no debe excluir src/storage.
const gitignore = path.join(raiz, '.gitignore');
if (fs.existsSync(gitignore)) {
  const lineas = fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).map((l) => l.trim());
  if (lineas.includes('storage/') || lineas.includes('storage')) {
    problemas.push('.gitignore tiene "storage/" sin barra inicial: eso también excluye src/storage/. Cámbialo por "/storage/".');
  }
}

console.log('');
if (problemas.length === 0) {
  console.log('✔ Todo en orden. El proyecto está completo y listo para subir.');
} else {
  console.log('PROBLEMAS QUE HAY QUE CORREGIR:');
  problemas.forEach((p) => console.log('  ' + p));
}
if (avisos.length > 0) {
  console.log('');
  console.log('AVISOS (no rompen nada, pero conviene limpiarlos):');
  avisos.forEach((a) => console.log('  ' + a));
}
console.log('');
process.exit(problemas.length === 0 ? 0 : 1);
