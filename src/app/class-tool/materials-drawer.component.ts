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
import { MaterialsService, Material } from './materials.service';

// ═══════════════════════════════════════════════════════════════════
// MaterialsDrawerComponent
//
// Tutor-only slide-in drawer inside the class-tool overlay. Lists the
// tutor's own materials paginated + searchable; clicking one emits
// (pick) so the class-tool can broadcast it via socket.
//
// Search input is debounced 300ms so typing doesn't hammer the API.
// Pagination shows Prev / Page N of M / Next — enough for MVP; a
// numeric jumper would be nice-to-have.
//
// The drawer owns its own list + pagination state. When the parent
// closes+reopens the drawer, state persists (component isn't
// destroyed — it's hidden via *ngIf on a wrapper OR toggled via a
// CSS class; here we let the parent decide via [open]).
// ═══════════════════════════════════════════════════════════════════

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-materials-drawer',
  templateUrl: './materials-drawer.component.html',
  styleUrls: ['./materials-drawer.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaterialsDrawerComponent implements OnChanges {
  /** Whether the drawer is currently visible. Parent toggles this. */
  @Input() open = false;
  /** ID of the material currently open in the viewer, if any. Used to
   *  highlight the active row in the list. */
  @Input() activeMaterialId: string | null = null;

  /** User picked a material — parent broadcasts it via socket. */
  @Output() pick = new EventEmitter<Material>();
  /** User clicked the drawer's close X. */
  @Output() close = new EventEmitter<void>();

  items: Material[] = [];
  total = 0;
  page = 1;
  loading = false;

  searchDraft = '';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private materials: MaterialsService,
    private cdr: ChangeDetectorRef,
  ) {}

  /** Getter (not a cached field) so a token that arrives via a
   *  classroom login AFTER this component was constructed still
   *  flips the drawer out of its "unavailable" state on next open. */
  get hasAuth(): boolean {
    return this.materials.hasAuth;
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Load on first open. Subsequent opens reuse the cached page — the
    // tutor probably wants to see the same list, and a fresh fetch on
    // every open would rubber-band the scroll position.
    if (changes['open'] && this.open && this.items.length === 0 && this.hasAuth && !this.loading) {
      this.fetchPage();
    }
  }

  onSearchInput(v: string): void {
    this.searchDraft = v;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.fetchPage();
    }, SEARCH_DEBOUNCE_MS);
  }

  onClear(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchDraft = '';
    this.page = 1;
    this.fetchPage();
  }

  onPrev(): void {
    if (this.page > 1) {
      this.page--;
      this.fetchPage();
    }
  }

  onNext(): void {
    if (this.page < this.totalPages) {
      this.page++;
      this.fetchPage();
    }
  }

  onPick(m: Material): void {
    this.pick.emit(m);
  }

  onClose(): void {
    this.close.emit();
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.total / PAGE_SIZE));
  }

  /** Angular *ngFor trackBy — avoids re-rendering every row on page
   *  swap. Keyed by id since rows are stable across pages. */
  trackById(_index: number, m: Material): string {
    return m.id;
  }

  /** Best-effort file-type badge for the row. Just a visual hint —
   *  the viewer does its own MIME switch when the material opens. */
  extBadge(url: string): string {
    const clean = (url || '').split('?')[0].toLowerCase();
    const m = clean.match(/\.([a-z0-9]{2,5})$/);
    if (!m) return 'FILE';
    const ext = m[1];
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'IMG';
    if (['pdf'].includes(ext)) return 'PDF';
    if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'VID';
    if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'AUD';
    return ext.toUpperCase().slice(0, 4);
  }

  private async fetchPage(): Promise<void> {
    this.loading = true;
    this.cdr.markForCheck();
    try {
      const res = await this.materials.list(this.page, PAGE_SIZE, this.searchDraft);
      this.items = res.data ?? [];
      this.total = res.total ?? 0;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }
}
