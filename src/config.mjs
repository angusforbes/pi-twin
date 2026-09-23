import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_NAME_TEMPLATE = '{parent}[{letter}]';

export function validateNameTemplate(template) {
  if (typeof template !== 'string' || !template.trim() || template.length > 200 || /[\u0000-\u001f\u007f]/.test(template)) throw new Error('nameTemplate must be a nonempty, single-line string of at most 200 characters');
  if (/[{}]/.test(template.replace(/\{(parent|letter|number)\}/g, ''))) throw new Error('nameTemplate supports only {parent}, {letter}, and {number}');
  if (!template.includes('{parent}') || (!template.includes('{letter}') && !template.includes('{number}'))) throw new Error('nameTemplate requires {parent} and either {letter} or {number}');
  return template;
}

/** Read on every split so edits need no resource reload. */
export function readNameTemplate(env = process.env) {
  const path = join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'pi-twin.json');
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return DEFAULT_NAME_TEMPLATE; throw e; }
  let config;
  try { config = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${path}; split cancelled`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Expected a configuration object in ${path}`);
  if (Object.keys(config).some(k => k !== 'nameTemplate')) throw new Error(`Unknown setting in ${path}; supported: nameTemplate`);
  return validateNameTemplate(config.nameTemplate ?? DEFAULT_NAME_TEMPLATE);
}
