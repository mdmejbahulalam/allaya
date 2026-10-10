import { Check, ChevronLeft, CircleAlert, Plus, Search, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { ConnectionView, TestResult } from '../../../shared/ipc';
import { PRESETS, presetById, type Preset } from '../../../shared/presets';
import { Button, Field, Input, Textarea } from '../components/ui';
import { useT, type TextKey } from '../i18n';
import { IpcError, invoke } from '../lib/api';
import { useConnectionsStore } from '../stores/connections';

const splitModels = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter(Boolean),
  ),
];

/** What went wrong saving a service, in the person's words. */
function useExplain() {
  const t = useT();
  return (error: unknown): string => {
    if (error instanceof IpcError) {
      const reason = error.details?.['reason'];
      if (typeof reason === 'string' && t.has(`providers.err.${reason}`)) {
        return t.t(`providers.err.${reason}` as TextKey);
      }
      if (t.has(`error.${error.code}`)) return t.t(`error.${error.code}` as TextKey);
    }
    return t.t('providers.err.unknown');
  };
}

type Draft = { name: string; baseUrl: string; apiKey: string; models: string };

function ServiceForm({
  preset,
  existing,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  preset: Preset;
  existing?: ConnectionView | undefined;
  busy: boolean;
  error: string | null;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ids = useId();
  const [draft, setDraft] = useState<Draft>({
    name: existing?.name ?? (preset.id === 'custom' ? '' : preset.name),
    baseUrl: existing?.baseUrl ?? preset.baseUrl ?? '',
    apiKey: '',
    models: existing?.manualModels.join(', ') ?? '',
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const compatible = preset.kind === 'compatible';
  const showModels =
    preset.manualModels === true ||
    preset.id === 'custom' ||
    (existing?.manualModels.length ?? 0) > 0;
  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-panel p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label={t.t('providers.back')}
          title={t.t('providers.back')}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <ChevronLeft size={18} aria-hidden />
        </button>
        <h3 className="font-semibold">{existing ? existing.name : preset.name}</h3>
      </div>
      {(preset.id === 'custom' || existing) && (
        <Field label={t.t('providers.nameLabel')} htmlFor={`${ids}-name`}>
          <Input
            id={`${ids}-name`}
            value={draft.name}
            maxLength={60}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
      )}
      {compatible && (
        <Field
          label={t.t('providers.addressLabel')}
          help={t.t('providers.addressHelp')}
          htmlFor={`${ids}-url`}
        >
          <Input
            id={`${ids}-url`}
            value={draft.baseUrl}
            inputMode="url"
            spellCheck={false}
            placeholder="https://"
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </Field>
      )}
      <Field
        label={existing ? t.t('providers.keyNew') : t.t('providers.keyLabel')}
        help={
          preset.keyOptional
            ? t.t('providers.keyOptional')
            : preset.keysAt
              ? t.t('providers.keyHelp', { where: preset.keysAt })
              : undefined
        }
        htmlFor={`${ids}-key`}
      >
        <Input
          id={`${ids}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
      </Field>
      {showModels && (
        <Field
          label={t.t('providers.modelsLabel')}
          help={t.t('providers.modelsHelp')}
          htmlFor={`${ids}-models`}
        >
          <Textarea
            id={`${ids}-models`}
            rows={2}
            spellCheck={false}
            value={draft.models}
            onChange={(e) => set({ models: e.target.value })}
          />
        </Field>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t.t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {t.t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function ConnectionCard({
  connection,
  onEdit,
}: {
  connection: ConnectionView;
  onEdit: () => void;
}) {
  const t = useT();
  const loadConnections = useConnectionsStore((s) => s.loadConnections);
  const loadModels = useConnectionsStore((s) => s.loadModels);
  const [result, setResult] = useState<TestResult | 'testing' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const test = async () => {
    setResult('testing');
    try {
      setResult(await invoke('connections:test', { id: connection.id }));
      void loadModels(true);
    } catch {
      setResult({ ok: false, latencyMs: 0, errorMessage: t.t('error.generic') });
    }
  };
  const remove = async () => {
    await invoke('connections:remove', { id: connection.id });
    await loadConnections();
    void loadModels(true);
  };
  return (
    <li className="rounded-xl border border-line bg-panel p-4" data-testid="connection">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{connection.name}</p>
          <p className="truncate text-sm text-muted">
            {connection.baseUrl ?? presetById(connection.presetId ?? '')?.keysAt ?? ''}
            {connection.hasKey
              ? ` · ${t.t('providers.keyHint', { hint: connection.keyHint ?? '' })}`
              : connection.keyOptional
                ? ` · ${t.t('providers.local')}`
                : ` · ${t.t('providers.noKey')}`}
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2 text-sm">
            <span>{t.t('providers.removeConfirm', { name: connection.name })}</span>
            <Button size="sm" variant="danger" onClick={() => void remove()}>
              {t.t('common.yes')}
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              {t.t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" disabled={result === 'testing'} onClick={() => void test()}>
              {result === 'testing' ? t.t('providers.testing') : t.t('providers.test')}
            </Button>
            <Button size="sm" onClick={onEdit}>
              {t.t('providers.edit')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
              <Trash2 size={14} aria-hidden />
              {t.t('providers.remove')}
            </Button>
          </div>
        )}
      </div>
      {result && result !== 'testing' && (
        <p
          role="status"
          className={`mt-2 inline-flex items-center gap-1.5 text-sm ${result.ok ? 'text-success' : 'text-danger'}`}
        >
          {result.ok ? <Check size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
          {result.ok
            ? result.modelCount !== undefined
              ? t.t('providers.ok', { count: result.modelCount })
              : t.t('providers.okNoCount')
            : t.t('providers.failed', { message: result.errorMessage ?? '' })}
        </p>
      )}
    </li>
  );
}

type View =
  | { kind: 'list' }
  | { kind: 'pick' }
  | { kind: 'add'; preset: Preset }
  | { kind: 'edit'; connection: ConnectionView };

export function ProvidersPanel() {
  const t = useT();
  const explain = useExplain();
  const connections = useConnectionsStore((s) => s.connections);
  const loadConnections = useConnectionsStore((s) => s.loadConnections);
  const loadModels = useConnectionsStore((s) => s.loadModels);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PRESETS.filter(
      (p) => !needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle),
    );
  }, [query]);

  const finish = async (message: string) => {
    await loadConnections();
    void loadModels(true);
    setNotice(message);
    setView({ kind: 'list' });
  };

  const add = async (preset: Preset, draft: Draft) => {
    setBusy(true);
    setError(null);
    try {
      const made = await invoke('connections:add', {
        presetId: preset.id,
        ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
        ...(preset.kind === 'compatible' ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
        ...(splitModels(draft.models).length > 0
          ? { manualModels: splitModels(draft.models) }
          : {}),
      });
      await finish(t.t('providers.added', { name: made.name }));
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const edit = async (connection: ConnectionView, draft: Draft) => {
    setBusy(true);
    setError(null);
    try {
      await invoke('connections:update', {
        id: connection.id,
        name: draft.name,
        ...(connection.kind === 'compatible' ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
        manualModels: splitModels(draft.models),
      });
      await finish(t.t('providers.saved'));
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="providers-title" className="space-y-4">
      <div>
        <h2 id="providers-title" className="text-xl font-semibold">
          {t.t('providers.title')}
        </h2>
        <p className="mt-1 text-muted">{t.t('providers.intro')}</p>
        <p className="mt-1 text-sm text-muted">{t.t('providers.privacy')}</p>
      </div>

      {notice && view.kind === 'list' && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}

      {view.kind === 'list' && (
        <>
          {connections.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong p-6 text-center text-muted">
              {t.t('providers.none')}
            </p>
          ) : (
            <ul className="space-y-3">
              {connections.map((c) => (
                <ConnectionCard
                  key={c.id}
                  connection={c}
                  onEdit={() => {
                    setError(null);
                    setNotice(null);
                    setView({ kind: 'edit', connection: c });
                  }}
                />
              ))}
            </ul>
          )}
          <Button
            variant="primary"
            onClick={() => {
              setNotice(null);
              setQuery('');
              setView({ kind: 'pick' });
            }}
          >
            <Plus size={16} aria-hidden />
            {t.t('providers.add')}
          </Button>
        </>
      )}

      {view.kind === 'pick' && (
        <div className="rounded-xl border border-line bg-panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView({ kind: 'list' })}
              aria-label={t.t('providers.back')}
              title={t.t('providers.back')}
              className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
            >
              <ChevronLeft size={18} aria-hidden />
            </button>
            <div className="relative flex-1">
              <Search
                size={14}
                aria-hidden
                className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <Input
                autoFocus
                value={query}
                aria-label={t.t('providers.search')}
                placeholder={t.t('providers.search')}
                onChange={(e) => setQuery(e.target.value)}
                className="ps-9"
              />
            </div>
          </div>
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">{t.t('providers.noMatch', { query })}</p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {matches.map((preset) => (
                <li key={preset.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setView({ kind: 'add', preset });
                    }}
                    className="w-full rounded-lg px-3 py-2 text-start text-sm hover:bg-elevated"
                  >
                    {preset.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.kind === 'add' && (
        <ServiceForm
          preset={view.preset}
          busy={busy}
          error={error}
          onSubmit={(draft) => void add(view.preset, draft)}
          onCancel={() => setView({ kind: 'pick' })}
        />
      )}

      {view.kind === 'edit' && (
        <ServiceForm
          preset={presetById(view.connection.presetId ?? '') ?? PRESETS[PRESETS.length - 1]!}
          existing={view.connection}
          busy={busy}
          error={error}
          onSubmit={(draft) => void edit(view.connection, draft)}
          onCancel={() => setView({ kind: 'list' })}
        />
      )}
    </section>
  );
}
