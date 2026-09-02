/**
 * The settings screen — where an evaluator types their own API keys.
 * Keys are write-only over the wire: the server reports presence, never the
 * key itself. Every provider is listed even when unconfigured, with the
 * environment variable that also works, so the setup path is discoverable.
 */

import { useEffect, useState } from 'react';

import type { ProvidersResponse } from '../types.ts';
import { api } from '../api.ts';

export function Settings(): JSX.Element {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api.providers().then(setData).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const save = async (providerId: string): Promise<void> => {
    try {
      await api.setKey(providerId, drafts[providerId] ?? '');
      setDrafts((d) => ({ ...d, [providerId]: '' }));
      setStatus((s) => ({ ...s, [providerId]: 'saved' }));
      load();
    } catch (e) {
      setStatus((s) => ({ ...s, [providerId]: (e as Error).message }));
    }
  };

  const test = async (providerId: string): Promise<void> => {
    // Sends the drafted key straight to the test endpoint, unsaved. Testing
    // must never have a save side effect: it's how you check a key before
    // committing it. An empty draft falls back to the already-saved key on
    // the server side, so re-testing a configured provider still works.
    setStatus((s) => ({ ...s, [providerId]: 'testing...' }));
    const result = await api.testProvider(providerId, drafts[providerId] ?? '');
    setStatus((s) => ({ ...s, [providerId]: result.detail }));
  };

  if (error) return <div className="panel error">{error}</div>;
  if (!data) return <div className="panel">Loading…</div>;

  // One provider means no fallback: when it is slow, rate-limited or has
  // retired a model, every role fails together and the task dies with it.
  // This is the single highest-value thing a user can fix here.
  const configured = data.providers.filter((p) => p.configured && p.enabled);

  return (
    <div className="panel settings">
      <h2>API keys</h2>

      {configured.length <= 1 && (
        <div className="warn-banner">
          {configured.length === 0
            ? 'No provider is configured, so no task can run. Add a key below.'
            : `Only ${configured[0]!.label} is configured. When it is slow or ` +
              `rate-limited there is nowhere to fall back to, and the whole task ` +
              `fails. Groq and OpenRouter both have free tiers — a second key is ` +
              `the single biggest reliability win available here.`}
        </div>
      )}
      <p className="muted">
        Keys are stored in <code>{data.settingsPath}</code> with 0600
        permissions and are never sent back to this screen. The corresponding
        environment variable works too.
      </p>

      {data.providers.map((provider) => {
        const models = data.models.filter((m) => m.providerId === provider.providerId);
        return (
          <div key={provider.providerId} className="provider">
            <div className="provider-head">
              <strong>{provider.label}</strong>
              <span className={provider.configured ? 'tag ok' : 'tag'}>
                {provider.configured ? 'configured' : 'not configured'}
              </span>
              {provider.preference === 'default' && (
                <span className="tag" title="Used when no other provider is configured">
                  default fallback
                </span>
              )}
              {provider.preference === 'floor' && <span className="tag">local · no key</span>}
              {!provider.enabled && <span className="tag">disabled</span>}
            </div>

            {provider.keyEnv ? (
              <div className="row">
                <input
                  type="password"
                  placeholder={`Paste ${provider.keyEnv}`}
                  value={drafts[provider.providerId] ?? ''}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [provider.providerId]: e.target.value }))}
                />
                <button onClick={() => void save(provider.providerId)}>Save</button>
                <button onClick={() => void test(provider.providerId)}>Test</button>
                {provider.configured && (
                  <button
                    className="danger"
                    onClick={() => {
                      setDrafts((d) => ({ ...d, [provider.providerId]: '' }));
                      void api.setKey(provider.providerId, '').then(load);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            ) : (
              <div className="muted">No key required.</div>
            )}

            {status[provider.providerId] && (
              <div className="muted">{status[provider.providerId]}</div>
            )}

            <table className="models">
              <thead>
                <tr><th>model</th><th>total params</th><th>context</th><th>roles</th></tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.modelId}>
                    <td><code>{m.modelId}</code></td>
                    {/* The parameter count carries its citation: the ≤80B
                        claim has to be defensible, not asserted. */}
                    <td title={m.paramsSource}>{m.totalParamsB}B</td>
                    <td>{(m.contextTokens / 1000).toFixed(0)}k</td>
                    <td className="muted">{m.roles.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
