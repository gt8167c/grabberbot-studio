/**
 * Turns the single-file Vite build into an Artifact-ready fragment.
 *
 * The Artifact host wraps content in its own <!doctype>/<head>/<body>, so we
 * strip those and keep the <title>, the inlined <style>, and the body content
 * (which already has the inlined <script>).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist', 'index.html');
const out = join(root, 'dist', 'artifact.html');

const html = readFileSync(src, 'utf8');

const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';

// Drop <meta> (the host supplies its own) but keep <title> and <style>.
const headKept = head.replace(/<meta\b[^>]*>/gi, '').trim();

writeFileSync(out, `${headKept}\n${body.trim()}\n`, 'utf8');

const kb = (Buffer.byteLength(readFileSync(out)) / 1024).toFixed(0);
console.log(`artifact.html written (${kb} KB)`);
