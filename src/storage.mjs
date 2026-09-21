import { mkdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

/** Durable state is NOT in XDG_RUNTIME_DIR: reboot must not lose merge queues or lineage. */
export function stateDir(env = process.env) {
  const path = env.PI_LIVE_CLONE_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-live-clone');
  if (!isAbsolute(path)) throw new Error('Live-clone state directory must be absolute');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) throw new Error('Live-clone state directory must be owned by you, private (0700), and not a symlink');
  return path;
}
