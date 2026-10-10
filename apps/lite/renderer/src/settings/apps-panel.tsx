import {
  Check,
  ChevronLeft,
  CircleAlert,
  LoaderCircle,
  LogIn,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { McpServerInput, McpServerView } from '../../../shared/ipc';
import {
  MCP_PRESETS,
  OAUTH_REDIRECT_URL,
  mcpPresetById,
  type McpAuthKind,
  type McpPreset,
} from '../../../shared/mcp-presets';
import { Button, Field, Input, Select, Textarea } from '../components/ui';
import { useT, type Translator } from '../i18n';
import { mcpErrorText } from '../lib/mcp-errors';
import { cn } from '../lib/cn';
import { useMcpStore } from '../stores/mcp';

type Target = { kind: 'preset'; preset: McpPreset } | { kind: 'custom' } | { kind: 'program' };

interface Draft {
  name: string;
  url: string;
  auth: McpAuthKind;
  token: string;
  clientId: string;
  clientSecret: string;
  command: string;
  args: string;
  env: string;
}

/** `NAME=value` lines, as the variables a program is started with. Null when a line is not of that shape. */
export function parseEnv(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const at = line.indexOf('=');
    const name = at > 0 ? line.slice(0, at).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    env[name] = line.slice(at + 1);
  }
  return env;
}

export const parseArgs = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');

/** What a service is for, in a few words (nothing if it has none written). */
function presetDescription(t: Translator, id: string): string {
  const key = `apps.preset.${id}`;
  return t.has(key) ? t.t(key) : '';
}

function statusText(t: Translator, server: McpServerView): string {
  switch (server.status) {
    case 'connected':
      return t.t('apps.status.connected', { count: server.tools.filter((x) => x.enabled).length });
    case 'connecting':
      return t.t('apps.status.connecting');
    case 'needs_sign_in':
      return t.t('apps.status.needs_sign_in');
    case 'signing_in':
      return t.t('apps.status.signing_in');
    case 'error':
      return t.t('apps.status.error');
    case 'off':
      return t.t('apps.status.off');
  }
}

function ToolRow({
  server,
  tool,
}: {
  server: McpServerView;
  tool: McpServerView['tools'][number];
}) {
  const t = useT();
  const setTool = useMcpStore((s) => s.setTool);
  const change = (patch: { ask?: boolean; enabled?: boolean }) =>
    void setTool(server.id, tool.name, patch).catch(() => undefined);
  return (
    <li className="flex items-start gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[0.85em]">{tool.title ?? tool.name}</p>
        {tool.description && (
          <p className="truncate text-xs text-muted" title={tool.description} dir="auto">
            {tool.description}
          </p>
        )}
      </div>
      <label className="flex shrink-0 items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          checked={tool.enabled}
          aria-label={t.t('apps.toolUseLabel', { tool: tool.title ?? tool.name })}
          onChange={(e) => change({ enabled: e.target.checked })}
          className="size-4 accent-[var(--accent)]"
        />
        {t.t('apps.toolUse')}
      </label>
      <label
        className={cn('flex shrink-0 items-center gap-1.5 text-sm', !tool.enabled && 'opacity-50')}
      >
        <input
          type="checkbox"
          checked={tool.ask}
          disabled={!tool.enabled}
          aria-label={t.t('apps.toolAskLabel', { tool: tool.title ?? tool.name })}
          onChange={(e) => change({ ask: e.target.checked })}
          className="size-4 accent-[var(--accent)]"
        />
        {t.t('apps.toolAsk')}
      </label>
    </li>
  );
}

function ServerCard({ server, onEdit }: { server: McpServerView; onEdit: () => void }) {
  const t = useT();
  const { update, remove, reconnect, signIn, cancelSignIn, signOut } = useMcpStore();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(mcpErrorText(t, error));
    }
  };
  const oauth = server.auth === 'oauth' || server.auth === 'oauth_own_client';
  const good = server.status === 'connected';
  const waiting = server.status === 'connecting' || server.status === 'signing_in';
  return (
    <li
      className="rounded-xl border border-line bg-panel p-4"
      data-testid="app"
      aria-label={server.name}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium" dir="auto">
            {server.name}
          </p>
          <p
            role="status"
            className={cn(
              'mt-0.5 inline-flex items-center gap-1.5 text-sm',
              good ? 'text-success' : server.status === 'error' ? 'text-danger' : 'text-muted',
            )}
          >
            {waiting ? (
              <LoaderCircle size={14} className="animate-spin" aria-hidden />
            ) : good ? (
              <Check size={14} aria-hidden />
            ) : server.status === 'error' ? (
              <CircleAlert size={14} aria-hidden />
            ) : null}
            {statusText(t, server)}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {server.transport === 'http' ? server.url : [server.command, ...server.args].join(' ')}
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2 text-sm">
            <span>{t.t('apps.removeConfirm', { name: server.name })}</span>
            <Button size="sm" variant="danger" onClick={() => void run(() => remove(server.id))}>
              {t.t('common.yes')}
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              {t.t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {server.status === 'needs_sign_in' && (
              <Button size="sm" variant="primary" onClick={() => void run(() => signIn(server.id))}>
                <LogIn size={14} aria-hidden />
                {t.t('apps.signIn')}
              </Button>
            )}
            {server.status === 'signing_in' && (
              <Button size="sm" onClick={() => void run(() => cancelSignIn(server.id))}>
                {t.t('common.cancel')}
              </Button>
            )}
            {(server.status === 'error' || (server.status === 'off' && server.enabled)) && (
              <Button size="sm" onClick={() => void run(() => reconnect(server.id))}>
                {t.t('apps.reconnect')}
              </Button>
            )}
            {oauth && server.signedIn && server.status !== 'signing_in' && (
              <Button size="sm" onClick={() => void run(() => signOut(server.id))}>
                {t.t('apps.signOut')}
              </Button>
            )}
            <Button size="sm" onClick={onEdit} disabled={server.status === 'signing_in'}>
              {t.t('apps.edit')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
              <Trash2 size={14} aria-hidden />
              {t.t('apps.remove')}
            </Button>
          </div>
        )}
      </div>

      {(server.error || problem) && (
        <p role="alert" className="mt-2 text-sm text-danger" dir="auto">
          {problem ?? server.error}
        </p>
      )}

      <label className="mt-3 inline-flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          role="switch"
          checked={server.enabled}
          onChange={(e) => void run(() => update(server.id, { enabled: e.target.checked }))}
          className="size-4 accent-[var(--accent)]"
        />
        {t.t('apps.enabled')}
      </label>

      {good && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted">
            {t.t('apps.tools', { count: server.tools.length })}
          </summary>
          <p className="mt-1.5 text-xs text-muted">
            {server.trusted ? t.t('apps.trusted') : t.t('apps.untrusted')}
          </p>
          {server.tools.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted">{t.t('apps.noTools')}</p>
          ) : (
            <ul className="mt-1 max-h-80 divide-y divide-line overflow-y-auto pe-1">
              {server.tools.map((tool) => (
                <ToolRow key={tool.name} server={server} tool={tool} />
              ))}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}

function AppForm({
  target,
  existing,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  target: Target;
  existing?: McpServerView | undefined;
  busy: boolean;
  error: string | null;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ids = useId();
  const preset = target.kind === 'preset' ? target.preset : undefined;
  const [draft, setDraft] = useState<Draft>({
    name: existing?.name ?? preset?.name ?? '',
    url: existing?.url ?? preset?.url ?? '',
    auth: existing?.auth ?? preset?.auth[0] ?? 'none',
    token: '',
    clientId: existing?.clientId ?? '',
    clientSecret: '',
    command: existing?.command ?? '',
    args: existing?.args.join('\n') ?? '',
    env: '',
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const program = (existing ? existing.transport === 'stdio' : target.kind === 'program') === true;
  const choices: readonly McpAuthKind[] = existing
    ? [existing.auth]
    : (preset?.auth ?? ['none', 'token', 'oauth']);
  const title = existing?.name ?? preset?.name ?? t.t(program ? 'apps.program' : 'apps.other');

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
          aria-label={t.t('apps.back')}
          title={t.t('apps.back')}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <ChevronLeft size={18} aria-hidden />
        </button>
        <h3 className="font-semibold">{title}</h3>
      </div>

      <Field label={t.t('apps.form.nameLabel')} htmlFor={`${ids}-name`}>
        <Input
          id={`${ids}-name`}
          value={draft.name}
          maxLength={60}
          dir="auto"
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>

      {program ? (
        <>
          <p className="rounded-lg border border-line-strong p-3 text-sm text-danger">
            {t.t('apps.form.programWarning')}
          </p>
          <Field
            label={t.t('apps.form.commandLabel')}
            help={t.t('apps.form.commandHelp')}
            htmlFor={`${ids}-command`}
          >
            <Input
              id={`${ids}-command`}
              value={draft.command}
              spellCheck={false}
              onChange={(e) => set({ command: e.target.value })}
            />
          </Field>
          <Field label={t.t('apps.form.argsLabel')} htmlFor={`${ids}-args`}>
            <Textarea
              id={`${ids}-args`}
              rows={3}
              spellCheck={false}
              className="font-mono text-sm"
              value={draft.args}
              onChange={(e) => set({ args: e.target.value })}
            />
          </Field>
          <Field
            label={t.t('apps.form.envLabel')}
            help={
              existing && existing.envKeys.length > 0
                ? t.t('apps.form.envKept', { names: existing.envKeys.join(', ') })
                : t.t('apps.form.envHelp')
            }
            htmlFor={`${ids}-env`}
          >
            <Textarea
              id={`${ids}-env`}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-sm"
              value={draft.env}
              onChange={(e) => set({ env: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label={t.t('apps.form.addressLabel')}
            help={t.t('apps.form.addressHelp')}
            htmlFor={`${ids}-url`}
          >
            <Input
              id={`${ids}-url`}
              value={draft.url}
              inputMode="url"
              spellCheck={false}
              placeholder="https://"
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
          {choices.length > 1 && (
            <Field label={t.t('apps.form.signInHow')} htmlFor={`${ids}-auth`}>
              <Select
                id={`${ids}-auth`}
                value={draft.auth}
                onChange={(e) => set({ auth: e.target.value as McpAuthKind })}
              >
                {choices.map((kind) => (
                  <option key={kind} value={kind}>
                    {t.t(`apps.form.auth.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {draft.auth === 'token' && (
            <Field
              label={existing ? t.t('apps.form.tokenNew') : t.t('apps.form.tokenLabel')}
              help={
                preset?.tokenFrom
                  ? t.t('apps.form.tokenFrom', { where: preset.tokenFrom })
                  : undefined
              }
              htmlFor={`${ids}-token`}
            >
              <Input
                id={`${ids}-token`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.token}
                onChange={(e) => set({ token: e.target.value })}
              />
            </Field>
          )}
          {draft.auth === 'oauth' && (
            <p className="text-sm text-muted">{t.t('apps.form.oauthHelp')}</p>
          )}
          {draft.auth === 'oauth_own_client' && (
            <>
              <p className="text-sm text-muted">
                {t.t('apps.form.ownClientHelp', { redirect: OAUTH_REDIRECT_URL })}
              </p>
              {preset?.id === 'gmail' && (
                <p className="text-sm text-muted">{t.t('apps.form.gmailPreview')}</p>
              )}
              <Field label={t.t('apps.form.clientIdLabel')} htmlFor={`${ids}-client-id`}>
                <Input
                  id={`${ids}-client-id`}
                  value={draft.clientId}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => set({ clientId: e.target.value })}
                />
              </Field>
              <Field
                label={
                  existing?.hasClientSecret
                    ? t.t('apps.form.clientSecretNew')
                    : t.t('apps.form.clientSecretLabel')
                }
                htmlFor={`${ids}-client-secret`}
              >
                <Input
                  id={`${ids}-client-secret`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.clientSecret}
                  onChange={(e) => set({ clientSecret: e.target.value })}
                />
              </Field>
            </>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t.t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {existing ? t.t('common.save') : t.t('apps.form.add')}
        </Button>
      </div>
    </form>
  );
}

type View =
  | { kind: 'list' }
  | { kind: 'pick' }
  | { kind: 'add'; target: Target }
  | { kind: 'edit'; server: McpServerView };

export function AppsPanel() {
  const t = useT();
  const servers = useMcpStore((s) => s.servers);
  const { add, update, signIn } = useMcpStore();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return MCP_PRESETS.filter(
      (p) => !needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle),
    );
  }, [query]);

  const build = (target: Target | 'edit', draft: Draft, existing?: McpServerView) => {
    const program = existing
      ? existing.transport === 'stdio'
      : target !== 'edit' && target.kind === 'program';
    const env = parseEnv(draft.env);
    if (program && env === null) {
      setError(t.t('apps.err.bad_env'));
      return null;
    }
    const base = { name: draft.name.trim() };
    const secrets = {
      ...(draft.token.trim() ? { token: draft.token } : {}),
      ...(draft.clientId.trim() ? { clientId: draft.clientId } : {}),
      ...(draft.clientSecret.trim() ? { clientSecret: draft.clientSecret } : {}),
    };
    return {
      ...base,
      ...(program
        ? {
            command: draft.command,
            args: parseArgs(draft.args),
            ...(env && Object.keys(env).length > 0 ? { env } : {}),
          }
        : { url: draft.url }),
      ...secrets,
    };
  };

  const submitAdd = async (target: Target, draft: Draft) => {
    const built = build(target, draft);
    if (!built) return;
    setBusy(true);
    setError(null);
    const program = target.kind === 'program';
    const input: McpServerInput = {
      ...built,
      presetId: target.kind === 'preset' ? target.preset.id : null,
      transport: program ? 'stdio' : 'http',
      auth: program ? 'none' : draft.auth,
    };
    try {
      const made = await add(input);
      setNotice(t.t('apps.added', { name: made.name }));
      setView({ kind: 'list' });
      // Signing in is the next step, so it starts now; how it goes shows on the app's card.
      if (made.status === 'needs_sign_in') void signIn(made.id).catch(() => undefined);
    } catch (e) {
      setError(mcpErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (server: McpServerView, draft: Draft) => {
    const built = build('edit', draft, server);
    if (!built) return;
    setBusy(true);
    setError(null);
    try {
      await update(server.id, built);
      setNotice(t.t('apps.saved'));
      setView({ kind: 'list' });
    } catch (e) {
      setError(mcpErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="apps-title" className="space-y-4">
      <div>
        <h2 id="apps-title" className="text-xl font-semibold">
          {t.t('apps.title')}
        </h2>
        <p className="mt-1 text-muted">{t.t('apps.intro')}</p>
        <p className="mt-1 text-sm text-muted">{t.t('apps.privacy')}</p>
      </div>

      {notice && view.kind === 'list' && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}

      {view.kind === 'list' && (
        <>
          {servers.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong p-6 text-center text-muted">
              {t.t('apps.none')}
            </p>
          ) : (
            <ul className="space-y-3">
              {servers.map((server) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  onEdit={() => {
                    setError(null);
                    setNotice(null);
                    setView({ kind: 'edit', server });
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
            {t.t('apps.add')}
          </Button>
        </>
      )}

      {view.kind === 'pick' && (
        <div className="rounded-xl border border-line bg-panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView({ kind: 'list' })}
              aria-label={t.t('apps.back')}
              title={t.t('apps.back')}
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
                aria-label={t.t('apps.search')}
                placeholder={t.t('apps.search')}
                onChange={(e) => setQuery(e.target.value)}
                className="ps-9"
              />
            </div>
          </div>
          {matches.length === 0 && query.trim() ? (
            <p className="px-2 py-3 text-sm text-muted">{t.t('apps.noMatch', { query })}</p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {matches.map((preset) => (
                <li key={preset.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setView({ kind: 'add', target: { kind: 'preset', preset } });
                    }}
                    className="w-full rounded-lg px-3 py-2 text-start hover:bg-elevated"
                  >
                    <span className="block text-sm font-medium">{preset.name}</span>
                    <span className="block text-xs text-muted">
                      {presetDescription(t, preset.id)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-2 grid gap-1 border-t border-line pt-2 sm:grid-cols-2">
            <li>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setView({ kind: 'add', target: { kind: 'custom' } });
                }}
                className="w-full rounded-lg px-3 py-2 text-start hover:bg-elevated"
              >
                <span className="block text-sm font-medium">{t.t('apps.other')}</span>
                <span className="block text-xs text-muted">{t.t('apps.otherHelp')}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setView({ kind: 'add', target: { kind: 'program' } });
                }}
                className="w-full rounded-lg px-3 py-2 text-start hover:bg-elevated"
              >
                <span className="block text-sm font-medium">{t.t('apps.program')}</span>
                <span className="block text-xs text-muted">{t.t('apps.programHelp')}</span>
              </button>
            </li>
          </ul>
        </div>
      )}

      {view.kind === 'add' && (
        <AppForm
          target={view.target}
          busy={busy}
          error={error}
          onSubmit={(draft) => void submitAdd(view.target, draft)}
          onCancel={() => setView({ kind: 'pick' })}
        />
      )}

      {view.kind === 'edit' && (
        <AppForm
          target={
            view.server.transport === 'stdio'
              ? { kind: 'program' }
              : mcpPresetById(view.server.presetId)
                ? { kind: 'preset', preset: mcpPresetById(view.server.presetId)! }
                : { kind: 'custom' }
          }
          existing={view.server}
          busy={busy}
          error={error}
          onSubmit={(draft) => void submitEdit(view.server, draft)}
          onCancel={() => setView({ kind: 'list' })}
        />
      )}
    </section>
  );
}
