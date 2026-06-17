import { Component } from '@angular/core';

@Component({
  selector: 'app-landing',
  templateUrl: './landing.component.html',
  styleUrls: ['./landing.component.css'],
})
export class LandingComponent {
  /** Year shown in the footer. Computed once on construction. */
  year: number = new Date().getFullYear();

  /** Main Slocx marketing site. Kept here so it's easy to swap if the
   *  domain ever changes — every CTA on this landing routes here. */
  readonly slocxUrl: string = 'https://slocx.com';

  /** Allows pasting a meeting URL or a bare meeting/room id. We extract
   *  whatever looks like a uuid and navigate the same tab to the meeting
   *  page with that as `?room=`. Anything else surfaces a small error. */
  joinInput: string = '';
  joinError: string = '';

  goToSlocx(): void {
    window.location.href = this.slocxUrl;
  }

  joinFromInput(): void {
    this.joinError = '';
    const raw = this.joinInput.trim();
    if (!raw) {
      this.joinError = 'Paste a meeting link or ID.';
      return;
    }
    // Pull a uuid out of the input. Handles bare uuids and full URLs.
    const uuidRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
    const match = raw.match(uuidRe);
    if (!match) {
      this.joinError = "That doesn't look like a Slocx meeting link.";
      return;
    }
    // If the user pasted the full meeting URL, just navigate to it. The
    // public/kind params travel with it. Otherwise we synthesize the
    // simplest possible URL — meeting page handles the rest.
    if (raw.startsWith('http')) {
      window.location.href = raw;
    } else {
      window.location.href = `${window.location.origin}/?room=${match[0]}&public=1`;
    }
  }

  onJoinKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.joinFromInput();
    }
  }
}
