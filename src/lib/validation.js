import { ApiError } from './errors.js';
import { ARTIFACT_FORMATS, SKETCH_NAME } from '../services/arduinoCli.js';

// vendor:arch:board, optionally followed by :option=value,option=value
const FQBN_RE = /^[\w.-]+:[\w.-]+:[\w.-]+(:[\w.-]+=[\w.-]+(,[\w.-]+=[\w.-]+)*)?$/;
const FILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(ino|h|hpp|c|cpp|S)$/;

// Best-effort guard against reading server files at compile time
// (e.g. `#include "/etc/passwd"` would echo the file in the error output).
// The real boundary is the container sandbox; see README "Security".
const INCLUDE_RE = /(#\s*include(?:_next)?|__has_include(?:_next)?\s*\()\s*(.)([^\n]*)/g;
const ASM_FILE_DIRECTIVE_RE = /\.(incbin|include)\b/;

function isUnsafePath(p) {
  return /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..');
}

function checkSourceSafety(name, content, errors) {
  for (const m of content.matchAll(INCLUDE_RE)) {
    const opener = m[2];
    if (opener !== '"' && opener !== '<') {
      errors.push(`${name}: computed #include (via macro) is not supported`);
      continue;
    }
    const target = m[3].slice(0, m[3].indexOf(opener === '"' ? '"' : '>'));
    if (isUnsafePath(target)) errors.push(`${name}: #include path "${target}" must be relative and stay inside the sketch`);
  }
  if (ASM_FILE_DIRECTIVE_RE.test(content)) {
    errors.push(`${name}: assembler .incbin/.include directives are not allowed`);
  }
}

/**
 * Validates the POST /compile body and turns it into a compile job.
 * Throws ApiError(400) listing every problem found.
 */
export function parseCompileRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }
  const { fqbn, code, files = [], format } = body;
  const errors = [];

  if (typeof fqbn !== 'string' || !FQBN_RE.test(fqbn)) {
    errors.push('fqbn must look like "vendor:arch:board", e.g. "arduino:avr:uno"');
  } else if (config.allowedFqbns.length && !config.allowedFqbns.includes(fqbn.split(':').slice(0, 3).join(':'))) {
    errors.push(`fqbn ${fqbn} is not enabled on this server`);
  }

  if (typeof code !== 'string' || code.trim() === '') errors.push('code must be a non-empty string');

  if (format !== undefined && !ARTIFACT_FORMATS.includes(format)) {
    errors.push(`format must be one of: ${ARTIFACT_FORMATS.join(', ')}`);
  }

  const sources = typeof code === 'string' ? [{ name: `${SKETCH_NAME}.ino`, content: code }] : [];
  if (!Array.isArray(files)) {
    errors.push('files must be an array');
  } else {
    if (files.length > config.maxFiles - 1) errors.push(`at most ${config.maxFiles - 1} extra files are allowed`);
    const seen = new Set([`${SKETCH_NAME}.ino`]);
    files.forEach((f, i) => {
      if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') {
        errors.push(`files[${i}] must be { name: string, content: string }`);
      } else if (!FILE_NAME_RE.test(f.name)) {
        errors.push(`files[${i}].name "${f.name}" must be a plain file name ending in .ino, .h, .hpp, .c, .cpp or .S`);
      } else if (seen.has(f.name)) {
        errors.push(`files[${i}].name "${f.name}" is duplicated or reserved`);
      } else {
        seen.add(f.name);
        sources.push({ name: f.name, content: f.content });
      }
    });
  }

  const totalBytes = sources.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0);
  if (totalBytes > config.maxSourceBytes) errors.push(`total source size ${totalBytes} B exceeds ${config.maxSourceBytes} B`);

  for (const f of sources) checkSourceSafety(f.name, f.content, errors);

  if (errors.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid compile request', errors);
  return { fqbn, files: sources, format };
}
