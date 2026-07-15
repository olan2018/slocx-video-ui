import {
  Component,
  ElementRef,
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
import { mountExcalidraw, ExcalidrawHandle } from './excalidraw-mount';
import {
  ClassToolSyncService,
  ActiveMaterialPayload,
  ActiveVocabPayload,
} from './class-tool-sync.service';
import { Material } from './materials.service';
import { VocabDeck, VocabCard } from './vocab.service';

// ═══════════════════════════════════════════════════════════════════
// ClassToolComponent — Phase 3 (whiteboard + materials)
//
// Overlay contains three logical layers:
//   1. Whiteboard (Excalidraw) — always mounted once the panel opens.
//   2. Material viewer — full-cover overlay when tutor picks a
//      material; whiteboard stays alive behind it, so closing the
//      material reveals the same drawing.
//   3. Materials drawer — tutor-only side panel for browsing +
//      picking. Broadcasts `material:open` on pick.
//
// State is server-authoritative via ClassToolSyncService: every
// permission / material change flows through a socket round-trip so
// tutor + student converge on the same view.
// ═══════════════════════════════════════════════════════════════════

@Component({
  selector: 'app-class-tool',
  templateUrl: './class-tool.component.html',
  styleUrls: ['./class-tool.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassToolComponent implements OnInit, AfterViewChecked, OnDestroy {
  @Input({ required: true }) isTutor!: boolean;

  open = false;

  /** Server-authoritative student write permission. Only the tutor
   *  can flip it; both roles observe the resulting broadcast. */
  studentCanWrite = false;

  /** Whether the materials drawer (tutor-only browser) is showing. */
  materialsOpen = false;
  /** Whether the vocab drawer (tutor-only browser) is showing. */
  vocabOpen = false;

  /** Currently-shown material, or null if the viewer is dismissed.
   *  Both tutor and student subscribe to sync.material$ so they
   *  converge on the same value. */
  activeMaterial: ActiveMaterialPayload | null = null;

  /** Currently-active vocab practice snapshot (or null). Same shared
   *  subscription pattern as activeMaterial. */
  activeVocab: ActiveVocabPayload | null = null;

  @ViewChild('boardHost', { static: false }) boardHost?: ElementRef<HTMLDivElement>;

  private handle: ExcalidrawHandle | null = null;
  private subs: Subscription[] = [];
  private queuedScene: readonly unknown[] | null = null;

  /** Sanitized `SafeResourceUrl` for the PDF iframe. Angular's default
   *  sanitizer strips iframe src to prevent XSS; because we trust the
   *  URLs (tutor picked from their own material library — auth-scoped
   *  by JWT on the backend), we bypass explicitly. Recomputed only
   *  when activeMaterial changes so we don't rebuild on every CD tick. */
  activeMaterialSafeUrl: SafeResourceUrl | null = null;

  constructor(
    private sync: ClassToolSyncService,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // Subscribe immediately (before panel opens) so we don't miss the
    // server's join-time replay of the cached scene / permission /
    // material.
    this.subs.push(
      this.sync.scene$.subscribe((payload) => {
        if (this.handle) this.handle.applyRemoteScene(payload.elements);
        else this.queuedScene = payload.elements;
      }),
      this.sync.permission$.subscribe((canWrite) => {
        this.studentCanWrite = canWrite;
        if (!this.isTutor) this.handle?.setReadOnly(!canWrite);
        this.cdr.markForCheck();
      }),
      this.sync.material$.subscribe((m) => {
        this.activeMaterial = m;
        this.activeMaterialSafeUrl = m
          ? this.sanitizer.bypassSecurityTrustResourceUrl(m.url)
          : null;
        // When the tutor picks a material, auto-open the class tool on
        // the STUDENT side too so they don't miss it. Tutor-side
        // auto-open is redundant (they clicked pick) but harmless.
        if (m) this.open = true;
        this.cdr.markForCheck();
      }),
      this.sync.vocab$.subscribe((v) => {
        this.activeVocab = v;
        // Same auto-open behavior as material — student can't miss
        // the practice session starting.
        if (v) this.open = true;
        this.cdr.markForCheck();
      }),
    );
  }

  ngAfterViewChecked(): void {
    if (this.open && this.boardHost && !this.handle) {
      this.handle = mountExcalidraw(this.boardHost.nativeElement, {
        isTutor: this.isTutor,
      });
      this.handle.onLocalChange((elements) => {
        this.sync.broadcastScene({ elements });
      });
      if (this.queuedScene) {
        this.handle.applyRemoteScene(this.queuedScene);
        this.queuedScene = null;
      }
      // Apply the server-authoritative permission the moment the
      // board is live — subscription may have fired before mount.
      if (!this.isTutor) this.handle.setReadOnly(!this.studentCanWrite);
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.handle?.destroy();
    this.handle = null;
  }

  openPanel(): void {
    this.open = true;
  }

  closePanel(): void {
    this.open = false;
    // Also close both drawers so they don't reopen on next open.
    // Board + activeMaterial + activeVocab persist so the class picks
    // up where it left off.
    this.materialsOpen = false;
    this.vocabOpen = false;
  }

  toggleStudentWrite(): void {
    const next = !this.studentCanWrite;
    this.studentCanWrite = next;
    this.sync.broadcastPermission(next);
  }

  openMaterialsDrawer(): void {
    this.materialsOpen = true;
  }

  closeMaterialsDrawer(): void {
    this.materialsOpen = false;
  }

  onPickMaterial(m: Material): void {
    // Broadcast to the room — server relays back including to us, so
    // sync.material$ fires and updates activeMaterial.
    this.sync.broadcastOpenMaterial({ id: m.id, url: m.url, title: m.title });
    this.materialsOpen = false;
  }

  closeActiveMaterial(): void {
    // Tutor-only in the template — button is hidden for students.
    this.sync.broadcastCloseMaterial();
  }

  // ── Vocab actions ─────────────────────────────────────────────

  openVocabDrawer(): void {
    this.vocabOpen = true;
  }

  closeVocabDrawer(): void {
    this.vocabOpen = false;
  }

  /** Drawer emitted (practice) — build the shared snapshot and
   *  broadcast. Server relays back including to us, so activeVocab
   *  updates via the vocab$ subscription. */
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
    this.sync.broadcastVocab(payload);
    this.vocabOpen = false;
  }

  /** Tutor-only navigation. Each button re-broadcasts a modified
   *  snapshot so both sides converge on the same card + reveal state. */
  vocabPrev(): void {
    if (!this.activeVocab) return;
    if (this.activeVocab.index <= 0) return;
    this.sync.broadcastVocab({
      ...this.activeVocab,
      index: this.activeVocab.index - 1,
      revealed: false,
    });
  }

  vocabNext(): void {
    if (!this.activeVocab) return;
    if (this.activeVocab.index >= this.activeVocab.cards.length - 1) return;
    this.sync.broadcastVocab({
      ...this.activeVocab,
      index: this.activeVocab.index + 1,
      revealed: false,
    });
  }

  vocabToggleReveal(): void {
    if (!this.activeVocab) return;
    this.sync.broadcastVocab({
      ...this.activeVocab,
      revealed: !this.activeVocab.revealed,
    });
  }

  closeActiveVocab(): void {
    this.sync.broadcastCloseVocab();
  }

  get currentVocabCard() {
    if (!this.activeVocab || this.activeVocab.cards.length === 0) return null;
    return this.activeVocab.cards[this.activeVocab.index] ?? null;
  }

  // ── Material viewer MIME picker ─────────────────────────────────
  // Cheap URL-suffix sniffing. Good enough for the four types we can
  // render inline; everything else falls through to a "Open in new
  // tab" link.

  materialKind(): 'image' | 'pdf' | 'video' | 'audio' | 'other' {
    const url = this.activeMaterial?.url ?? '';
    const clean = url.split('?')[0].toLowerCase();
    if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(clean)) return 'image';
    if (/\.pdf$/.test(clean)) return 'pdf';
    if (/\.(mp4|webm|mov|mkv)$/.test(clean)) return 'video';
    if (/\.(mp3|wav|ogg|m4a)$/.test(clean)) return 'audio';
    return 'other';
  }
}
