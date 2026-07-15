import {
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  AfterViewInit,
} from '@angular/core';

// ═══════════════════════════════════════════════════════════════════
// DraggableDirective
//
// Turns any positioned element into a click-and-drag movable window.
// The handle (usually the panel header) is passed via
// [appDraggable]="'.ct-panel__header'". Anything else — the body, the
// canvas, whatever — passes clicks through untouched.
//
// Interactive children of the handle (buttons, inputs, links) are
// filtered out via a closest() check so their clicks still work —
// otherwise the close X and the "Student can write" toggle inside
// the whiteboard header would become drag triggers.
//
// Position is clamped to the viewport so a user can't accidentally
// drag a panel off-screen with no way back. First drag flips the
// element from bottom/right anchoring to top/left so subsequent
// pointer math stays consistent regardless of the original CSS.
// ═══════════════════════════════════════════════════════════════════

@Directive({ selector: '[appDraggable]' })
export class DraggableDirective implements AfterViewInit, OnDestroy {
  /** CSS selector for the drag handle inside the host element. Empty
   *  = the whole host is the handle. */
  @Input('appDraggable') handleSelector: string = '';

  private handle: HTMLElement | null = null;
  private dragging = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startElX = 0;
  private startElY = 0;

  constructor(private host: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    const el = this.host.nativeElement;
    this.handle = this.handleSelector
      ? (el.querySelector(this.handleSelector) as HTMLElement | null)
      : el;
    if (!this.handle) return;
    this.handle.style.cursor = 'move';
    this.handle.style.touchAction = 'none';
    this.handle.addEventListener('pointerdown', this.onPointerDown);
  }

  ngOnDestroy(): void {
    this.handle?.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Skip when the pointer lands on an interactive child of the
    // header — those own their click semantics. Without this check,
    // dragging the header would swallow every close/toggle click.
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, label')) return;

    const el = this.host.nativeElement;
    const rect = el.getBoundingClientRect();
    this.startElX = rect.left;
    this.startElY = rect.top;
    this.startPointerX = e.clientX;
    this.startPointerY = e.clientY;

    // Convert to top/left anchoring on first drag so bottom/right
    // CSS defaults don't fight our positioning math.
    el.style.top = `${rect.top}px`;
    el.style.left = `${rect.left}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';

    this.dragging = true;
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);

    // Prevent text selection on the header while dragging.
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const el = this.host.nativeElement;
    const dx = e.clientX - this.startPointerX;
    const dy = e.clientY - this.startPointerY;
    // Clamp so the panel can't be dragged off-screen. Use offsetWidth/
    // Height (post-layout) rather than the cached rect so this stays
    // correct if the panel resized between pointerdown and move.
    const maxX = window.innerWidth - el.offsetWidth;
    const maxY = window.innerHeight - el.offsetHeight;
    const nextX = Math.max(0, Math.min(maxX, this.startElX + dx));
    const nextY = Math.max(0, Math.min(maxY, this.startElY + dy));
    el.style.left = `${nextX}px`;
    el.style.top = `${nextY}px`;
  };

  private onPointerUp = (): void => {
    this.dragging = false;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  };
}
