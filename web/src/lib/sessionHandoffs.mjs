export function isRemoteSession(session = {}) {
  return !!session.host && session.host !== 'local';
}

export function chatHandoffs(session = {}) {
  const actions = [
    {
      kind: 'files',
      label: 'Files here',
      title: 'Browse files in this session directory',
    },
    {
      kind: 'terminal',
      label: 'Terminal',
      title: 'Open a terminal in this session directory',
    },
  ];
  if (isRemoteSession(session)) {
    actions.push({
      kind: 'tunnels',
      label: 'Tunnels',
      title: 'Open port forwards for this host',
    });
  }
  return actions;
}
