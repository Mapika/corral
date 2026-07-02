// Launch options shared by the desktop DirPicker and the phone LaunchSheet. Models are bare
// `--model` aliases (SAFE_ARG-clean); the backend defaults the model when null. Permission modes
// map onto each agent's native policy knobs in agents/*.js.
export const MODELS = {
  claude: [{ v: null, l: 'Default' }, { v: 'opus', l: 'Opus' }, { v: 'sonnet', l: 'Sonnet' }, { v: 'haiku', l: 'Haiku' }],
  codex: [{ v: null, l: 'Default' }, { v: 'gpt-5.3-codex', l: 'GPT-5.3 Codex' }],
  opencode: [{ v: null, l: 'Default' }],
};

export const PERMS = [
  { v: 'auto', l: 'Auto' },
  { v: 'acceptEdits', l: 'Accept edits' },
  { v: 'default', l: 'Ask' },
  { v: 'plan', l: 'Plan' },
];

export const AGENTS = [
  { v: 'claude', l: 'Claude' },
  { v: 'codex', l: 'Codex' },
  { v: 'opencode', l: 'OpenCode' },
];
