import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { VocabService, VocabDeck, VocabCard } from './vocab.service';

// ═══════════════════════════════════════════════════════════════════
// VocabDrawerComponent
//
// Tutor-only slide-in drawer for managing vocab decks and starting
// practice sessions. Three screens rendered inside one drawer:
//
//   1. LIST — paginated + searchable decks; per-row "Practice" and
//      "Edit" actions plus a top-of-drawer "New deck" button.
//   2. EDIT — cards inside a deck; add new card via inline form;
//      delete individual cards. "Back" returns to list.
//   3. CREATE — new-deck form (title + description). "Save" returns
//      to list.
//
// Modes are exclusive: `mode` drives which screen renders. State is
// self-contained; parent just toggles `[open]` and receives:
//   (practice) → emit deck ID + cards so class-tool can broadcast
//   (close)    → drawer closes
// ═══════════════════════════════════════════════════════════════════

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

type Mode = 'list' | 'create' | 'edit';

@Component({
  selector: 'app-vocab-drawer',
  templateUrl: './vocab-drawer.component.html',
  styleUrls: ['./vocab-drawer.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VocabDrawerComponent implements OnChanges {
  @Input() open = false;
  /** Deck ID currently being practiced (from parent's vocab$ state).
   *  Used to highlight the row in the list view. */
  @Input() activeDeckId: string | null = null;

  /** Emit when the tutor clicks "Practice" on a deck. Payload is the
   *  deck + its cards so the class-tool component can build the
   *  ActiveVocabPayload snapshot and broadcast. */
  @Output() practice = new EventEmitter<{ deck: VocabDeck; cards: VocabCard[] }>();
  @Output() close = new EventEmitter<void>();

  mode: Mode = 'list';

  /** Getter (not a cached field) so a token from a post-construction
   *  classroom login flips the drawer out of the "unavailable" state
   *  on next open. */
  get hasAuth(): boolean {
    return this.vocab.hasAuth;
  }

  // List state
  decks: VocabDeck[] = [];
  totalDecks = 0;
  page = 1;
  loading = false;
  searchDraft = '';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Create form
  newDeckTitle = '';
  newDeckDescription = '';
  savingDeck = false;

  // Edit-deck screen
  editingDeck: VocabDeck | null = null;
  editingCards: VocabCard[] = [];
  loadingCards = false;
  newCardFront = '';
  newCardBack = '';
  newCardExample = '';
  newCardNote = '';
  savingCard = false;

  constructor(
    private vocab: VocabService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['open'] &&
      this.open &&
      this.decks.length === 0 &&
      this.hasAuth &&
      !this.loading
    ) {
      this.fetchDecks();
    }
  }

  // ── List screen ───────────────────────────────────────────────

  onSearchInput(v: string): void {
    this.searchDraft = v;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.fetchDecks();
    }, SEARCH_DEBOUNCE_MS);
  }

  onClearSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchDraft = '';
    this.page = 1;
    this.fetchDecks();
  }

  onPrev(): void {
    if (this.page > 1) { this.page--; this.fetchDecks(); }
  }
  onNext(): void {
    if (this.page < this.totalPages) { this.page++; this.fetchDecks(); }
  }

  onCreateDeckStart(): void {
    this.newDeckTitle = '';
    this.newDeckDescription = '';
    this.mode = 'create';
  }

  onEditDeck(deck: VocabDeck): void {
    this.editingDeck = deck;
    this.editingCards = [];
    this.mode = 'edit';
    this.loadCards(deck.id);
  }

  async onPracticeDeck(deck: VocabDeck): Promise<void> {
    // Cards must be fetched before emitting — the parent needs them
    // to build the socket payload (student has no backend access).
    const cards = await this.vocab.listCards(deck.id);
    if (cards.length === 0) {
      // Empty decks are useless in practice mode — flip to edit so the
      // tutor can add cards. No modal / toast; the mode switch is
      // self-explanatory.
      this.onEditDeck(deck);
      return;
    }
    this.practice.emit({ deck, cards });
  }

  async onDeleteDeck(deck: VocabDeck): Promise<void> {
    if (!window.confirm(`Delete deck "${deck.title}" and all its cards?`)) return;
    const ok = await this.vocab.deleteDeck(deck.id);
    if (ok) {
      this.decks = this.decks.filter((d) => d.id !== deck.id);
      this.totalDecks = Math.max(0, this.totalDecks - 1);
      this.cdr.markForCheck();
    }
  }

  // ── Create screen ─────────────────────────────────────────────

  async onSubmitCreateDeck(): Promise<void> {
    const title = this.newDeckTitle.trim();
    if (!title || this.savingDeck) return;
    this.savingDeck = true;
    try {
      const created = await this.vocab.createDeck(title, this.newDeckDescription.trim());
      if (created) {
        // Prepend to the list so the tutor sees it immediately.
        this.decks = [created, ...this.decks];
        this.totalDecks++;
        this.mode = 'list';
      }
    } finally {
      this.savingDeck = false;
      this.cdr.markForCheck();
    }
  }

  onCancelCreateDeck(): void {
    this.mode = 'list';
  }

  // ── Edit screen ───────────────────────────────────────────────

  private async loadCards(deckId: string): Promise<void> {
    this.loadingCards = true;
    this.cdr.markForCheck();
    try {
      this.editingCards = await this.vocab.listCards(deckId);
    } finally {
      this.loadingCards = false;
      this.cdr.markForCheck();
    }
  }

  async onSubmitAddCard(): Promise<void> {
    if (!this.editingDeck) return;
    const front = this.newCardFront.trim();
    const back = this.newCardBack.trim();
    if (!front || !back || this.savingCard) return;
    this.savingCard = true;
    try {
      // Position = next after current highest so cards keep insertion
      // order. Ties on 0 still fall back to created_at in SQL.
      const position = this.editingCards.reduce((m, c) => Math.max(m, c.position), 0) + 1;
      const created = await this.vocab.createCard(
        this.editingDeck.id,
        front, back,
        this.newCardExample.trim(),
        this.newCardNote.trim(),
        position,
      );
      if (created) {
        this.editingCards = [...this.editingCards, created];
        this.newCardFront = '';
        this.newCardBack = '';
        this.newCardExample = '';
        this.newCardNote = '';
      }
    } finally {
      this.savingCard = false;
      this.cdr.markForCheck();
    }
  }

  async onDeleteCard(card: VocabCard): Promise<void> {
    if (!window.confirm(`Delete card "${card.front}"?`)) return;
    const ok = await this.vocab.deleteCard(card.id);
    if (ok) {
      this.editingCards = this.editingCards.filter((c) => c.id !== card.id);
      this.cdr.markForCheck();
    }
  }

  onBackToList(): void {
    this.editingDeck = null;
    this.editingCards = [];
    this.mode = 'list';
  }

  onCloseDrawer(): void {
    this.close.emit();
  }

  // ── Computed helpers ──────────────────────────────────────────

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalDecks / PAGE_SIZE));
  }

  trackById(_i: number, x: { id: string }): string {
    return x.id;
  }

  private async fetchDecks(): Promise<void> {
    this.loading = true;
    this.cdr.markForCheck();
    try {
      const res = await this.vocab.listDecks(this.page, PAGE_SIZE, this.searchDraft);
      this.decks = res.data ?? [];
      this.totalDecks = res.total ?? 0;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }
}
