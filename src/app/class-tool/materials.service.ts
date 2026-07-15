import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

// ═══════════════════════════════════════════════════════════════════
// MaterialsService
//
// Wraps the tutor's paginated materials endpoint (backend:
// GET /v1/tutor/me/materials?page=&limit=&q=). Uses plain fetch to
// match this repo's existing HTTP style (see chat.component.ts).
//
// Auth: the endpoint is behind ProtectTutor (JWT bearer). The meeting
// UI is normally token-free, so the tutor's JWT is passed on the URL
// (`?token=...`) by whichever page opens the meeting. This service
// snapshots that token from window.location once and reuses it.
//
// If the token is missing, calls return an empty list rather than
// throwing — the drawer degrades to an "unavailable" state instead
// of crashing the whole class tool.
// ═══════════════════════════════════════════════════════════════════

export interface Material {
  id: string;
  url: string;
  title: string;
  createdat: string;
  group_lesson_id?: string | null;
  tutor_id?: string | null;
  updatedat?: string | null;
}

export interface MaterialsPage {
  data: Material[];
  total: number;
  page: number;
  limit: number;
}

@Injectable({ providedIn: 'root' })
export class MaterialsService {
  private token: string | null = readTokenFromUrl();

  /** True when we know we have no way to reach the endpoint. UI uses
   *  this to render an "auth missing" state instead of a spinner
   *  that will never resolve. */
  get hasAuth(): boolean {
    return !!this.token;
  }

  async list(page: number, limit: number, search: string): Promise<MaterialsPage> {
    if (!this.token) {
      return { data: [], total: 0, page, limit };
    }
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    const q = search.trim();
    if (q) qs.set('q', q);

    const res = await fetch(
      `${environment.apiUrl}/v1/tutor/me/materials?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) {
      // 401 or 5xx — surface an empty page. The drawer's error banner
      // is separate (subscribed to a Subject) and handled by the
      // component; we don't want fetch failures to blow up other
      // pages of the tool that don't touch materials.
      return { data: [], total: 0, page, limit };
    }
    const body = await res.json();
    // Envelope: { status, data: { data, total, page, limit } }
    return body?.data as MaterialsPage;
  }
}

// Read `?token=...` from the current URL. Cheap enough to run once at
// service construction — the meeting URL doesn't change during a
// session, and if it did, the user would reload anyway.
function readTokenFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
  } catch {
    return null;
  }
}
