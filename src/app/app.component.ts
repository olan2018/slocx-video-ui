import { Component } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent {
  title = 'slocx-video-cha';

  /** True when the URL carries a `room` query param — we render the
   *  meeting UI. Otherwise we render the marketing landing page so a
   *  bare meet.slocx.com hit doesn't auto-prompt for camera/mic and
   *  doesn't drop a confused first-time visitor into a black void. */
  inMeeting: boolean;

  constructor(private router: Router) {
    this.inMeeting = this.detectMeeting();
  }

  /** Detect whether this page load is a meeting (room param present)
   *  or a landing visit. Cached at construction since the URL doesn't
   *  change underneath us — any navigation either reloads the page
   *  (window.location.href assignment) or stays within the meeting. */
  private detectMeeting(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      return !!params.get('room');
    } catch {
      return false;
    }
  }

  closeTab(): void {
    window.self.close();
  }
}
