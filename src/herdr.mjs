import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function parseResponse(text) {
  let response;
  try { response = JSON.parse(text.trim()); } catch { throw new Error('Herdr returned a non-JSON response'); }
  if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
  return response.result ?? response;
}

/** @param {{ env?: NodeJS.ProcessEnv, run?: Function, extensionPath?: string }} [options] */
export function createHerdr({ env = process.env, run = exec, extensionPath } = {}) {
  const paneId = env.HERDR_PANE_ID;
  const workspace = paneId?.split(':')[0];
  async function call(args) {
    const { stdout } = await run('herdr', args, { env, timeout: 15000, maxBuffer: 1024 * 1024 });
    return stdout?.trim() ? parseResponse(stdout) : {};
  }
  return {
    paneId,
    socketPath: env.HERDR_SOCKET_PATH ?? '',
    async launch(child) {
      if (!paneId || !workspace) throw new Error('Automatic tab launch currently requires Herdr');
      const createArgs = ['tab', 'create', '--workspace', workspace, '--cwd', child.cwd, '--label', child.name, '--focus'];
      // The Herdr server's environment may differ from this Pi's configuration.
      // Carry only explicit config/state selectors, never session IDs or credentials.
      for (const key of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_LIVE_CLONE_STATE_DIR', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'PI_OFFLINE', 'PI_TELEMETRY']) {
        if (env[key]) createArgs.push('--env', `${key}=${env[key]}`);
      }
      const created = await call(createArgs);
      const tabId = created.tab_id ?? created.tab?.id ?? created.tab?.tab_id;
      // API versions expose the first pane either directly or on tab.get.
      let newPane = created.root_pane?.pane_id ?? created.pane_id ?? created.pane?.id ?? created.pane?.pane_id;
      if (!newPane && tabId) {
        const tab = await call(['tab', 'get', tabId]);
        newPane = tab.focused_pane_id ?? tab.tab?.focused_pane_id ?? tab.panes?.[0]?.pane_id ?? tab.tab?.panes?.[0]?.pane_id;
      }
      if (!newPane) throw new Error(`Tab created but pane ID was not returned${tabId ? ` (${tabId})` : ''}`);
      // Herdr's launch alias is restricted to lowercase ASCII / 32 chars. It is
      // NOT the human-facing Pi/session/tab name (which may contain Unicode).
      const launchName = 'lc-' + child.childId.replace(/[^a-z0-9]/gi, '').slice(0, 24).toLowerCase();
      const args = ['agent', 'start', launchName, '--kind', 'pi', '--pane', newPane, '--', '--session', child.file, '--provider', child.model.provider, '--model', child.model.id, '--thinking', child.thinking];
      if (extensionPath) args.push('-e', extensionPath);
      await call(args);
      return { tabId, paneId: newPane };
    },
    /** @param {{ name?: string, sessionId?: string, clone?: boolean, enabled?: boolean }} [options] */
    async publish({ name, sessionId, clone = false, enabled = true } = {}) {
      if (!paneId) return;
      const args = ['pane', 'report-metadata', paneId, '--source', 'pi-live-clone', '--applies-to-source', 'herdr:pi'];
      if (enabled) args.push('--token', 'live_clone=1'); else args.push('--clear-token', 'live_clone', '--clear-token', 'live_clone_parent', '--clear-token', 'live_clone_session', '--clear-token', 'name');
      if (enabled && sessionId) args.push('--token', `live_clone_session=${sessionId}`);
      if (clone && enabled) args.push('--token', 'live_clone_parent=1');
      else if (enabled) args.push('--clear-token', 'live_clone_parent', '--clear-token', 'name');
      // Forked sessions may be ignored by other naming integrations. Publish a
      // display token instead of agent.rename, whose aliases forbid uppercase.
      if (clone && name && enabled) args.push('--token', `name=${name}`);
      await call(args);
    },
  };
}
