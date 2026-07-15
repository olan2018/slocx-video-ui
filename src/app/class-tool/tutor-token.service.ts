import { Injectable } from '@angular/core';

// ═══════════════════════════════════════════════════════════════════
// TutorTokenService
//
// Single source of truth for the tutor's session JWT inside the
// meeting UI. Two possible providers:
//
//   1. URL param (`?token=…`) — used when the tutor opens the meeting
//      from the tutor dashboard, which appends the JWT server-side.
//   2. In-memory (setToken) — set after a successful tutor login on
//      the classroom-choice screen (Phase 5 flow). This path does NOT
//      touch the URL because putting the JWT in the address bar leaks
//      it to browser history, referrer headers, and casual screen-
//      shares.
//
// MaterialsService / VocabService inject this and consult it on
// every call. Prefer the setter's value when present so a fresh
// classroom login supersedes any stale URL token.
// ═══════════════════════════════════════════════════════════════════

@Injectable({ providedIn: 'root' })
export class TutorTokenService {
  private inMemory: string | null = null;

  /** Called by chat.component after `submitTutorLogin` succeeds. */
  setToken(token: string): void {
    this.inMemory = token || null;
  }

  /** Called on logout / session-invalid to force the drawer back to
   *  its "unavailable" state without a page reload. */
  clearToken(): void {
    this.inMemory = null;
  }

  /** Current token, or null. Checks in-memory first (fresher after
   *  login), then falls back to `?token=` on the URL. */
  getToken(): string | null {
    if (this.inMemory) return this.inMemory;
    try {
      return new URLSearchParams(window.location.search).get('token');
    } catch {
      return null;
    }
  }

  /** Convenience alias for the drawer's "hasAuth" state.
   *  Not reactive — drawers snapshot at render; they re-render when
   *  their parent flips them open so the check runs again then. */
  hasToken(): boolean {
    return !!this.getToken();
  }
}
