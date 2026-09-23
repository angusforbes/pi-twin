import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  if (!process.env.TWIN_TEST_URL?.startsWith('http://127.0.0.1:')) throw new Error('Test provider requires loopback URL');
  const baseUrl = process.env.TWIN_TEST_URL;
  pi.registerCommand('test-reload', { description: 'Test-only resource reload', handler: async (_args, ctx) => { await ctx.reload(); } });
  for (const [provider, id] of [['live-clone-test', 'mock'], ['pi-router', 'auto']]) {
    pi.registerProvider(provider, {
      baseUrl,
      api: 'openai-completions', apiKey: 'local-test-not-a-secret',
      models: [{ id, name: 'Local test model', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
  }
}
