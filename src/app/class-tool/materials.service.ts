import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { TutorTokenService } from './tutor-token.service';

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
  constructor(private auth: TutorTokenService) {}

  /** True when we know we have no way to reach the endpoint. UI uses
   *  this to render an "auth missing" state instead of a spinner
   *  that will never resolve. Read each time — the classroom login
   *  flow sets the token AFTER the service was constructed. */
  get hasAuth(): boolean {
    return this.auth.hasToken();
  }

  async list(page: number, limit: number, search: string): Promise<MaterialsPage> {
    const token = this.auth.getToken();
    if (!token) {
      return { data: [], total: 0, page, limit };
    }
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    const q = search.trim();
    if (q) qs.set('q', q);

    // Source: /me/contents (tutor's video+image content library).
    // The class-tool drawer is called "Materials" but the underlying
    // rows come from the `contents` table, not the older per-group-
    // lesson `materials` table. Backend returns the same {id,url,
    // title} shape either way so no adapter code is needed here.
    //
    // NOTE: this backend's protect() reads the Authorization header
    // as-is (no "Bearer " prefix stripping). Sending the standard
    // "Bearer <jwt>" trips the JWT lib's "tokenstring should not
    // contain 'bearer '" check. Matches slocx-frontend's interceptor.
    const res = await fetch(
      `${environment.apiUrl}/v1/tutor/me/contents?${qs.toString()}`,
      { headers: { Authorization: token } },
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
