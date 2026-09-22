import { createJiti } from 'jiti';

/** Native ESM caches .mjs dependencies across Pi /reload. Explicitly reload our
 * implementation graph, while using the running Pi's own SessionManager API. */
export async function loadCore(SessionManager, base = import.meta.url) {
  const loader = createJiti(base, {
    moduleCache: false,
    tryNative: false,
    virtualModules: { '@earendil-works/pi-coding-agent': { SessionManager } },
  });
  // Jiti's asynchronous import still delegates .mjs to Node even with
  // tryNative:false. Its synchronous transform path reloads the full graph.
  const controller = loader('./controller.mjs');
  const model = loader('./model.mjs');
  const herdr = loader('./herdr.mjs');
  const storage = loader('./storage.mjs');
  const ipc = loader('./ipc.mjs');
  return { controller, model, herdr, storage, ipc };
}
