import { getPrefs } from '../storage/prefs';
import { getRecoveryOffer } from './sessions';

const BRASS = '#B8791A';

/** Alerts mode only ever shows something you can act on; otherwise the badge stays empty. */
export async function refreshBadge(): Promise<void> {
  const prefs = await getPrefs();
  let text = '';
  if (prefs.badge === 'tabs') {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    text = tabs.length > 999 ? '999+' : String(tabs.length);
  } else if (prefs.badge === 'alerts') {
    if (await getRecoveryOffer().catch(() => null)) text = '!';
  }
  await chrome.action.setBadgeBackgroundColor({ color: BRASS });
  await chrome.action.setBadgeText({ text });
}
