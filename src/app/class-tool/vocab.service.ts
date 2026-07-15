import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { TutorTokenService } from './tutor-token.service';

// ═══════════════════════════════════════════════════════════════════
// VocabService
//
// Wraps the tutor's vocab deck + card CRUD endpoints. Same auth
// contract as MaterialsService — reads ?token=… from URL and sends it
// as Authorization: Bearer. Fails soft when the token is missing so
// the drawer degrades to an "unavailable" state instead of throwing.
// ═══════════════════════════════════════════════════════════════════

export interface VocabDeck {
  id: string;
  tutor_id: string;
  title: string;
  description: string;
  created_at: string;
  updated_at: string | null;
}

export interface VocabCard {
  id: string;
  deck_id: string;
  front: string;
  back: string;
  example: string;
  note: string;
  position: number;
  created_at: string;
  updated_at: string | null;
}

export interface VocabDecksPage {
  data: VocabDeck[];
  total: number;
  page: number;
  limit: number;
}

@Injectable({ providedIn: 'root' })
export class VocabService {
  constructor(private auth: TutorTokenService) {}

  get hasAuth(): boolean {
    return this.auth.hasToken();
  }

  async listDecks(page: number, limit: number, search: string): Promise<VocabDecksPage> {
    const token = this.auth.getToken();
    if (!token) return { data: [], total: 0, page, limit };
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    const q = search.trim();
    if (q) qs.set('q', q);
    const res = await fetch(
      `${environment.apiUrl}/v1/tutor/me/vocab-decks?${qs.toString()}`,
      { headers: this.authHeaders(token) },
    );
    if (!res.ok) return { data: [], total: 0, page, limit };
    const body = await res.json();
    return body?.data as VocabDecksPage;
  }

  async createDeck(title: string, description: string): Promise<VocabDeck | null> {
    const token = this.auth.getToken();
    if (!token) return null;
    const res = await fetch(`${environment.apiUrl}/v1/tutor/me/vocab-decks`, {
      method: 'POST',
      headers: { ...this.authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data as VocabDeck;
  }

  async deleteDeck(deckId: string): Promise<boolean> {
    const token = this.auth.getToken();
    if (!token) return false;
    const res = await fetch(`${environment.apiUrl}/v1/tutor/me/vocab-decks/${deckId}`, {
      method: 'DELETE',
      headers: this.authHeaders(token),
    });
    return res.ok;
  }

  async listCards(deckId: string): Promise<VocabCard[]> {
    const token = this.auth.getToken();
    if (!token) return [];
    const res = await fetch(
      `${environment.apiUrl}/v1/tutor/me/vocab-decks/${deckId}/cards`,
      { headers: this.authHeaders(token) },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.data as VocabCard[]) ?? [];
  }

  async createCard(
    deckId: string,
    front: string,
    back: string,
    example: string,
    note: string,
    position: number,
  ): Promise<VocabCard | null> {
    const token = this.auth.getToken();
    if (!token) return null;
    const res = await fetch(
      `${environment.apiUrl}/v1/tutor/me/vocab-decks/${deckId}/cards`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ front, back, example, note, position }),
      },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data as VocabCard;
  }

  async deleteCard(cardId: string): Promise<boolean> {
    const token = this.auth.getToken();
    if (!token) return false;
    const res = await fetch(`${environment.apiUrl}/v1/tutor/me/vocab-cards/${cardId}`, {
      method: 'DELETE',
      headers: this.authHeaders(token),
    });
    return res.ok;
  }

  // NOTE: this backend's protect() reads the Authorization header
  // as-is (no "Bearer " prefix stripping). Sending the standard
  // "Bearer <jwt>" trips the JWT lib's "tokenstring should not
  // contain 'bearer '" check. Matches slocx-frontend's interceptor.
  private authHeaders(token: string): Record<string, string> {
    return { Authorization: token };
  }
}
