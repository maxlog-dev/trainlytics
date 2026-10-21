/**
 * The session hint: the username of the account last signed in on this browser,
 * kept while its session is believed valid. With a hint the app renders at
 * once (optimistically) and restores that account's persisted query cache
 * while the launch refresh runs; without one it waits for the refresh.
 *
 * Written on login and on every successful refresh, removed on logout and
 * when the session turns out expired. Storage can throw (Safari private
 * mode, blocked site data); then there is simply no hint.
 */

export const SESSION_HINT_KEY = 'trainlytics:session'

export function readSessionHint(): string | null {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) || null
  } catch {
    return null
  }
}

/** False when storage is unavailable: the next launch then waits for the refresh, as before. */
export function writeSessionHint(username: string): boolean {
  try {
    localStorage.setItem(SESSION_HINT_KEY, username)
    return true
  } catch {
    return false
  }
}

/**
 * Removes the hint. With `username`, only if the hint is still that account's,
 * so a tab whose session expired doesn't drop the hint another tab just wrote
 * for a different account.
 */
export function clearSessionHint(username?: string | null): void {
  try {
    if (username && localStorage.getItem(SESSION_HINT_KEY) !== username) return
    localStorage.removeItem(SESSION_HINT_KEY)
  } catch {
    // Nothing stored
  }
}
