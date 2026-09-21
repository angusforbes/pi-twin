import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  if (!process.env.LIVE_CLONE_TEST_URL?.startsWith('http://127.0.0.1:')) throw new Error('Test provider requires loopback URL');
  pi.registerProvider('live-clone-test', {
    baseUrl: process.env.LIVE_CLONE_TEST_URL,
    api: 'openai-completions', apiKey: 'local-test-not-a-secret',
    models: [{ id: 'mock', name: 'Local test model', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
