import { Injectable, OnDestroy } from '@angular/core';
import { Socket } from 'ngx-socket-io';
import { Subject, Subscription, BehaviorSubject } from 'rxjs';

// ═══════════════════════════════════════════════════════════════════
// ClassToolSyncService
//
// One-per-app socket adapter for the class tool. Every event the
// server understands has one broadcast method + one Observable so
// components stay ignorant of ngx-socket-io / event-name strings.
//
// Reuses the same Socket that chat.component.ts already opens — no
// separate connection.
//
// Wire coverage (Phase 2):
//   board:scene       — full whiteboard scene, tutor or writable student
//   board:permission  — tutor-only toggle of student write access
//
// Phases 3/4 (materials, vocab) will add methods here; the general
// shape stays "one broadcast per event, one Observable per event".
// ═══════════════════════════════════════════════════════════════════

/** Payload we send + receive on `board:scene`. Elements-only on
 *  purpose — broadcasting the sender's appState would let their zoom /
 *  pan / cursor fight the peer's local view. */
export interface BoardScenePayload {
  elements: readonly unknown[];
}

/** Currently-open material as relayed by the signaling server. The
 *  URL is authoritative — students render it directly (image/pdf/
 *  video/audio picker in the viewer). */
export interface ActiveMaterialPayload {
  id: string;
  url: string;
  title: string;
}

/** Vocab card as broadcast to the room. Inlined into the ActiveVocab
 *  snapshot so the student can render without a backend fetch (they
 *  have no token). */
export interface ActiveVocabCard {
  id: string;
  front: string;
  back: string;
  example?: string;
  note?: string;
}

/** Full snapshot of the current vocab practice session. Tutor is the
 *  only writer — every navigate / reveal is a re-broadcast of the
 *  whole snapshot rather than a diff, which keeps the server dumb and
 *  makes late-join replay trivial. */
export interface ActiveVocabPayload {
  deckId: string;
  deckTitle: string;
  cards: ActiveVocabCard[];
  index: number;
  revealed: boolean;
}

@Injectable({ providedIn: 'root' })
export class ClassToolSyncService implements OnDestroy {
  /** Fires whenever the OTHER side broadcasts a board scene, or on join
   *  when the server replays the cached scene. Consumers apply it to
   *  their local Excalidraw via the bridge. */
  readonly scene$ = new Subject<BoardScenePayload>();

  /** Current studentCanWrite state. BehaviorSubject so late subscribers
   *  see the last value (matters for the class-tool component which
   *  subscribes only after the panel opens). Default false — server
   *  overrides to true if the tutor already granted access before we
   *  joined. */
  readonly permission$ = new BehaviorSubject<boolean>(false);

  /** Currently-open material (or null when closed). BehaviorSubject
   *  same as permission$ — a student who opens the class tool after
   *  the tutor picked a material still needs to see it. */
  readonly material$ = new BehaviorSubject<ActiveMaterialPayload | null>(null);

  /** Currently-active vocab practice snapshot (or null). Same late-
   *  subscriber semantics — student opening the tool mid-practice
   *  gets the current card immediately. */
  readonly vocab$ = new BehaviorSubject<ActiveVocabPayload | null>(null);

  private subs: Subscription[] = [];

  constructor(private socket: Socket) {
    this.subs.push(
      this.socket.fromEvent<BoardScenePayload>('board:scene').subscribe((p) => {
        this.scene$.next(p);
      }),
      this.socket
        .fromEvent<{ studentCanWrite: boolean }>('board:permission')
        .subscribe((p) => {
          this.permission$.next(!!p.studentCanWrite);
        }),
      this.socket.fromEvent<ActiveMaterialPayload>('material:open').subscribe((p) => {
        this.material$.next(p);
      }),
      this.socket.fromEvent<void>('material:close').subscribe(() => {
        this.material$.next(null);
      }),
      this.socket.fromEvent<ActiveVocabPayload>('vocab:state').subscribe((p) => {
        this.vocab$.next(p);
      }),
      this.socket.fromEvent<void>('vocab:close').subscribe(() => {
        this.vocab$.next(null);
      }),
    );
  }

  /** Broadcast our local scene. Server enforces permission — a student
   *  without write access has their event silently dropped. */
  broadcastScene(payload: BoardScenePayload): void {
    this.socket.emit('board:scene', payload);
  }

  /** Tutor-only. Server drops the event if the sender isn't a tutor. */
  broadcastPermission(studentCanWrite: boolean): void {
    this.socket.emit('board:permission', { studentCanWrite });
  }

  /** Tutor picked a material to show. Server caches it (so late
   *  joiners get it) and relays to everyone. */
  broadcastOpenMaterial(m: ActiveMaterialPayload): void {
    this.socket.emit('material:open', m);
  }

  /** Tutor dismisses the current material. Symmetric with open;
   *  student's viewer disappears. */
  broadcastCloseMaterial(): void {
    this.socket.emit('material:close');
  }

  /** Push the full vocab practice snapshot. Server caches + relays.
   *  Any change (open deck, next/prev card, reveal) is a new snapshot. */
  broadcastVocab(snapshot: ActiveVocabPayload): void {
    this.socket.emit('vocab:state', snapshot);
  }

  /** Tutor ends the practice session. */
  broadcastCloseVocab(): void {
    this.socket.emit('vocab:close');
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }
}
