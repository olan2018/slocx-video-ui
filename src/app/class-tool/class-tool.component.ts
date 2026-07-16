import {
  Component,
  ElementRef,
  HostBinding,
  Input,
  ViewChild,
  AfterViewChecked,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import type { ExcalidrawHandle } from './excalidraw-mount';
import {
  ClassToolSyncService,
  ActiveMaterialPayload,
  ActiveVocabPayload,
} from './class-tool-sync.service';
import { Material } from './materials.service';
import { environment } from '../../environments/environment';
import { VocabDeck, VocabCard } from './vocab.service';

// ═══════════════════════════════════════════════════════════════════
// ClassToolComponent — floating-panel edition
//
// Instead of one full-screen overlay containing every tool, each tool
// (whiteboard, materials, vocab) renders as its own independent
// floating panel over the meeting UI. Panels can be opened/closed
// individually so the video grid stays visible while a tutor works
// with a tool.
//
// The launch UI (Tools button + tool picker popover) lives in the
// meeting action bar (chat.component.html) and calls into this
// component via ViewChild → openTool(kind).
//
// Auto-open rules (student side):
//   - material$ fires → materials panel auto-opens (they need to
//     see the file the tutor just showed).
//   - vocab$ fires    → vocab panel auto-opens (same reasoning).
//   - whiteboard      → never auto-opens; student opens when they
//                       want to see it. Board sync keeps the panel
//                       up-to-date whether or not it's on screen.
// ═══════════════════════════════════════════════════════════════════

export type ClassToolPanelKind = 'whiteboard' | 'materials' | 'vocab';

@Component({
  selector: 'app-class-tool',
  templateUrl: './class-tool.component.html',
  styleUrls: ['./class-tool.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassToolComponent implements OnInit, AfterViewChecked, OnDestroy {
  @Input({ required: true }) isTutor!: boolean;

  // Per-panel visibility. Each panel opens/closes independently.
  showWhiteboard = false;
  showMaterials = false;
  showVocab = false;

  /** Tutor-controlled: is the student allowed to write on the board? */
  studentCanWrite = false;

  /** Materials panel mode. Tutor toggles between browsing their
   *  library and viewing whatever they've picked; student sees
   *  only "view" and only when a material is active. */
  materialsMode: 'browse' | 'view' = 'browse';

  /** Vocab panel mode. Same pattern as materialsMode. */
  vocabMode: 'manage' | 'practice' = 'manage';

  activeMaterial: ActiveMaterialPayload | null = null;
  activeMaterialSafeUrl: SafeResourceUrl | null = null;
  activeVocab: ActiveVocabPayload | null = null;

  @ViewChild('boardHost', { static: false }) boardHost?: ElementRef<HTMLDivElement>;

  private handle: ExcalidrawHandle | null = null;
  private subs: Subscription[] = [];
  private queuedScene: readonly unknown[] | null = null;
  private mountingBoard = false;

  boardMountPending = false;
  boardMountError = '';

  constructor(
    private sync: ClassToolSyncService,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.subs.push(
      this.sync.scene$.subscribe((payload) => {
        if (this.handle) this.handle.applyRemoteScene(payload.elements);
        else this.queuedScene = payload.elements;
        // Defensive auto-open on the student side: if a scene arrives
        // and the whiteboard panel isn't up (e.g. student joined
        // before the tutor toggled board:open), pop it now. Otherwise
        // the drawing would silently queue and stay invisible.
        if (!this.isTutor && !this.showWhiteboard) {
          this.showWhiteboard = true;
          this.cdr.markForCheck();
        }
      }),
      this.sync.boardOpen$.subscribe((isOpen) => {
        // Students mirror the tutor's whiteboard-panel state so
        // opening the board on the tutor side becomes visible on the
        // student side without a manual Tools-menu click. Tutor
        // ignores this (they're the source of truth).
        if (this.isTutor) return;
        this.showWhiteboard = isOpen;
        this.cdr.markForCheck();
      }),
      this.sync.permission$.subscribe((canWrite) => {
        this.studentCanWrite = canWrite;
        if (!this.isTutor) this.handle?.setReadOnly(!canWrite);
        this.cdr.markForCheck();
      }),
      this.sync.material$.subscribe((m) => {
        this.activeMaterial = m;
        // Prefer detailUrl (rich page from slocx-frontend) over the
        // raw asset URL — we iframe whichever is authoritative. When
        // detailUrl is absent (older broadcasters), fall back to the
        // raw url which the MIME switch renders as img/video/audio/pdf.
        const iframeSrc = m?.detailUrl || m?.url || '';
        this.activeMaterialSafeUrl = iframeSrc
          ? this.sanitizer.bypassSecurityTrustResourceUrl(iframeSrc)
          : null;
        if (m) {
          // Auto-open + switch panel to view mode so both sides see
          // the picked file without extra clicks.
          this.showMaterials = true;
          this.materialsMode = 'view';
        }
        this.cdr.markForCheck();
      }),
      this.sync.vocab$.subscribe((v) => {
        this.activeVocab = v;
        if (v) {
          this.showVocab = true;
          this.vocabMode = 'practice';
        }
        this.cdr.markForCheck();
      }),
    );
  }

  ngAfterViewChecked(): void {
    // Whiteboard mount runs only when its own panel is open (not any
    // panel). Excalidraw + React chunk stays deferred until the tutor
    // or student actually asks for the board.
    if (
      this.showWhiteboard &&
      this.boardHost &&
      !this.handle &&
      !this.mountingBoard &&
      !this.boardMountError
    ) {
      this.mountingBoard = true;
      this.boardMountPending = true;
      this.cdr.markForCheck();
      import('./excalidraw-mount')
        .then((mod) => {
          if (!this.boardHost || !this.showWhiteboard) {
            this.mountingBoard = false;
            this.boardMountPending = false;
            this.cdr.markForCheck();
            return;
          }
          this.handle = mod.mountExcalidraw(this.boardHost.nativeElement, {
            isTutor: this.isTutor,
          });
          this.handle.onLocalChange((elements) => {
            this.sync.broadcastScene({ elements });
          });
          if (this.queuedScene) {
            this.handle.applyRemoteScene(this.queuedScene);
            this.queuedScene = null;
          }
          if (!this.isTutor) this.handle.setReadOnly(!this.studentCanWrite);
          this.mountingBoard = false;
          this.boardMountPending = false;
          this.cdr.markForCheck();
        })
        .catch((err) => {
          console.error('[CLASS-TOOL] Excalidraw chunk failed to load:', err);
          this.mountingBoard = false;
          this.boardMountPending = false;
          this.boardMountError =
            'Whiteboard failed to load. Check your connection and try again.';
          this.cdr.markForCheck();
        });
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.handle?.destroy();
    this.handle = null;
  }

  // ── Panel open / close (called from the meeting action bar) ──

  openTool(kind: ClassToolPanelKind): void {
    if (kind === 'whiteboard') {
      this.showWhiteboard = true;
      // Tell the room the board is up so the student's panel mirrors.
      // Broadcast is server-gated on tutor role; no-op for students
      // (their opening of the board is local-only).
      if (this.isTutor) this.sync.broadcastBoardOpen();
    } else if (kind === 'materials') {
      // Only tutor can open materials cold. Student sees it only when
      // the tutor picks something (handled in material$ subscription).
      if (!this.isTutor) return;
      this.showMaterials = true;
      this.materialsMode = this.activeMaterial ? 'view' : 'browse';
    } else if (kind === 'vocab') {
      if (!this.isTutor) return;
      this.showVocab = true;
      this.vocabMode = this.activeVocab ? 'practice' : 'manage';
    }
    this.cdr.markForCheck();
  }

  closeWhiteboardPanel(): void {
    this.showWhiteboard = false;
    // Board tree stays mounted so the drawing survives across close/
    // reopen inside one lesson. destroy() only runs in ngOnDestroy.
    // Tutor's close is authoritative — the student's panel closes too
    // via board:close. Student close is local-only.
    if (this.isTutor) this.sync.broadcastBoardClose();
  }

  closeMaterialsPanel(): void {
    this.showMaterials = false;
  }

  closeVocabPanel(): void {
    this.showVocab = false;
  }

  // ── Whiteboard actions ──────────────────────────────────────

  toggleStudentWrite(): void {
    const next = !this.studentCanWrite;
    this.studentCanWrite = next;
    this.sync.broadcastPermission(next);
  }

  // ── Materials actions ───────────────────────────────────────

  materialsShowBrowse(): void {
    this.materialsMode = 'browse';
  }

  onPickMaterial(m: Material): void {
    // Compute the slocx-frontend content-detail URL so the viewer
    // can iframe the full rich page (title, description, quiz,
    // related content) instead of just the raw video/image asset.
    // `?embed=1` is a bypass hint the slocx-frontend AuthGuard can
    // honor to serve the page publicly — without that bypass the
    // guard will redirect embedded viewers to login (see notes in
    // the deploy summary).
    const detailUrl = `${environment.contentsBaseUrl}/materials/${m.id}?embed=1`;
    this.sync.broadcastOpenMaterial({
      id: m.id,
      url: m.url,
      title: m.title,
      detailUrl,
    });
    // Broadcast triggers material$ which flips mode to 'view'.
  }

  closeActiveMaterial(): void {
    this.sync.broadcastCloseMaterial();
    if (this.isTutor) this.materialsMode = 'browse';
  }

  materialKind(): 'detail' | 'image' | 'pdf' | 'video' | 'audio' | 'other' {
    // Detail-page URL wins when present — iframe the whole slocx-
    // frontend content page instead of just the raw asset.
    if (this.activeMaterial?.detailUrl) return 'detail';
    const url = this.activeMaterial?.url ?? '';
    const clean = url.split('?')[0].toLowerCase();
    if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(clean)) return 'image';
    if (/\.pdf$/.test(clean)) return 'pdf';
    if (/\.(mp4|webm|mov|mkv)$/.test(clean)) return 'video';
    if (/\.(mp3|wav|ogg|m4a)$/.test(clean)) return 'audio';
    return 'other';
  }

  // ── Vocab actions ───────────────────────────────────────────

  vocabShowManage(): void {
    this.vocabMode = 'manage';
  }

  onStartPractice(evt: { deck: VocabDeck; cards: VocabCard[] }): void {
    const payload: ActiveVocabPayload = {
      deckId: evt.deck.id,
      deckTitle: evt.deck.title,
      cards: evt.cards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        example: c.example,
        note: c.note,
      })),
      index: 0,
      revealed: false,
    };
    // Apply locally FIRST so the tutor's UI advances instantly to
    // the practice card. Then broadcast for the student. Waiting on
    // the server echo (previous behavior) kept the tutor pinned to
    // the deck list whenever the tutor-role check on the signaling
    // server dropped the event.
    this.applyVocabLocally(payload);
    this.sync.broadcastVocab(payload);
  }

  vocabPrev(): void {
    if (!this.activeVocab) return;
    if (this.activeVocab.index <= 0) return;
    const next: ActiveVocabPayload = {
      ...this.activeVocab,
      index: this.activeVocab.index - 1,
      revealed: false,
    };
    this.applyVocabLocally(next);
    this.sync.broadcastVocab(next);
  }

  vocabNext(): void {
    if (!this.activeVocab) return;
    if (this.activeVocab.index >= this.activeVocab.cards.length - 1) return;
    const next: ActiveVocabPayload = {
      ...this.activeVocab,
      index: this.activeVocab.index + 1,
      revealed: false,
    };
    this.applyVocabLocally(next);
    this.sync.broadcastVocab(next);
  }

  vocabToggleReveal(): void {
    if (!this.activeVocab) return;
    const next: ActiveVocabPayload = {
      ...this.activeVocab,
      revealed: !this.activeVocab.revealed,
    };
    this.applyVocabLocally(next);
    this.sync.broadcastVocab(next);
  }

  closeActiveVocab(): void {
    // Same optimistic pattern — clear our own state up front, then
    // broadcast the close to the room.
    this.activeVocab = null;
    if (this.isTutor) this.vocabMode = 'manage';
    this.cdr.markForCheck();
    this.sync.broadcastCloseVocab();
  }

  /** Local apply of a vocab snapshot. Mirrors what the vocab$
   *  subscription would do on socket echo — but runs synchronously
   *  so the tutor's UI never lags behind their own click. */
  private applyVocabLocally(v: ActiveVocabPayload): void {
    this.activeVocab = v;
    this.showVocab = true;
    this.vocabMode = 'practice';
    this.cdr.markForCheck();
  }

  /** True whenever any tool panel is open. Chat.component reads this
   *  via ViewChild to trigger the "presenting" meeting layout where
   *  video tiles collapse into a right sidebar. Also drives our own
   *  :host.ct-presenting styles that enlarge the panels. */
  @HostBinding('class.ct-presenting') get anyToolOpen(): boolean {
    return this.showWhiteboard || this.showMaterials || this.showVocab;
  }

  get currentVocabCard() {
    if (!this.activeVocab || this.activeVocab.cards.length === 0) return null;
    return this.activeVocab.cards[this.activeVocab.index] ?? null;
  }
}
