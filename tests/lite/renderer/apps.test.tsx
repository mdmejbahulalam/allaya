import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpServerView, TaskView } from '@lite/shared/ipc';
import { OAUTH_REDIRECT_URL } from '@lite/shared/mcp-presets';
import { TaskForm } from '@lite/renderer/src/components/task-form';
import { TasksScreen } from '@lite/renderer/src/components/tasks-screen';
import { AppsPanel, parseArgs, parseEnv } from '@lite/renderer/src/settings/apps-panel';
import { SettingsView } from '@lite/renderer/src/settings/settings-view';
import { useAppStore } from '@lite/renderer/src/stores/app';
import { useMcpStore } from '@lite/renderer/src/stores/mcp';
import { useTasksStore } from '@lite/renderer/src/stores/tasks';
import { bridge, fail, renderLite, resetStores } from './helpers';

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: 'mcp_1',
  name: 'Notes',
  presetId: null,
  transport: 'http',
  url: 'https://notes.example.com/mcp',
  command: null,
  args: [],
  envKeys: [],
  auth: 'token',
  enabled: true,
  trusted: false,
  status: 'connected',
  error: null,
  tools: [
    {
      name: 'search_notes',
      title: 'Search notes',
      description: 'Looks for notes.',
      enabled: true,
      ask: true,
      askByDefault: true,
    },
    {
      name: 'delete_note',
      description: 'Deletes a note.',
      enabled: false,
      ask: true,
      askByDefault: true,
    },
  ],
  hasToken: true,
  tokenHint: 'sk-…ABCD',
  clientId: null,
  hasClientSecret: false,
  signedIn: false,
  group: 'mcp:mcp_1',
  ...over,
});

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([c]) => c === channel);

beforeEach(() => {
  resetStores();
  useMcpStore.setState({ servers: [], loaded: true });
  useTasksStore.setState({ tasks: [], loaded: true, view: { kind: 'list' }, runs: [] });
  bridge();
});

const openGallery = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Add an app' }));
};

describe('writing down a program’s arguments and settings', () => {
  it('takes one argument per line, and skips empty lines', () => {
    expect(parseArgs('-y\n@scope/server\n\n  \r\n--flag=1\r\n')).toEqual([
      '-y',
      '@scope/server',
      '--flag=1',
    ]);
    expect(parseArgs('')).toEqual([]);
  });

  it('takes NAME=value per line, keeps what follows the first =, and refuses anything else', () => {
    expect(parseEnv('TOKEN=abc=def\nEMPTY=\n\nA_1= spaced ')).toEqual({
      TOKEN: 'abc=def',
      EMPTY: '',
      A_1: ' spaced ',
    });
    expect(parseEnv('')).toEqual({});
    for (const bad of ['no equals', '=novalue', '1BAD=x', 'has space=x']) {
      expect(parseEnv(bad), bad).toBeNull();
    }
  });
});

describe('the list of connected apps', () => {
  it('invites the person to add one', () => {
    renderLite(<AppsPanel />);
    expect(screen.getByText('No apps connected yet.')).toBeVisible();
    expect(screen.getByText(/asks you before anything that changes something/)).toBeVisible();
  });

  it('shows each app with where it is, how it is doing, and why when it is not', () => {
    useMcpStore.setState({
      servers: [
        server(),
        server({ id: 'b', name: 'Mail', status: 'needs_sign_in', auth: 'oauth', tools: [] }),
        server({
          id: 'c',
          name: 'Broken',
          status: 'error',
          error: 'Could not connect: fetch failed',
          tools: [],
        }),
        server({ id: 'd', name: 'Slow', status: 'connecting', tools: [] }),
        server({ id: 'e', name: 'Waiting', status: 'signing_in', auth: 'oauth', tools: [] }),
        server({
          id: 'f',
          name: 'Local',
          transport: 'stdio',
          url: null,
          command: 'npx',
          args: ['-y', 'x'],
          auth: 'none',
          envKeys: ['K'],
          tools: [],
        }),
      ],
    });
    renderLite(<AppsPanel />);
    const [notes, mail, broken, slow, waiting, local] = screen.getAllByTestId('app');
    expect(within(notes!).getByText('Connected · 1 tools')).toBeVisible();
    expect(within(notes!).getByText('https://notes.example.com/mcp')).toBeVisible();
    expect(within(mail!).getByText('Needs sign-in')).toBeVisible();
    expect(within(broken!).getByText('Could not connect')).toBeVisible();
    expect(within(broken!).getByRole('alert')).toHaveTextContent('Could not connect: fetch failed');
    expect(within(slow!).getByText('Connecting…')).toBeVisible();
    expect(
      within(waiting!).getByText('Waiting for you to sign in, in your browser…'),
    ).toBeVisible();
    expect(within(local!).getByText('npx -y x')).toBeVisible();
  });

  it('shows the button that fits what is needed: sign in, cancel, connect again, sign out', async () => {
    useMcpStore.setState({
      servers: [
        server({ id: 'a', name: 'A', status: 'needs_sign_in', auth: 'oauth', tools: [] }),
        server({ id: 'b', name: 'B', status: 'signing_in', auth: 'oauth', tools: [] }),
        server({ id: 'c', name: 'C', status: 'error', error: 'x', tools: [] }),
        server({ id: 'd', name: 'D', status: 'connected', auth: 'oauth', signedIn: true }),
        server({ id: 'e', name: 'E', status: 'connected' }),
      ],
    });
    const invoke = bridge({
      'mcp:signIn': () => server({ id: 'a', status: 'connected' }),
      'mcp:reconnect': () => server({ id: 'c', status: 'connected' }),
      'mcp:signOut': () => server({ id: 'd', status: 'needs_sign_in', signedIn: false }),
    });
    renderLite(<AppsPanel />);
    const [a, b, c, d, e] = screen.getAllByTestId('app');
    await userEvent.click(within(a!).getByRole('button', { name: 'Sign in' }));
    expect(invoke).toHaveBeenCalledWith('mcp:signIn', { id: 'a' });
    await userEvent.click(within(b!).getByRole('button', { name: 'Cancel' }));
    expect(invoke).toHaveBeenCalledWith('mcp:cancelSignIn', { id: 'b' });
    expect(within(b!).getByRole('button', { name: 'Change' })).toBeDisabled();
    await userEvent.click(within(c!).getByRole('button', { name: 'Connect again' }));
    expect(invoke).toHaveBeenCalledWith('mcp:reconnect', { id: 'c' });
    await userEvent.click(within(d!).getByRole('button', { name: 'Sign out' }));
    expect(invoke).toHaveBeenCalledWith('mcp:signOut', { id: 'd' });
    expect(within(e!).queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(within(e!).queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('says why an action failed, in words', async () => {
    useMcpStore.setState({
      servers: [server({ status: 'needs_sign_in', auth: 'oauth', tools: [] })],
    });
    bridge({
      'mcp:signIn': () => {
        throw fail('LIMIT_EXCEEDED', 'x', { reason: 'port_busy' });
      },
    });
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Another program is using the port');
  });

  it('switches an app off and on', async () => {
    useMcpStore.setState({ servers: [server()] });
    const invoke = bridge({ 'mcp:update': () => server({ enabled: false, status: 'off' }) });
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByRole('switch', { name: 'Use this app' }));
    expect(invoke).toHaveBeenCalledWith('mcp:update', { id: 'mcp_1', changes: { enabled: false } });
  });

  it('asks before removing an app, and removes it', async () => {
    useMcpStore.setState({ servers: [server()] });
    const invoke = bridge();
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove “Notes” and everything saved for it?')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(invoke).not.toHaveBeenCalledWith('mcp:remove', expect.anything());
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(invoke).toHaveBeenCalledWith('mcp:remove', { id: 'mcp_1' });
    await waitFor(() => expect(useMcpStore.getState().servers).toEqual([]));
  });
});

describe('what each tool may do', () => {
  it('lists the tools of a connected app, and says how it asks', async () => {
    useMcpStore.setState({ servers: [server()] });
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByText('Tools (2)'));
    expect(screen.getByText('Search notes')).toBeVisible();
    expect(screen.getByText('delete_note')).toBeVisible();
    expect(screen.getByText(/asks before every action in this app/)).toBeVisible();
    useMcpStore.setState({ servers: [server({ trusted: true })] });
    expect(await screen.findByText(/Tools that only read run without asking/)).toBeVisible();
  });

  it('switches a tool off, and asking off, each on its own', async () => {
    useMcpStore.setState({ servers: [server()] });
    const invoke = bridge({ 'mcp:setTool': () => server() });
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByText('Tools (2)'));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Ask before using “Search notes”' }),
    );
    expect(invoke).toHaveBeenCalledWith('mcp:setTool', {
      id: 'mcp_1',
      tool: 'search_notes',
      ask: false,
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Use “Search notes”' }));
    expect(invoke).toHaveBeenCalledWith('mcp:setTool', {
      id: 'mcp_1',
      tool: 'search_notes',
      enabled: false,
    });
    // A tool that is off cannot be asked about.
    expect(screen.getByRole('checkbox', { name: 'Ask before using “delete_note”' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Use “delete_note”' }));
    expect(invoke).toHaveBeenCalledWith('mcp:setTool', {
      id: 'mcp_1',
      tool: 'delete_note',
      enabled: true,
    });
  });
});

describe('adding an app', () => {
  it('offers the apps Allaya knows, with what each is for, a search, and the two open choices', async () => {
    renderLite(<AppsPanel />);
    await openGallery();
    expect(screen.getByText('Repositories, issues and pull requests')).toBeVisible();
    for (const name of ['GitHub', 'Gmail', 'Ahrefs', 'Notion', 'Linear']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    expect(screen.getByRole('button', { name: /^Another app/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /^A program on this computer/ })).toBeVisible();
    await userEvent.type(screen.getByRole('textbox', { name: 'Find an app' }), 'git');
    expect(screen.getByRole('button', { name: /^GitHub/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Notion/ })).toBeNull();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Find an app' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Find an app' }), 'zzzz');
    expect(screen.getByText('No app matches “zzzz”.')).toBeVisible();
  });

  it('GitHub: asks for a key, says where to get one, and sends it with the address', async () => {
    const invoke = bridge({
      'mcp:add': () => server({ name: 'GitHub', status: 'connecting', tools: [] }),
    });
    renderLite(<AppsPanel />);
    await openGallery();
    await userEvent.click(screen.getByRole('button', { name: /^GitHub/ }));
    expect(screen.getByLabelText('Address')).toHaveValue('https://api.githubcopilot.com/mcp/');
    expect(screen.getByText(/Personal access tokens/)).toBeVisible();
    // One way to sign in: no choice to make.
    expect(screen.queryByLabelText('How to sign in')).toBeNull();
    await userEvent.type(screen.getByLabelText('Key'), 'ghp_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('mcp:add', {
        name: 'GitHub',
        presetId: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        auth: 'token',
        token: 'ghp_secret',
      }),
    );
    expect(await screen.findByText('“GitHub” added.')).toBeVisible();
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['GitHub']);
  });

  it('Ahrefs: a key or signing in on the website; choosing the website takes the key box away and starts signing in', async () => {
    const invoke = bridge({
      'mcp:add': () =>
        server({ id: 'ah', name: 'Ahrefs', status: 'needs_sign_in', auth: 'oauth', tools: [] }),
      'mcp:signIn': () => server({ id: 'ah', name: 'Ahrefs', status: 'connected', auth: 'oauth' }),
    });
    renderLite(<AppsPanel />);
    await openGallery();
    await userEvent.click(screen.getByRole('button', { name: /^Ahrefs/ }));
    expect(screen.getByLabelText('Key')).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('How to sign in'), 'oauth');
    expect(screen.queryByLabelText('Key')).toBeNull();
    expect(screen.getByText(/browser opens on the app’s own page/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('mcp:add', {
        name: 'Ahrefs',
        presetId: 'ahrefs',
        transport: 'http',
        url: 'https://api.ahrefs.com/mcp/mcp',
        auth: 'oauth',
      }),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp:signIn', { id: 'ah' }));
  });

  it('Gmail: asks for the person’s own app, says what address to register, and signs in after adding', async () => {
    const invoke = bridge({
      'mcp:add': () =>
        server({
          id: 'gm',
          name: 'Gmail',
          status: 'needs_sign_in',
          auth: 'oauth_own_client',
          tools: [],
        }),
      'mcp:signIn': () =>
        server({ id: 'gm', name: 'Gmail', auth: 'oauth_own_client', signedIn: true }),
    });
    renderLite(<AppsPanel />);
    await openGallery();
    await userEvent.click(screen.getByRole('button', { name: /^Gmail/ }));
    expect(
      screen.getByText(new RegExp(OAUTH_REDIRECT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ).toBeVisible();
    expect(screen.getByText(/developer preview/)).toBeVisible();
    await userEvent.type(screen.getByLabelText('Client ID'), 'abc.apps.example');
    await userEvent.type(screen.getByLabelText('Client secret'), 'shh-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('mcp:add', {
        name: 'Gmail',
        presetId: 'gmail',
        transport: 'http',
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        auth: 'oauth_own_client',
        clientId: 'abc.apps.example',
        clientSecret: 'shh-secret',
      }),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp:signIn', { id: 'gm' }));
  });

  it('another app: any address, with or without a key — and an unsafe address is explained, not sent on', async () => {
    const invoke = bridge({
      'mcp:add': () => {
        throw fail('INVALID_INPUT', 'x', { reason: 'insecure_remote' });
      },
    });
    renderLite(<AppsPanel />);
    await openGallery();
    await userEvent.click(screen.getByRole('button', { name: /^Another app/ }));
    expect(screen.getByLabelText('Address')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Name'), 'My notes');
    await userEvent.type(screen.getByLabelText('Address'), 'http://notes.example.com/mcp');
    expect(screen.getByLabelText('How to sign in')).toHaveValue('none');
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use https://');
    expect(invoke).toHaveBeenCalledWith('mcp:add', {
      name: 'My notes',
      presetId: null,
      transport: 'http',
      url: 'http://notes.example.com/mcp',
      auth: 'none',
    });
    expect(screen.getByRole('button', { name: 'Add app' })).toBeEnabled();
  });

  it('a program: warns, takes arguments and settings, and refuses a settings line that is not NAME=value', async () => {
    const invoke = bridge({
      'mcp:add': () =>
        server({
          id: 'p',
          name: 'Local',
          transport: 'stdio',
          url: null,
          command: 'npx',
          auth: 'none',
          status: 'connecting',
          tools: [],
        }),
    });
    renderLite(<AppsPanel />);
    await openGallery();
    await userEvent.click(screen.getByRole('button', { name: /^A program on this computer/ }));
    expect(screen.getByText(/starts a program on your computer/)).toBeVisible();
    expect(screen.queryByLabelText('Address')).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'Local');
    await userEvent.type(screen.getByLabelText('Program'), 'npx');
    await userEvent.type(
      screen.getByLabelText('Arguments (one per line)'),
      '-y{enter}@scope/server',
    );
    await userEvent.type(screen.getByLabelText(/^Settings for the program/), 'oops no equals');
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    expect(screen.getByRole('alert')).toHaveTextContent('NAME=value');
    expect(calls(invoke, 'mcp:add')).toHaveLength(0);
    await userEvent.clear(screen.getByLabelText(/^Settings for the program/));
    await userEvent.type(
      screen.getByLabelText(/^Settings for the program/),
      'API_KEY=abc{enter}MODE=x',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('mcp:add', {
        name: 'Local',
        presetId: null,
        transport: 'stdio',
        auth: 'none',
        command: 'npx',
        args: ['-y', '@scope/server'],
        env: { API_KEY: 'abc', MODE: 'x' },
      }),
    );
  });

  it('goes back one step at a time', async () => {
    renderLite(<AppsPanel />);
    await openGallery();
    await userEvent.click(screen.getByRole('button', { name: /^GitHub/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('textbox', { name: 'Find an app' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Add an app' })).toBeVisible();
  });
});

describe('changing an app', () => {
  it('fills the form with what is there, never shows a key, and sends only what was changed', async () => {
    useMcpStore.setState({ servers: [server({ presetId: 'github' })] });
    const invoke = bridge({ 'mcp:update': () => server() });
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Notes');
    expect(screen.getByLabelText('Address')).toHaveValue('https://notes.example.com/mcp');
    expect(screen.getByLabelText('New key (leave empty to keep the current one)')).toHaveValue('');
    expect(screen.queryByLabelText('How to sign in')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Journal');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('mcp:update', {
        id: 'mcp_1',
        changes: { name: 'Journal', url: 'https://notes.example.com/mcp' },
      }),
    );
    expect(await screen.findByText('Saved.')).toBeVisible();
  });

  it('a program keeps its settings unless new ones are written, and shows only their names', async () => {
    useMcpStore.setState({
      servers: [
        server({
          transport: 'stdio',
          url: null,
          command: 'npx',
          args: ['-y', 'x'],
          auth: 'none',
          envKeys: ['API_KEY'],
          tools: [],
        }),
      ],
    });
    const invoke = bridge({ 'mcp:update': () => server() });
    renderLite(<AppsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByText(/Set now: API_KEY/)).toBeVisible();
    expect(screen.getByLabelText('Arguments (one per line)')).toHaveValue('-y\nx');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('mcp:update', {
        id: 'mcp_1',
        changes: { name: 'Notes', command: 'npx', args: ['-y', 'x'] },
      }),
    );
  });
});

describe('apps in tasks', () => {
  const task = (over: Partial<TaskView> = {}): TaskView => ({
    id: 't1',
    title: 'Digest',
    instructions: 'Do it.',
    model: null,
    schedule: { kind: 'manual' },
    groups: ['browser', 'mcp:mcp_1', 'mcp:gone'],
    enabled: true,
    nextRunAt: null,
    running: false,
    createdBy: 'person',
    createdAt: 1,
    lastRun: null,
    ...over,
  });

  it('offers each connected app to a task, and sends the ones chosen', async () => {
    useMcpStore.setState({
      servers: [
        server(),
        server({ id: 'mcp_2', name: 'Mail', group: 'mcp:mcp_2', enabled: false }),
      ],
    });
    const created = task({ groups: ['mcp:mcp_2'] });
    const invoke = bridge({
      'tasks:create': () => created,
      'tasks:list': () => [created],
      'tasks:get': () => ({ task: created, runs: [] }),
    });
    renderLite(<TaskForm task={null} />);
    expect(screen.getByRole('checkbox', { name: /Use Notes/ })).not.toBeChecked();
    expect(screen.getByText('This app is switched off for now.')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Name'), 'Digest');
    await userEvent.type(screen.getByLabelText('What should Allaya do?'), 'Do it.');
    await userEvent.click(screen.getByRole('checkbox', { name: /Use Mail/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Let it open and read web pages/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tasks:create', {
        title: 'Digest',
        instructions: 'Do it.',
        model: null,
        schedule: { kind: 'manual' },
        groups: ['mcp:mcp_2'],
      }),
    );
  });

  it('points to Settings when no app is connected', async () => {
    renderLite(<TaskForm task={null} />);
    expect(screen.getByText(/connect it first/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Connect an app' }));
    expect(useAppStore.getState()).toMatchObject({ route: 'settings', settingsTab: 'apps' });
  });

  it('editing keeps an app that has since been removed, and shows the apps now chosen', async () => {
    useMcpStore.setState({ servers: [server()] });
    const t = task();
    const invoke = bridge({ 'tasks:update': () => t });
    renderLite(<TaskForm task={t} />);
    expect(screen.getByRole('checkbox', { name: /Use Notes/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tasks:update', {
        id: 't1',
        changes: expect.objectContaining({ groups: ['browser', 'mcp:mcp_1', 'mcp:gone'] }),
      }),
    );
  });

  it('a task shows the apps it may use by name', () => {
    useMcpStore.setState({ servers: [server()] });
    useTasksStore.setState({ tasks: [task()], view: { kind: 'detail', id: 't1' }, runs: [] });
    renderLite(<TasksScreen />);
    expect(screen.getByText('Open and read web pages, Notes')).toBeVisible();
  });
});

describe('settings', () => {
  it('has an Apps tab', async () => {
    useAppStore.setState({ route: 'settings', settingsTab: 'providers' });
    renderLite(<SettingsView />);
    await userEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(useAppStore.getState().settingsTab).toBe('apps');
    expect(screen.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
  });

  it('keeps the list true as the engine reports', () => {
    useMcpStore.getState().set([server()]);
    expect(useMcpStore.getState().servers).toHaveLength(1);
    useMcpStore.getState().set([]);
    expect(useMcpStore.getState().servers).toEqual([]);
  });
});
