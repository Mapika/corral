import { apiErrorMessage } from './apiRequest.mjs';
import { writeClipboardText } from './clipboardAction.mjs';

export function dashboardHomeAction(selected) {
  const current = !selected;
  return {
    title: current ? 'Dashboard' : 'Open dashboard',
    current,
  };
}

export function shellHostGroups(groups = [], hostCards = []) {
  const cards = new Map(hostCards.map((card) => [card.host || 'local', card]));
  return groups.map((group) => {
    const host = group.host || 'local';
    const card = cards.get(host);
    return {
      ...group,
      host,
      canLaunch: card?.canLaunch !== false,
      launchBlockedLabel: card?.launchBlockedLabel || '',
    };
  });
}

export async function runOperatorRequest({ label = 'Action', request, toast } = {}) {
  try {
    const result = await request?.();
    if (result?.ok !== false) return { ok: true, result };

    const error = apiErrorMessage(result?.error || 'unknown', 'unknown');
    toast?.(`${label} failed: ${error}`);
    return { ok: false, error };
  } catch (e) {
    const error = apiErrorMessage(e, 'unknown');
    toast?.(`${label} failed: ${error}`);
    return { ok: false, error };
  }
}

export async function copyOperatorBriefText(text, { writeClipboard = writeClipboardText, toast } = {}) {
  const result = await writeClipboard(text);
  toast?.(
    result.ok ? 'Operator brief copied' : 'Copy failed: ' + (result.error || 'unknown'),
    result.ok ? 'ok' : 'error',
    result.ok ? 2200 : 5000,
  );
  return result;
}

function issueDetail(value) {
  if (!value) return '';
  const raw = typeof value === 'string'
    ? value
    : typeof value?.message === 'string'
      ? value.message
      : 'sync failed';
  return raw.trim().split(/\r?\n/)[0].slice(0, 120) || 'sync failed';
}

export function syncIssueItems(errors = {}) {
  return [
    ['sessions', 'sessions'],
    ['hosts', 'hosts'],
    ['tunnels', 'tunnels'],
    ['hostStatus', 'host checks'],
  ]
    .map(([key, label]) => ({ id: key, label, detail: issueDetail(errors[key]) }))
    .filter((item) => item.detail);
}
