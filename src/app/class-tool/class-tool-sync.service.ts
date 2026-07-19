import { Injectable, OnDestroy } from '@angular/core';
import { Subject, Subscription, BehaviorSubject } from 'rxjs';

// ═══════════════════════════════════════════════════════════════════
// ClassToolSyncService
//
// One-per-app socket adapter for the class tool. Every event the
// server understands has one broadcast method + one Observable so
// components stay ignorant of event-name strings.
//
// IMPORTANT — REUSES CHAT'S SOCKET, DOES NOT CREATE ITS OWN.
//
// chat.component.ts creates the app's ONLY socket via
// `io(environment.socketUrl)`. That socket is what emits joinRoom,
// gets the tutor role registered server-side, and receives the room's
// broadcasts. If this service opened its own socket (as it did in an
// earlier version via ngx-socket-io injection), its socket would
// never have called joinRoom — so:
//
//   1. Emits (`board:open`, `material:open`, `vocab:state`) would
//      hit the server on a socket with no room-scoped handlers →
//      silently vanish, no logs, no rejection.
//   2. Subscribes would receive nothing because broadcasts are
//      scoped to `io.to(roomId)` and this socket never joined.
//
// So chat.component calls `bindSocket(socket)` right after it
// creates the socket. This service holds a reference and does all
// emit/subscribe through that shared connection.
// ═══════════════════════════════════════════════════════════════════

/** Minimal shape we need from a socket.io-client Socket. Kept local
 *  so we don't take a hard dependency on socket.io-client here — the
 *  chat component passes its live socket in. */
interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, cb: (payload: unknown) => void): void;
  off?(event: string, cb: (payload: unknown) => void): void;
}

export interface BoardScenePayload {
  elements: readonly unknown[];
  /** Excalidraw's binary file map (image data keyed by fileId).
   *  Required whenever the scene contains images — without it, the
   *  receiving side sees image elements pointing at nothing and the
   *  canvas either renders blank or crashes. Kept optional so pure-
   *  vector broadcasts stay small. */
  files?: unknown;
}

export interface ActiveMaterialPayload {
  id: string;
  url: string;
  title: string;
  detailUrl?: string;
}

export interface ActiveVocabCard {
  id: string;
  front: string;
  back: string;
  example?: string;
  note?: string;
}

export interface ActiveVocabPayload {
  deckId: string;
  deckTitle: string;
  cards: ActiveVocabCard[];
  index: number;
  revealed: boolean;
}

@Injectable({ providedIn: 'root' })
export class ClassToolSyncService implements OnDestroy {
  readonly scene$ = new Subject<BoardScenePayload>();
  readonly permission$ = new BehaviorSubject<boolean>(false);
  readonly material$ = new BehaviorSubject<ActiveMaterialPayload | null>(null);
  readonly vocab$ = new BehaviorSubject<ActiveVocabPayload | null>(null);
  readonly boardOpen$ = new BehaviorSubject<boolean>(false);

  /** Holds the chat-owned socket after bindSocket() is called. Emits
   *  before this point are dropped (with a diagnostic warn) rather
   *  than silently disappearing. */
  private socket: SocketLike | null = null;

  /** Listener functions we registered on the socket — kept so we can
   *  detach on ngOnDestroy or if bindSocket is called a second time
   *  (should not happen, but be defensive). */
  private listeners: Array<{ event: string; cb: (p: unknown) => void }> = [];

  private subs: Subscription[] = [];

  /**
   * Attach to the socket owned by chat.component. Call ONCE after
   * `io(environment.socketUrl)` — before or after connect is fine;
   * socket.io buffers `on` handlers.
   */
  bindSocket(socket: SocketLike): void {
    if (this.socket === socket) return;
    // If a previous socket was bound (e.g. hot module reload), detach
    // first to avoid double-firing.
    this.detach();
    this.socket = socket;

    this.on('board:scene', (p) => this.scene$.next(p as BoardScenePayload));
    this.on('board:permission', (p) => {
      const v = (p as { studentCanWrite?: boolean } | null)?.studentCanWrite;
      this.permission$.next(!!v);
    });
    this.on('material:open', (p) => this.material$.next(p as ActiveMaterialPayload));
    this.on('material:close', () => this.material$.next(null));
    this.on('vocab:state', (p) => this.vocab$.next(p as ActiveVocabPayload));
    this.on('vocab:close', () => this.vocab$.next(null));
    this.on('board:open', () => this.boardOpen$.next(true));
    this.on('board:close', () => this.boardOpen$.next(false));
    this.on('share:rejected', (payload) => {
      // Loud red console block so it stands out among WebRTC noise.
      // Fires when the server dropped a tutor-only broadcast because
      // the sender wasn't in the room's verified tutor set.
      // eslint-disable-next-line no-console
      console.error(
        '%c[CLASS-TOOL] Server rejected your share event',
        'font-weight:bold;color:#dc2626;background:#fef2f2;padding:2px 6px;border-radius:4px',
        payload,
      );
    });
  }

  // ── Broadcasts ────────────────────────────────────────────────

  broadcastScene(payload: BoardScenePayload): void {
    this.emit('board:scene', payload);
  }

  broadcastPermission(studentCanWrite: boolean): void {
    this.emit('board:permission', { studentCanWrite });
  }

  broadcastOpenMaterial(m: ActiveMaterialPayload): void {
    this.emit('material:open', m);
  }

  broadcastCloseMaterial(): void {
    this.emit('material:close');
  }

  broadcastVocab(snapshot: ActiveVocabPayload): void {
    this.emit('vocab:state', snapshot);
  }

  broadcastCloseVocab(): void {
    this.emit('vocab:close');
  }

  broadcastBoardOpen(): void {
    this.emit('board:open');
  }

  broadcastBoardClose(): void {
    this.emit('board:close');
  }

  ngOnDestroy(): void {
    this.detach();
    this.subs.forEach((s) => s.unsubscribe());
  }

  // ── Internals ────────────────────────────────────────────────

  private on(event: string, cb: (payload: unknown) => void): void {
    if (!this.socket) return;
    this.socket.on(event, cb);
    this.listeners.push({ event, cb });
  }

  private emit(event: string, ...args: unknown[]): void {
    if (!this.socket) {
      // Loud diagnostic — this used to fail silently and was very
      // hard to trace. Now it points squarely at chat.component
      // forgetting to bind the socket.
      // eslint-disable-next-line no-console
      console.error(
        `[CLASS-TOOL] emit ${event} called before bindSocket() — socket not attached. Chat.component must call syncService.bindSocket(this.socket) after opening the socket.`,
      );
      return;
    }
    this.socket.emit(event, ...args);
  }

  private detach(): void {
    if (!this.socket) return;
    const s = this.socket;
    for (const { event, cb } of this.listeners) {
      s.off?.(event, cb);
    }
    this.listeners = [];
    this.socket = null;
  }
}
