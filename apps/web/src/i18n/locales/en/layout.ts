// App shell: header, navigation, footer, shared UI pieces and the not-found page.
export default {
  nav: {
    label: 'Main',
    projects: 'Projects',
    discover: 'Discover',
    pool: 'Pool',
    requests: 'Requests',
    backlog: 'Backlog',
    history: 'History',
    usage: 'Usage',
    claudeCode: 'Claude Code',
    myServer: 'My Server',
    access: 'Access',
    pendingRequests: { one: '{count} pending request', other: '{count} pending requests' },
    pendingAccess: {
      one: '{count} pending access request',
      other: '{count} pending access requests',
    },
  },
  header: {
    home: 'orch home',
    setupWizard: 'Setup wizard',
    gettingStarted: {
      one: 'Getting started: {count} of {total} steps done',
      other: 'Getting started: {count} of {total} steps done',
    },
    docs: 'Documentation',
    repo: 'GitHub repository',
    logOut: 'Log out',
  },
  theme: {
    toLight: 'Switch to light theme',
    toDark: 'Switch to dark theme',
    light: 'Light theme',
    dark: 'Dark theme',
  },
  language: {
    label: 'Language',
  },
  notFound: {
    label: 'Page not found',
    title: 'Page not found',
    body: 'This page does not exist.',
    back: 'Back to orch',
  },
  copy: {
    failed: 'Copy failed. Select the command and copy it by hand.',
  },
  pwa: {
    updateReady: 'New version available',
    reload: 'Reload',
  },
  agentUpdate: {
    label: 'Agent update',
    outdated: 'Your agent on <strong>{machine}</strong> is out of date (v{from} → v{to})',
    manual: 'How to update manually',
    ifFails: 'If that fails:',
  },
} as const;
