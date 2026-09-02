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

  const addKey = async (providerId: string): Promise<void> => {
    try {
      await api.addKey(providerId, drafts[providerId] ?? '');
      setDrafts((d) => ({ ...d, [providerId]: '' }));
      setStatus((s) => ({ ...s, [providerId]: 'saved' }));
      load();
    } catch (e) {
      setStatus((s) => ({ ...s, [providerId]: (e as Error).message }));
    }
  };

  const removeKey = async (providerId: string, index: number): Promise<void> => {
    try {
      await api.removeKey(providerId, index);
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

  // Same drafts/status maps as the LLM providers above, keyed by the same
  // providerId ("exa") the server sends -- it just isn't in `data.providers`
  // because it doesn't route chat calls. See setSearchKey in api.ts.
  const saveSearch = async (providerId: string): Promise<void> => {
    try {
      await api.setSearchKey(drafts[providerId] ?? '');
      setDrafts((d) => ({ ...d, [providerId]: '' }));
      setStatus((s) => ({ ...s, [providerId]: 'saved' }));
      load();
    } catch (e) {
      setStatus((s) => ({ ...s, [providerId]: (e as Error).message }));
    }
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
              <>
                {provider.keyCount > 0 && (
                  <div className="key-list">
                    {Array.from({ length: provider.keyCount }, (_, i) => (
                      <div key={i} className="row small">
                        <span className="muted">key {i + 1}</span>
                        {i < provider.removableKeyCount ? (
                          <button
                            className="ghost"
                            onClick={() => void removeKey(provider.providerId, i)}
                          >
                            remove
                          </button>
                        ) : (
                          // From .env / the environment -- there is no settings-file
                          // position to remove; edit or unset the env var instead.
                          <span className="muted">from environment</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="row">
                  <input
                    type="password"
                    placeholder={`Paste ${provider.keyEnv}`}
                    value={drafts[provider.providerId] ?? ''}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [provider.providerId]: e.target.value }))}
                  />
                  <button onClick={() => void addKey(provider.providerId)}>
                    {provider.keyCount > 0 ? 'Add another key' : 'Save'}
                  </button>
                  <button onClick={() => void test(provider.providerId)}>Test</button>
                </div>
                {provider.keyCount > 1 && (
                  <p className="muted">
                    Extra keys only help against rate limits that are per-key, not
                    per-account — check the provider's own docs before relying on it.
                  </p>
                )}
              </>
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

      <h2>Optional tools</h2>
      <p className="muted">
        Not a model provider — this powers the agent's own web_search tool.
        Without it, the agent is told search isn't configured and continues
        without it; nothing else in the system needs this key.
      </p>
      <div className="provider">
        <div className="provider-head">
          <strong>{data.search.label}</strong>
          <span className={data.search.configured ? 'tag ok' : 'tag'}>
            {data.search.configured ? 'configured' : 'not configured'}
          </span>
        </div>
        <div className="row">
          <input
            type="password"
            placeholder="Paste EXA_API_KEY"
            value={drafts[data.search.providerId] ?? ''}
            onChange={(e) =>
              setDrafts((d) => ({ ...d, [data.search.providerId]: e.target.value }))}
          />
          <button onClick={() => void saveSearch(data.search.providerId)}>Save</button>
          {data.search.configured && (
            <button
              className="danger"
              onClick={() => {
                setDrafts((d) => ({ ...d, [data.search.providerId]: '' }));
                void api.setSearchKey('').then(load);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {status[data.search.providerId] && (
          <div className="muted">{status[data.search.providerId]}</div>
        )}
      </div>
    </div>
  );
}
