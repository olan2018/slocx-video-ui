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

  /** True once the whiteboard panel has been opened for the first
   *  time. From then on the panel stays in the DOM and we hide it
   *  via CSS instead of *ngIf so Excalidraw's React root doesn't get
   *  orphaned when the div is destroyed and re-created on toggle.
   *  Toolbar / drawing state survives close/reopen this way. */
  whiteboardMounted = false;

  /** Tutor-controlled: is the student allowed to write on the board? */
  studentCanWrite = false;

  // ── Per-tool Share state (tutor side) ─────────────────────────
  //
  // Default OFF so the tutor works privately until they explicitly
  // click Share. All broadcasts on the tutor side are gated on these
  // flags — students see nothing until Share is on. Toggling ON
  // pushes the CURRENT state (scene, active material, active vocab)
  // so the student catches up to where the tutor already is.
  // Ignored on the student side (they have nothing to share).
  isSharedWhiteboard = false;
  isSharedMaterials = false;
  isSharedVocab = false;

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
        if (this.handle) {
          this.handle.applyRemoteScene(payload.elements);
          // Belt-and-braces: the tutor should always be writable
          // regardless of what a remote scene or a state race
          // temporarily flipped. Re-affirm on every scene arrival.
          if (this.isTutor) this.handle.setReadOnly(false);
        } else {
          this.queuedScene = payload.elements;
        }
        // Defensive auto-open on the student side.
        if (!this.isTutor && !this.showWhiteboard) {
          this.showWhiteboard = true;
          this.whiteboardMounted = true;
          this.cdr.markForCheck();
        }
      }),
      this.sync.boardOpen$.subscribe((isOpen) => {
        if (this.isTutor) return;
        this.showWhiteboard = isOpen;
        if (isOpen) this.whiteboardMounted = true;
        this.cdr.markForCheck();
      }),
      this.sync.permission$.subscribe((canWrite) => {
        this.studentCanWrite = canWrite;
        if (!this.isTutor) this.handle?.setReadOnly(!canWrite);
        this.cdr.markForCheck();
      }),
      this.sync.material$.subscribe((m) => {
        this.activeMaterial = m;
        // Sanitize the raw asset URL — used by the PDF iframe path.
        // detailUrl stays in the payload but isn't rendered until
        // slocx-frontend supports iframe embedding (see materialKind
        // notes).
        const iframeSrc = m?.url || '';
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
            // Broadcast only when the tutor has explicitly turned
            // Share ON. Otherwise the tutor is sketching privately
            // and the student sees nothing.
            if (this.isSharedWhiteboard) {
              this.sync.broadcastScene({ elements });
            }
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
      this.whiteboardMounted = true;
      // No auto-broadcast. Opening is a LOCAL action for the tutor —
      // the student sees the whiteboard only after the tutor clicks
      // the Share button in the panel header.
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
    // If the tutor closes the panel while sharing, close the
    // student's panel too and clear the shared flag. Silent close
    // when not sharing.
    if (this.isTutor && this.isSharedWhiteboard) {
      this.sync.broadcastBoardClose();
      this.isSharedWhiteboard = false;
    }
  }

  closeMaterialsPanel(): void {
    this.showMaterials = false;
    // Closing the panel while sharing also closes the student's
    // viewer. Consistent with whiteboard behavior.
    if (this.isTutor && this.isSharedMaterials) {
      this.sync.broadcastCloseMaterial();
      this.isSharedMaterials = false;
    }
  }

  closeVocabPanel(): void {
    this.showVocab = false;
    if (this.isTutor && this.isSharedVocab) {
      this.sync.broadcastCloseVocab();
      this.isSharedVocab = false;
    }
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
    const detailUrl = `${environment.contentsBaseUrl}/materials/${m.id}?embed=1`;
    const payload: ActiveMaterialPayload = {
      id: m.id,
      url: m.url,
      title: m.title,
      detailUrl,
    };
    // Always apply locally so the tutor sees the material.
    this.applyMaterialLocally(payload);
    // Only broadcast if Share is on.
    if (this.isSharedMaterials) {
      this.sync.broadcastOpenMaterial(payload);
    }
  }

  closeActiveMaterial(): void {
    this.activeMaterial = null;
    this.activeMaterialSafeUrl = null;
    if (this.isTutor) this.materialsMode = 'browse';
    this.cdr.markForCheck();
    // Only propagate close to the student if we were sharing.
    if (this.isSharedMaterials) {
      this.sync.broadcastCloseMaterial();
    }
  }

  /** Local apply of a material snapshot. Mirrors what the material$
   *  subscription would do on socket echo — but runs synchronously so
   *  the tutor's UI never lags behind their own click. */
  private applyMaterialLocally(m: ActiveMaterialPayload): void {
    this.activeMaterial = m;
    // See material$ subscription — raw url only for now; detailUrl
    // is data-only until slocx-frontend allows iframe embedding.
    const iframeSrc = m.url || '';
    this.activeMaterialSafeUrl = iframeSrc
      ? this.sanitizer.bypassSecurityTrustResourceUrl(iframeSrc)
      : null;
    this.showMaterials = true;
    this.materialsMode = 'view';
    this.cdr.markForCheck();
  }

  materialKind(): 'detail' | 'image' | 'pdf' | 'video' | 'audio' | 'other' {
    // NOTE on 'detail': the slocx-frontend content page cannot be
    // iframed today because AuthGuard redirects embedded viewers to
    // login and login itself blocks framing — the iframe just goes
    // blank. Until slocx-frontend adds a `?embed=1` bypass to
    // AuthGuard, we prefer the raw asset URL and render it inline
    // (image/video/pdf/audio). detailUrl stays in the payload so a
    // future flip-of-a-switch re-enables the iframe path without
    // touching this file.
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
    if (this.isSharedVocab) this.sync.broadcastVocab(payload);
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
    if (this.isSharedVocab) this.sync.broadcastVocab(next);
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
    if (this.isSharedVocab) this.sync.broadcastVocab(next);
  }

  vocabToggleReveal(): void {
    if (!this.activeVocab) return;
    const next: ActiveVocabPayload = {
      ...this.activeVocab,
      revealed: !this.activeVocab.revealed,
    };
    this.applyVocabLocally(next);
    if (this.isSharedVocab) this.sync.broadcastVocab(next);
  }

  closeActiveVocab(): void {
    this.activeVocab = null;
    if (this.isTutor) this.vocabMode = 'manage';
    this.cdr.markForCheck();
    if (this.isSharedVocab) this.sync.broadcastCloseVocab();
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

  // ── Share toggles ────────────────────────────────────────────
  //
  // Turning Share ON: broadcast "open" + push the current state so
  // the student catches up. Turning OFF: broadcast "close" so the
  // student's panel dismisses. All future actions in the tool
  // broadcast only while the corresponding isShared* is true.

  toggleShareWhiteboard(): void {
    this.isSharedWhiteboard = !this.isSharedWhiteboard;
    if (this.isSharedWhiteboard) {
      this.sync.broadcastBoardOpen();
      // Push whatever the tutor already drew privately.
      const elements = this.handle?.getSceneElements() ?? [];
      if (elements.length > 0) {
        this.sync.broadcastScene({ elements });
      }
      // Ensure we stay writable — belt-and-braces after any state race.
      this.handle?.setReadOnly(false);
    } else {
      this.sync.broadcastBoardClose();
    }
    this.cdr.markForCheck();
  }

  toggleShareMaterials(): void {
    this.isSharedMaterials = !this.isSharedMaterials;
    if (this.isSharedMaterials && this.activeMaterial) {
      this.sync.broadcastOpenMaterial(this.activeMaterial);
    } else if (!this.isSharedMaterials) {
      this.sync.broadcastCloseMaterial();
    }
    this.cdr.markForCheck();
  }

  toggleShareVocab(): void {
    this.isSharedVocab = !this.isSharedVocab;
    if (this.isSharedVocab && this.activeVocab) {
      this.sync.broadcastVocab(this.activeVocab);
    } else if (!this.isSharedVocab) {
      this.sync.broadcastCloseVocab();
    }
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
