import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import Peer, { MediaConnection } from 'peerjs';
import { io } from 'socket.io-client';
import * as Qs from 'qs';
import { environment } from '../../environments/environment';

export interface ChatMessage {
  displayName: string;
  avatarUrl: string;
  text: string;
  timestamp: number;
  self: boolean;
}

export interface QuizOption {
  id: string;
  option_text: string;
}

export interface QuizQuestion {
  id: string;
  question_type: string;
  content: string;
  correct_answer: string;
  sort_order: number;
  options: QuizOption[];
}

export interface LiveQuizData {
  id: string;
  title: string;
  description: string;
  questions: QuizQuestion[];
}

export interface QuizAnswerDetail {
  questionId: string;
  questionText: string;
  questionType: string;
  selectedAnswer: string;
  selectedAnswerText: string;
  correctAnswerText: string;
  isCorrect: boolean;
}

export interface QuizStudentResult {
  userId: string;
  displayName: string;
  score: number;
  total: number;
  answers: QuizAnswerDetail[];
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('videos') videoGrid!: ElementRef;
  @ViewChild('localVideo') localVideoEl!: ElementRef<HTMLVideoElement>;
  // Second local video element used as the "spotlight" tile when the user
  // pins themselves. Bound to the same MediaStream as `localVideoEl` so
  // mic/cam toggles propagate automatically. `{ static: false }` because
  // it's inside an *ngIf and only exists after pinnedPeerId === 'local'.
  @ViewChild('localSpotlightVideo') localSpotlightVideoEl?: ElementRef<HTMLVideoElement>;

  // State
  isMuted: boolean = false;
  isCameraOn: boolean = true;
  permissionError: boolean = false;

  // ── Permission gate (custom prompter) ────────────────────
  // The browser's own permission popup can't be skinned — that's a hard
  // security boundary. What we DO control is everything around it:
  //   - a friendly retry button that re-fires getUserMedia (works when
  //     the user dismissed once but hasn't permanently blocked)
  //   - browser-specific copy that walks them to the lock icon in the
  //     address bar when they HAVE permanently blocked
  //   - distinguish "no device" / "device in use" / "denied" so the
  //     copy matches the actual failure cause.
  permissionStatus: 'idle' | 'requesting' | 'granted' | 'denied' | 'no-device' | 'in-use' | 'unknown' = 'idle';
  /** True while a getUserMedia call is in flight — used to disable
   *  the retry button so users don't queue duplicate prompts. */
  permissionRequesting: boolean = false;
  /** True when the user joined audio-only — no video device on the
   *  machine, or the camera failed but the mic worked. Drives the
   *  camera-toggle being disabled and the initials avatar showing
   *  on the local tiles. */
  audioOnlyMode: boolean = false;

  /** Detected browser family for tailoring unblock instructions. */
  get permissionBrowser(): 'chrome' | 'edge' | 'firefox' | 'safari' | 'opera' | 'brave' | 'other' {
    if (typeof navigator === 'undefined') return 'other';
    const ua = navigator.userAgent || '';
    if (/Edg\//i.test(ua)) return 'edge';
    if (/OPR\//i.test(ua)) return 'opera';
    // Chrome's UA includes "Safari/" too — order matters.
    if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua) && !/OPR\//i.test(ua)) return 'chrome';
    if (/Firefox\//i.test(ua)) return 'firefox';
    if (/Safari\//i.test(ua)) return 'safari';
    return 'other';
  }
  connectionError: boolean = false;
  connectionErrorMsg: string = '';
  remoteCount: number = 0;
  currentTime: Date = new Date();

  // Theme
  isDarkMode: boolean = true;

  // Chat
  chatOpen: boolean = false;
  chatMessages: ChatMessage[] = [];
  chatInput: string = '';
  unreadMessages: number = 0;

  // Raise hand
  handRaised: boolean = false;
  raisedHands: Set<string> = new Set();

  // Tracks peerIds whose camera is currently OFF. Used to overlay an
  // initials avatar on top of the (otherwise black) remote video tile.
  cameraOffPeers: Set<string> = new Set();

  // Emoji reactions
  reactionsOpen: boolean = false;
  floatingReactions: { emoji: string; name: string; id: number }[] = [];
  private reactionIdCounter: number = 0;
  readonly reactionEmojis: string[] = [
    '👍', '👏', '😂', '❤️', '🔥', '🎉', '😮', '😢',
    '🤔', '💯', '🙌', '👀', '💪', '⭐', '🥳', '😍',
  ];

  // Audio prompt
  showAudioPrompt: boolean = false;

  // Screen sharing
  isScreenSharing: boolean = false;
  private screenStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;

  // ── Role ──────────────────────────────────────────────────
  isTutor: boolean = false;
  private lessonId: string = '';

  // ── Spotlight / pin ───────────────────────────────────────
  // Google-Meet-style local pinning. Click any tile (remote OR the local
  // PiP) to expand it as the main view; others shrink to a thumbnail
  // strip. Purely local — no signaling, every participant controls their
  // own view independently. `'local'` is the sentinel for the local user's
  // own stream; any other value is a remote peerId.
  pinnedPeerId: string | null = null;

  // ── Meeting brand kind ────────────────────────────────────
  // `'classroom'` (default) shows the original Classroom sub-label;
  // `'meeting'` shows a more official "Meet" sub-label and a slightly
  // different accent. Resolved from `?kind=` on the URL OR fetched via
  // GET /v1/meeting-links/:id/kind for public meeting links that
  // didn't bake the kind into the URL.
  meetingKind: 'classroom' | 'meeting' = 'classroom';

  get meetingKindLabel(): string {
    return this.meetingKind === 'meeting' ? 'Meet' : 'Classroom';
  }

  // ── Public meeting (name prompt) ──────────────────────────
  // Set when the URL carries `?public=1` AND no `name` was passed.
  // We pause the whole join flow on the name-entry screen until the
  // guest types a display name; submitting calls `joinPublicMeeting()`,
  // which finishes the deferred initialization with their chosen name.
  isPublicMeeting: boolean = false;
  awaitingNameEntry: boolean = false;
  guestNameInput: string = '';

  // ── Post-call rating ───────────────────────────────────────
  // `reviewTicket` is the HMAC-signed capability token the slocx-frontend
  // mints when the student clicks "Join class". It encodes (user_id,
  // tutor_id, lesson_id, exp) — backend verifies the signature on POST.
  // No JWT crosses tab boundaries. If the ticket is missing (legacy
  // link, mint failed, opened directly), the popup is suppressed.
  private reviewTicket: string = '';
  showRatingModal: boolean = false;
  ratingValue: number = 0;
  ratingHoverValue: number = 0;
  ratingComment: string = '';
  ratingSubmitting: boolean = false;
  ratingError: string = '';
  ratingDone: boolean = false;
  // ─────────────────────────────────────────────────────────

  // ── Live Quiz ─────────────────────────────────────────────
  /** Overlay visibility */
  quizActive: boolean = false;
  quizData: LiveQuizData | null = null;
  /** Current question index (0-based) */
  quizCurrentIndex: number = 0;
  /** Map of questionId → selected answer (option id or text) */
  quizAnswers: Map<string, string> = new Map();
  /** True once student has hit Submit */
  quizSubmitted: boolean = false;
  /** Timer: total seconds for this session */
  quizDurationSecs: number = 60;
  /** Remaining seconds shown to user */
  quizRemainingSecs: number = 60;
  private quizTimerInterval: any = null;

  /** Results after quiz ends */
  quizResults: QuizStudentResult[] = [];
  /** My own result */
  myQuizResult: QuizStudentResult | null = null;
  /** Map of questionId → isCorrect (from quiz:ended payload with correct answers revealed) */
  quizRevealedAnswers: Map<string, boolean> = new Map();
  quizCorrectOptions: Map<string, string> = new Map(); // questionId → correct option id / text
  showQuizResults: boolean = false;

  /** How many students have answered (live progress for tutor) */
  quizAnsweredCount: number = 0;
  quizStudentTotal: number = 0;
  /** Quiz duration selector visible to tutor */
  quizLaunchOpen: boolean = false;
  quizLaunchDuration: number = 60;
  quizErrorMsg: string = '';
  /** Index of student result expanded in tutor view (-1 = none) */
  tutorExpandedStudent: number = -1;
  // ─────────────────────────────────────────────────────────

  // ── Lesson timer ──────────────────────────────────────────
  /** Total lesson duration in seconds (from URL ?duration=N minutes, default 60 min) */
  lessonDurationSecs: number = 3600;
  /** Remaining seconds */
  timerRemainingSecs: number = 3600;
  /** True once the second participant joined and countdown began */
  timerStarted: boolean = false;

  readonly TIMER_RADIUS = 18;
  readonly TIMER_CIRCUMFERENCE = 2 * Math.PI * 18; // ≈ 113.1

  get timerProgress(): number {
    if (this.lessonDurationSecs === 0) return 1;
    return this.timerRemainingSecs / this.lessonDurationSecs;
  }

  get timerDashOffset(): number {
    return this.TIMER_CIRCUMFERENCE * (1 - this.timerProgress);
  }

  /** MM:SS label shown inside / next to the ring */
  get timerLabel(): string {
    const secs = Math.max(0, this.timerRemainingSecs);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** Ring turns red when ≤ 5 minutes remain */
  get timerUrgent(): boolean {
    return this.timerStarted && this.timerRemainingSecs <= 300;
  }
  // ─────────────────────────────────────────────────────────

  private myPeer!: Peer;
  private myPeerId: string = '';
  private localStream!: MediaStream;
  private peers: { [key: string]: MediaConnection } = {};
  private remoteVideos: HTMLVideoElement[] = [];
  private remoteAudios: Map<string, HTMLAudioElement> = new Map();
  private clockInterval!: any;
  private timerInterval!: any;
  private socket!: ReturnType<typeof io>;
  private myUsername: string = '';
  myDisplayName: string = 'Me';
  myAvatarUrl: string = '';
  private peerProfiles: Map<string, { name: string; avatar: string }> = new Map();

  constructor() {}

  ngOnInit(): void {
    // Load saved theme
    const savedTheme = localStorage.getItem('slocx-theme');
    this.isDarkMode = savedTheme !== 'light';

    // Clock tick
    this.clockInterval = setInterval(() => {
      this.currentTime = new Date();
    }, 1000);

    const parsed = Qs.parse(location.search, { ignoreQueryPrefix: true });
    const username = parsed['user'] as string;
    const room = parsed['room'] as string;
    const name = parsed['name'] as string;
    const photo = parsed['photo'] as string;
    const durationParam = parsed['duration'] as string;
    const roleParam = parsed['role'] as string;
    const publicFlag = parsed['public'] as string;

    this.isTutor = roleParam === 'tutor';
    this.lessonId = room; // room param is the lesson ID
    // Optional capability token — see `reviewTicket` field comment.
    this.reviewTicket = (parsed['ticket'] as string) || '';
    this.isPublicMeeting = publicFlag === '1';

    // Brand kind: URL wins if explicit, otherwise default to classroom
    // and fire a background fetch for public meeting links so the chrome
    // updates as soon as the backend responds.
    const kindParam = (parsed['kind'] as string || '').toLowerCase();
    if (kindParam === 'meeting' || kindParam === 'classroom') {
      this.meetingKind = kindParam as 'classroom' | 'meeting';
    } else if (this.isPublicMeeting && room) {
      fetch(`${environment.apiUrl}/v1/meeting-links/${room}/kind`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: any) => {
          const k = body?.data?.kind;
          if (k === 'meeting' || k === 'classroom') {
            this.meetingKind = k;
          }
        })
        .catch(() => {});
    }

    // Parse lesson duration
    const durationMins = parseInt(durationParam, 10);
    if (!isNaN(durationMins) && durationMins > 0) {
      this.lessonDurationSecs = durationMins * 60;
    }
    this.timerRemainingSecs = this.lessonDurationSecs;

    // Public meetings: if no `name` came in on the URL, gate the entire
    // join flow behind a name-entry screen. A random `user` id is still
    // assigned so each browser is uniquely identifiable to the signaling
    // server (otherwise duplicate-name collisions would kick the second
    // joiner via the existing `sameName` event).
    if (this.isPublicMeeting && !name) {
      this.myUsername = username || this.generateGuestId();
      this.awaitingNameEntry = true;
      return; // wait for submitGuestName() to call performJoin()
    }

    this.myUsername = username || (this.isPublicMeeting ? this.generateGuestId() : 'Me');
    this.myDisplayName = name || this.myUsername;
    this.myAvatarUrl = photo || '';

    this.performJoin();
  }

  /** Called when the guest submits the name-entry form on a public
   *  meeting URL (or directly from ngOnInit for the regular flow). Owns
   *  all the socket / peer / getUserMedia setup. */
  private performJoin(): void {
    const parsed = Qs.parse(location.search, { ignoreQueryPrefix: true });
    const username = this.myUsername;
    const room = parsed['room'] as string;

    this.socket = io(environment.socketUrl);

    this.socket.on('connect', () => {
      console.log('[SOCKET] connected');
    });
    this.socket.on('disconnect', (reason: string) => {
      console.warn('[SOCKET] disconnected:', reason);
    });
    this.socket.on('connect_error', (err: Error) => {
      console.error('[SOCKET] connect_error:', err.message);
    });

    this.socket.on('roomNotValid', () => {
      this.connectionError = true;
      this.connectionErrorMsg = 'This classroom link is invalid or the lesson has not started yet.';
    });

    this.socket.on('doNotBelongToClass', () => {
      this.connectionError = true;
      this.connectionErrorMsg = 'You are not a participant of this lesson.';
    });

    this.socket.on('sameName', () => {
      this.connectionError = true;
      this.connectionErrorMsg = 'You are already connected to this lesson from another window.';
    });

    this.socket.on('chat-message', (msg: { displayName: string; avatarUrl: string; text: string; timestamp: number }) => {
      this.chatMessages.push({ ...msg, self: false });
      this.playMessageSound();
      if (!this.chatOpen) {
        this.unreadMessages++;
      }
      setTimeout(() => this.scrollChatToBottom(), 0);
    });

    this.socket.on('user-raised-hand', (peerId: string) => {
      this.raisedHands.add(peerId);
      this.showHandIndicator(peerId, true);
      this.playHandSound();
    });
    this.socket.on('user-lowered-hand', (peerId: string) => {
      this.raisedHands.delete(peerId);
      this.showHandIndicator(peerId, false);
    });

    this.socket.on('user-reaction', (data: { displayName: string; emoji: string }) => {
      this.showFloatingReaction(data.emoji, data.displayName);
    });

    this.socket.on('user-started-screen-share', (peerId: string) => {
      document.getElementById('tile-' + peerId)?.classList.add('screen-sharing');
    });
    this.socket.on('user-stopped-screen-share', (peerId: string) => {
      document.getElementById('tile-' + peerId)?.classList.remove('screen-sharing');
    });

    // Camera state from a remote — show / hide the initials avatar
    // overlay on their tile. Mirrors the same DOM-imperative pattern
    // the hand-raise badge uses, since tiles are created outside Angular.
    this.socket.on('user-camera-state', (data: { peerId: string; on: boolean }) => {
      if (data.on) {
        this.cameraOffPeers.delete(data.peerId);
      } else {
        this.cameraOffPeers.add(data.peerId);
      }
      this.applyCameraOffOverlay(data.peerId, !data.on);
    });

    this.socket.on('user-disconnected', (userId: string) => {
      this.raisedHands.delete(userId);
      this.peerProfiles.delete(userId);
      if (this.peers[userId]) {
        this.peers[userId].close();
        delete this.peers[userId];
      }
      this.removeParticipant(userId);
    });

    // ── Quiz socket events ────────────────────────────────────────────────
    this.socket.on('quiz:started', (payload: { quiz: LiveQuizData; durationSecs: number }) => {
      this.startQuizOverlay(payload.quiz, payload.durationSecs);
    });

    this.socket.on('quiz:progress', (payload: { answered: number; total: number }) => {
      this.quizAnsweredCount = payload.answered;
      this.quizStudentTotal = payload.total;
    });

    this.socket.on('quiz:ended', (payload: {
      quiz: LiveQuizData; // full quiz WITH correct answers
      studentResults: QuizStudentResult[];
      durationSecs: number;
    }) => {
      this.endQuizOverlay(payload.quiz, payload.studentResults);
    });

    this.socket.on('quiz:error', (payload: { message: string }) => {
      console.warn('[QUIZ] error:', payload.message);
      this.quizErrorMsg = payload.message;
      setTimeout(() => { this.quizErrorMsg = ''; }, 5000);
    });
    // ─────────────────────────────────────────────────────────────────────

    fetch(`${environment.apiUrl}/v1/turn/credentials`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data: any) => {
        const cfIce = data?.iceServers;
        const iceServers: any[] = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          cfIce ?? {
            urls: [
              `turn:${environment.turnUrl}:3478`,
              `turn:${environment.turnUrl}:3478?transport=tcp`,
              `turns:${environment.turnUrl}:5349`,
            ],
            username: environment.turnUsername,
            credential: environment.turnCredential,
          },
        ];

        this.myPeer = new Peer('', {
          host: environment.peerHost,
          path: '/',
          secure: true,
          config: { iceServers },
        });

        this.myPeer.on('open', (userPeerId: string) => {
          console.log(`[PEER] open with id: ${userPeerId}`);
          this.myPeerId = userPeerId;
          this.socket.emit('joinRoom', {
            userPeerId,
            username,
            room,
            displayName: this.myDisplayName,
            avatarUrl: this.myAvatarUrl,
          });
        });

        this.myPeer.on('disconnected', () => {
          console.warn('[PEER] disconnected from signaling server — reconnecting...');
          if (!this.myPeer.destroyed) {
            this.myPeer.reconnect();
          }
        });

        this.myPeer.on('error', (err: any) => {
          console.error('[PEER] error:', err);
        });

        this.socket.on('connect', () => {
          if (this.myPeerId) {
            console.log('[SOCKET] reconnected — re-joining room');
            this.socket.emit('joinRoom', {
              userPeerId: this.myPeerId,
              username,
              room,
              displayName: this.myDisplayName,
              avatarUrl: this.myAvatarUrl,
            });
          }
        });

        this.requestMedia();
      });
  }

  /** Audio constraints — kept in one place so the audio-only fallback
   *  uses the exact same processing as the regular video + audio path. */
  private readonly micConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  /** Wraps `navigator.mediaDevices.getUserMedia` so we can call it from
   *  both the initial join flow AND from the "Try again" button on the
   *  permission gate. Maps standard `DOMException.name` values to the
   *  internal `permissionStatus` enum so the UI can show the right copy
   *  for each failure mode.
   *
   *  Fallback: if the full video+audio request fails because there's no
   *  camera on the machine (or the camera is in use / over-constrained),
   *  retry with audio only so users on laptops without webcams can still
   *  join the call as an audio participant.
   */
  requestMedia(): void {
    if (this.permissionRequesting) return; // guard double-clicks on Try again
    this.permissionRequesting = true;
    this.permissionStatus = 'requesting';
    // Reset the audio-only flag in case this is a retry after the user
    // plugged in a camera.
    this.audioOnlyMode = false;
    // Keep `permissionError` in lockstep so any existing template paths
    // that read it stay coherent during the retry round trip.
    this.permissionError = false;

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: this.micConstraints })
      .then((stream) => {
        this.permissionRequesting = false;
        this.permissionStatus = 'granted';
        this.onMediaGranted(stream);
      })
      .catch((err: any) => {
        const name = String(err?.name || '');

        // No camera at all (or one that can't satisfy our constraints,
        // or one currently held by another app)? Don't block the user —
        // try audio only. Most laptops without webcams still have a
        // built-in mic, and a no-video participant is far better than
        // being stranded outside the call.
        if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
          navigator.mediaDevices
            .getUserMedia({ video: false, audio: this.micConstraints })
            .then((audioStream) => {
              this.permissionRequesting = false;
              this.permissionStatus = 'granted';
              this.audioOnlyMode = true;
              this.isCameraOn = false; // there's no camera to be "on"
              this.onMediaGranted(audioStream);
              // Tell already-connected peers we're effectively camera-off so
              // their tile for us renders the initials avatar straight away
              // instead of a black/empty video frame.
              this.socket?.emit('camera-state', false);
            })
            .catch((audioErr: any) => {
              this.handleMediaError(audioErr);
            });
          return;
        }

        this.handleMediaError(err);
      });
  }

  /** Map a DOMException from getUserMedia to the internal permissionStatus
   *  enum + flip the gate on. Centralised so both the video+audio path
   *  and the audio-only fallback funnel through one place. */
  private handleMediaError(err: any): void {
    this.permissionRequesting = false;
    const name = String(err?.name || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      this.permissionStatus = 'denied';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      this.permissionStatus = 'no-device';
    } else if (name === 'NotReadableError' || name === 'AbortError') {
      this.permissionStatus = 'in-use';
    } else {
      this.permissionStatus = 'unknown';
    }
    this.permissionError = true;
    console.error('[MEDIA] getUserMedia error:', err);
  }

  /** Post-permission wiring — peer call answering, socket user-connected
   *  hook, local video preview. Only fires when getUserMedia resolved with
   *  a real MediaStream. */
  private onMediaGranted(stream: MediaStream): void {
    this.localStream = stream;

    setTimeout(() => {
      if (this.localVideoEl?.nativeElement) {
        this.localVideoEl.nativeElement.srcObject = stream;
        this.localVideoEl.nativeElement.muted = true;
        this.localVideoEl.nativeElement.volume = 0;
        this.localVideoEl.nativeElement.play().catch(() => {});
      }
    }, 0);

    this.myPeer.on('call', (call: MediaConnection) => {
      call.answer(stream);
      // Track incoming calls in `this.peers` so we can replaceTrack later
      // (e.g. for screen-share). Without this, the answerer's peer map is
      // empty and their screen-share never reaches the caller.
      this.peers[call.peer] = call;
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.autoplay = true;
      call.on('stream', (remoteStream: MediaStream) => {
        console.log(`[STREAM] incoming call stream fired for ${call.peer}`);
        this.addRemoteStream(video, remoteStream, call.peer);
      });
      call.on('close', () => {
        console.warn(`[PEER] incoming call closed for ${call.peer}`);
        this.removeParticipant(call.peer);
        delete this.peers[call.peer];
      });
      call.on('error', (err: any) => {
        console.error('[PEER] call error:', err);
      });
      this.attachIceDebug(call, call.peer, 'incoming', video);
    });

    this.socket.on('user-connected', (data: { peerId: string; displayName: string; avatarUrl: string }) => {
      this.peerProfiles.set(data.peerId, { name: data.displayName, avatar: data.avatarUrl });
      setTimeout(() => {
        this.connectToNewUser(data.peerId, stream);
      }, 1000);
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.clockInterval);
    clearInterval(this.timerInterval);
    if (this.quizTimerInterval) clearInterval(this.quizTimerInterval);
    this.stopLocalStream();
    this.remoteAudios.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
    });
    this.remoteAudios.clear();
    if (this.myPeer) {
      this.myPeer.destroy();
    }
  }

  // ── Theme ─────────────────────────────────────────────────

  toggleTheme(): void {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem('slocx-theme', this.isDarkMode ? 'dark' : 'light');
  }

  // ── Timer ─────────────────────────────────────────────────

  private startLessonTimer(): void {
    if (this.timerStarted) return;
    this.timerStarted = true;
    this.timerInterval = setInterval(() => {
      if (this.timerRemainingSecs > 0) {
        this.timerRemainingSecs--;
      } else {
        clearInterval(this.timerInterval);
      }
    }, 1000);
  }

  // ── Controls ──────────────────────────────────────────────

  toggleMic(): void {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
  }

  toggleCamera(): void {
    // No-op for audio-only joiners — there's no video track to flip.
    // The HTML disables the button too, but this guard keeps any
    // future caller (keyboard shortcut, etc.) safe.
    if (this.audioOnlyMode) return;

    this.isCameraOn = !this.isCameraOn;
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = this.isCameraOn;
      });
    }
    // Tell remote peers so their tiles for us can swap to the initials
    // avatar instead of showing a frozen / black frame.
    if (this.socket) {
      this.socket.emit('camera-state', this.isCameraOn);
    }
  }

  toggleHand(): void {
    this.handRaised = !this.handRaised;
    this.socket.emit(this.handRaised ? 'raise-hand' : 'lower-hand');
  }

  // ── Public-meeting guest name flow ──────────────────────
  /** Random per-tab identifier used as the signaling `username` for
   *  public-meeting guests. Avoids collisions when two anonymous guests
   *  join with the same display name (the signaling server kicks the
   *  second with `sameName` if usernames collide). */
  private generateGuestId(): string {
    return 'guest-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  /** Called from the name-entry screen. Validates the input, sets the
   *  display name, and finally fires the deferred join. */
  submitGuestName(): void {
    const trimmed = this.guestNameInput.trim();
    if (trimmed.length < 2) return;
    this.myDisplayName = trimmed;
    this.myAvatarUrl = '';
    this.awaitingNameEntry = false;
    this.performJoin();
  }

  onGuestNameKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.submitGuestName();
    }
  }

  // ── Spotlight / pin ──────────────────────────────────────
  //
  // Single source of truth: `this.pinnedPeerId`. Remote tiles are
  // built by hand via `document.createElement` in `addRemoteStream`, so
  // we can't use Angular bindings for the per-tile class — instead we
  // sync the `.meet-video-tile--pinned` class onto / off the DOM nodes
  // imperatively whenever the pin changes. The grid container itself is
  // Angular-managed, so the `has-pinned` class binding handles the
  // outer layout swap.
  togglePin(peerId: string): void {
    if (this.pinnedPeerId === peerId) {
      this.unpin();
      return;
    }
    this.applyPinClass(this.pinnedPeerId, false);
    this.pinnedPeerId = peerId;
    this.applyPinClass(peerId, true);
  }

  unpin(): void {
    if (this.pinnedPeerId) {
      this.applyPinClass(this.pinnedPeerId, false);
    }
    this.pinnedPeerId = null;
  }

  /** Toggle the local user's own pin. The local stream lives in a separate
   *  PiP element; when pinned, an Angular-rendered "spotlight" video takes
   *  the main slot and the PiP hides itself. */
  togglePinLocal(): void {
    this.togglePin('local');
    // After the *ngIf swaps in the spotlight tile we need to wire its
    // <video> srcObject by hand — Angular doesn't have a [srcObject]
    // input binding. Defer until the next tick so the ViewChild is
    // populated, otherwise the lookup misses on the first frame.
    if (this.pinnedPeerId === 'local') {
      setTimeout(() => this.bindLocalSpotlightStream(), 0);
    }
  }

  private bindLocalSpotlightStream(): void {
    const el = this.localSpotlightVideoEl?.nativeElement;
    if (!el || !this.localStream) return;
    // Reuse the same stream — mic/cam toggles on `localStream` propagate
    // automatically because tracks are shared. Mute the audio side of this
    // mirror to avoid feedback (the PiP is also muted for the same reason).
    el.srcObject = this.localStream;
    el.muted = true;
    el.play().catch(() => {});
  }

  /** True when the click should be treated as a pin gesture on a tile
   *  rather than a drag/scroll. Used by the grid event-delegation handler. */
  onGridClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    const tile = target?.closest('.meet-video-tile') as HTMLElement | null;
    if (!tile || !tile.id) return;
    const peerId = tile.id.replace(/^tile-/, '');
    if (peerId) this.togglePin(peerId);
  }

  private applyPinClass(peerId: string | null, on: boolean): void {
    if (!peerId || peerId === 'local') return; // local tile is Angular-rendered
    const el = document.getElementById('tile-' + peerId);
    if (!el) return;
    el.classList.toggle('meet-video-tile--pinned', on);
  }

  toggleReactions(): void {
    this.reactionsOpen = !this.reactionsOpen;
  }

  sendReaction(emoji: string): void {
    this.socket.emit('reaction', { emoji });
    this.showFloatingReaction(emoji, this.myDisplayName);
    this.reactionsOpen = false;
  }

  private showFloatingReaction(emoji: string, name: string): void {
    const id = this.reactionIdCounter++;
    this.floatingReactions.push({ emoji, name, id });
    setTimeout(() => {
      this.floatingReactions = this.floatingReactions.filter((r) => r.id !== id);
    }, 3500);
  }

  toggleChat(): void {
    this.chatOpen = !this.chatOpen;
    if (this.chatOpen) {
      this.unreadMessages = 0;
      setTimeout(() => this.scrollChatToBottom(), 0);
    }
  }

  sendMessage(): void {
    const text = this.chatInput.trim();
    if (!text) return;
    this.socket.emit('chat-message', { text });
    this.chatMessages.push({
      displayName: this.myDisplayName,
      avatarUrl: this.myAvatarUrl,
      text,
      timestamp: Date.now(),
      self: true,
    });
    this.chatInput = '';
    setTimeout(() => this.scrollChatToBottom(), 0);
  }

  onChatKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  /** True while the "include tab audio?" confirmation modal is open. The
   *  modal is shown before each share attempt because the choice is per
   *  session — once shared, the user can't toggle audio without re-sharing. */
  screenShareConfirmOpen: boolean = false;

  async toggleScreenShare(): Promise<void> {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      return;
    }
    // Show the small "include audio?" prompt before invoking
    // getDisplayMedia, since the OS-level share dialog comes right after
    // and we want the choice baked into the request.
    this.screenShareConfirmOpen = true;
  }

  /** Called by the audio-confirmation modal. `includeAudio = true` swaps
   *  the user's mic output for the captured tab audio so screen audio is
   *  actually transmitted to peers; their mic is restored on stop. */
  async startScreenShareWith(includeAudio: boolean): Promise<void> {
    this.screenShareConfirmOpen = false;
    await this.startScreenShare(includeAudio);
  }

  cancelScreenShareConfirm(): void {
    this.screenShareConfirmOpen = false;
  }

  private async startScreenShare(includeAudio: boolean = false): Promise<void> {
    try {
      // Note: browsers only return an audio track when the user picks a
      // browser TAB and ticks "Share tab audio". Window/full-screen
      // shares can't carry audio. We always request it when asked; the
      // user is informed of the limitation in the confirm modal copy.
      const constraints: MediaStreamConstraints = {
        video: true,
        audio: includeAudio,
      };
      const screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      this.screenStream = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];
      this.replaceVideoTrackInPeers(screenTrack);

      // If the user opted in AND the browser actually produced an audio
      // track, MIX it with the mic into a single composite track and
      // send that to peers. Naively `replaceTrack`-ing the audio sender
      // with the tab audio (the old behavior) made the sharer go silent
      // because their mic was no longer being transmitted.
      //
      // Web Audio API: connect both MediaStreamSources into a single
      // MediaStreamDestination; the destination's stream has a mixed
      // audio track we send instead of the mic. On stop, we restore the
      // mic and tear down the AudioContext.
      const screenAudio = screenStream.getAudioTracks()[0];
      if (includeAudio && screenAudio) {
        const mixedTrack = this.buildMixedAudioTrack(this.localStream, screenStream);
        if (mixedTrack) {
          this.replaceAudioTrackInPeers(mixedTrack);
          this.mixedAudioTrack = mixedTrack;
          this.audioSourceIsScreen = true;
        }
        // When the user stops sharing via the browser's "Stop sharing"
        // bar, the audio track ends independently — handle both.
        screenAudio.addEventListener('ended', () => {
          if (this.isScreenSharing) this.stopScreenShare();
        });
      }

      this.isScreenSharing = true;
      // Show the screen in the local PiP so the user sees what they're sharing
      // (and the unmirrored CSS rule for .screen-sharing finally applies to a
      // genuinely-unmirrored stream — fixes the "inverted self" bug).
      if (this.localVideoEl?.nativeElement) {
        this.localVideoEl.nativeElement.srcObject = screenStream;
        this.localVideoEl.nativeElement.play().catch(() => {});
      }
      this.socket.emit('start-screen-share');
      screenTrack.addEventListener('ended', () => {
        this.stopScreenShare();
      });
    } catch (err: any) {
      if (err.name !== 'NotAllowedError') {
        console.error('[SCREEN] getDisplayMedia error:', err);
      }
    }
  }

  /** True when the outgoing audio sender on each peer is currently
   *  carrying mixed (mic + tab) audio rather than the bare mic track.
   *  Used so stop can restore the mic in one place. */
  private audioSourceIsScreen: boolean = false;

  /** AudioContext used to mix mic + tab audio during a screen share.
   *  Held so we can `close()` it on stop and free the audio thread. */
  private screenAudioCtx: AudioContext | null = null;

  /** Reference to the mixed MediaStreamTrack so stop() can stop() it
   *  explicitly (the underlying graph stays alive until then). */
  private mixedAudioTrack: MediaStreamTrack | null = null;

  /** Build a single audio MediaStreamTrack that carries BOTH the mic
   *  and the captured tab audio. Returns null if either source is
   *  missing — caller falls back gracefully. */
  private buildMixedAudioTrack(
    mic: MediaStream | null,
    tab: MediaStream,
  ): MediaStreamTrack | null {
    const tabAudio = tab.getAudioTracks()[0];
    if (!tabAudio) return null;

    try {
      const AC: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC();
      const dest = ctx.createMediaStreamDestination();

      // Tab audio is always in the mix.
      const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]));
      tabSource.connect(dest);

      // Mic optional — if mic stream has no audio track (rare, but
      // possible if the user denied mic at startup), we ship tab-only.
      const micAudio = mic?.getAudioTracks()[0];
      if (micAudio) {
        const micSource = ctx.createMediaStreamSource(new MediaStream([micAudio]));
        micSource.connect(dest);
      }

      this.screenAudioCtx = ctx;
      return dest.stream.getAudioTracks()[0] || null;
    } catch (err) {
      console.error('[SCREEN] audio mix failed:', err);
      return null;
    }
  }

  private async stopScreenShare(): Promise<void> {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    const cameraTrack = this.localStream?.getVideoTracks()[0];
    if (cameraTrack) {
      this.replaceVideoTrackInPeers(cameraTrack);
    }
    // Restore bare mic audio if we'd swapped it for the mic+tab mix,
    // then tear down the audio mixer graph so we don't leak nodes.
    if (this.audioSourceIsScreen) {
      const micTrack = this.localStream?.getAudioTracks()[0];
      if (micTrack) {
        this.replaceAudioTrackInPeers(micTrack);
      }
      if (this.mixedAudioTrack) {
        this.mixedAudioTrack.stop();
        this.mixedAudioTrack = null;
      }
      if (this.screenAudioCtx) {
        this.screenAudioCtx.close().catch(() => {});
        this.screenAudioCtx = null;
      }
      this.audioSourceIsScreen = false;
    }
    // Restore the camera stream in the local PiP
    if (this.localVideoEl?.nativeElement && this.localStream) {
      this.localVideoEl.nativeElement.srcObject = this.localStream;
      this.localVideoEl.nativeElement.play().catch(() => {});
    }
    this.isScreenSharing = false;
    this.socket.emit('stop-screen-share');
  }

  private replaceVideoTrackInPeers(newTrack: MediaStreamTrack): void {
    Object.values(this.peers).forEach((call) => {
      const pc: RTCPeerConnection = (call as any).peerConnection;
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        sender.replaceTrack(newTrack).catch((err) =>
          console.error('[SCREEN] replaceTrack error:', err)
        );
      }
    });
  }

  /** Same pattern as `replaceVideoTrackInPeers` but for the audio sender —
   *  used to swap mic ↔ tab audio when screen-sharing with audio. */
  private replaceAudioTrackInPeers(newTrack: MediaStreamTrack): void {
    Object.values(this.peers).forEach((call) => {
      const pc: RTCPeerConnection = (call as any).peerConnection;
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        sender.replaceTrack(newTrack).catch((err) =>
          console.error('[SCREEN] audio replaceTrack error:', err)
        );
      }
    });
  }

  enableAudio(): void {
    this.remoteAudios.forEach((audio) => {
      audio.muted = false;
      if (audio.paused) audio.play().catch(() => {});
    });
    this.showAudioPrompt = false;
  }

  leaveCall(): void {
    // End the media side of the call immediately — the student should not
    // keep streaming while the rating modal is open. Once destroyed, even if
    // the user dismisses without submitting, the call is genuinely over.
    this.stopLocalStream();
    if (this.myPeer) {
      this.myPeer.destroy();
    }

    // Show the rating modal only for students who arrived with a review
    // ticket. Tutors and legacy/unauthenticated meeting links skip it.
    if (!this.isTutor && this.reviewTicket) {
      this.showRatingModal = true;
      return;
    }
    this.exitWindow();
  }

  /** Final exit step — close the tab or fall back to `about:blank` if the
   *  window wasn't opened with `window.open` (browsers will refuse the close
   *  in that case). Used by both the legacy leave path and the rating modal. */
  private exitWindow(): void {
    window.close();
    setTimeout(() => {
      window.location.href = 'about:blank';
    }, 300);
  }

  // ── Rating modal ──────────────────────────────────────────

  setRating(stars: number): void {
    if (this.ratingSubmitting || this.ratingDone) return;
    this.ratingValue = stars;
  }

  setRatingHover(stars: number): void {
    if (this.ratingSubmitting || this.ratingDone) return;
    this.ratingHoverValue = stars;
  }

  clearRatingHover(): void {
    this.ratingHoverValue = 0;
  }

  /** Send the review to the backend's ticket-authenticated endpoint. The
   *  ticket itself is the credential — it encodes user/tutor/lesson and
   *  expires shortly after class. No JWT, no Authorization header. */
  async submitRating(): Promise<void> {
    if (this.ratingSubmitting || this.ratingDone) return;
    if (this.ratingValue < 1 || this.ratingValue > 5) {
      this.ratingError = 'Please pick a star rating from 1 to 5.';
      return;
    }
    if (!this.ratingComment.trim()) {
      this.ratingError = 'Please leave a short comment so the tutor knows what worked.';
      return;
    }
    if (!this.reviewTicket) {
      // Should never happen — leaveCall() only opens the modal when a
      // ticket is present. Belt and braces.
      this.ratingError = 'Missing review ticket — please leave a review from your dashboard instead.';
      return;
    }

    this.ratingError = '';
    this.ratingSubmitting = true;

    try {
      const res = await fetch(`${environment.apiUrl}/v1/review/by-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket: this.reviewTicket,
          rating: this.ratingValue,
          comment: this.ratingComment.trim(),
        }),
      });

      if (res.ok) {
        this.ratingDone = true;
        // Auto-close after a short beat so the student sees the thanks state.
        setTimeout(() => this.exitWindow(), 1500);
        return;
      }
      let msg = 'Could not submit your review.';
      try {
        const body = await res.json();
        msg = body?.error || body?.message || msg;
      } catch (_) {}
      this.ratingError = msg;
    } catch (err) {
      console.error('[REVIEW] submit error:', err);
      this.ratingError = 'Network error — please try again or skip.';
    } finally {
      this.ratingSubmitting = false;
    }
  }

  /** "Maybe later" — closes the modal and exits without writing a review. */
  skipRating(): void {
    if (this.ratingSubmitting) return;
    this.exitWindow();
  }

  // ── Quiz controls ─────────────────────────────────────────

  toggleQuizLaunch(): void {
    this.quizLaunchOpen = !this.quizLaunchOpen;
  }

  launchQuiz(): void {
    this.quizLaunchOpen = false;
    this.socket.emit('quiz:launch', {
      lessonId: this.lessonId,
      durationSecs: this.quizLaunchDuration,
    });
  }

  endQuizEarly(): void {
    this.socket.emit('quiz:end-early');
  }

  get quizCurrentQuestion(): QuizQuestion | null {
    if (!this.quizData) return null;
    return this.quizData.questions[this.quizCurrentIndex] ?? null;
  }

  get quizTimerProgress(): number {
    if (this.quizDurationSecs === 0) return 1;
    return this.quizRemainingSecs / this.quizDurationSecs;
  }

  get quizTimerLabel(): string {
    const s = Math.max(0, this.quizRemainingSecs);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  selectAnswer(questionId: string, answer: string): void {
    if (this.quizSubmitted) return;
    this.quizAnswers.set(questionId, answer);
  }

  isAnswerSelected(questionId: string, answer: string): boolean {
    return this.quizAnswers.get(questionId) === answer;
  }

  nextQuestion(): void {
    if (!this.quizData) return;
    if (this.quizCurrentIndex < this.quizData.questions.length - 1) {
      this.quizCurrentIndex++;
    }
  }

  prevQuestion(): void {
    if (this.quizCurrentIndex > 0) {
      this.quizCurrentIndex--;
    }
  }

  submitQuizAnswers(): void {
    if (this.quizSubmitted || !this.quizData) return;
    this.quizSubmitted = true;
    const answersObj: Record<string, string> = {};
    this.quizAnswers.forEach((val, key) => { answersObj[key] = val; });
    this.socket.emit('quiz:answer', { answers: answersObj });
  }

  private startQuizOverlay(quiz: LiveQuizData, durationSecs: number): void {
    this.quizData = quiz;
    this.quizDurationSecs = durationSecs;
    this.quizRemainingSecs = durationSecs;
    this.quizCurrentIndex = 0;
    this.quizAnswers = new Map();
    this.quizSubmitted = false;
    this.showQuizResults = false;
    this.quizAnsweredCount = 0;
    this.quizActive = true;

    if (this.quizTimerInterval) clearInterval(this.quizTimerInterval);
    this.quizTimerInterval = setInterval(() => {
      if (this.quizRemainingSecs > 0) {
        this.quizRemainingSecs--;
      } else {
        clearInterval(this.quizTimerInterval);
        if (!this.quizSubmitted) {
          this.submitQuizAnswers();
        }
      }
    }, 1000);
  }

  private endQuizOverlay(quizWithAnswers: LiveQuizData, results: QuizStudentResult[]): void {
    if (this.quizTimerInterval) {
      clearInterval(this.quizTimerInterval);
      this.quizTimerInterval = null;
    }
    this.quizResults = results;
    this.showQuizResults = true;
    this.quizSubmitted = true;

    // Build correct-answer lookup from the full quiz data returned by server
    this.quizRevealedAnswers = new Map();
    this.quizCorrectOptions = new Map();
    quizWithAnswers.questions.forEach((q) => {
      if (q.question_type === 'multiple_choice') {
        const correctOpt = (q as any).options?.find((o: any) => o.is_correct);
        if (correctOpt) this.quizCorrectOptions.set(q.id, correctOpt.id);
      } else {
        this.quizCorrectOptions.set(q.id, q.correct_answer);
      }
    });

    // Find my result (username = userId)
    this.myQuizResult = results.find((r) => r.userId === this.myUsername) ?? null;
    if (this.myQuizResult) {
      this.myQuizResult.answers.forEach((a) => {
        this.quizRevealedAnswers.set(a.questionId, a.isCorrect);
      });
    }

    // Set data to the full quiz with answers so review shows correctly
    this.quizData = quizWithAnswers;
  }

  closeQuizOverlay(): void {
    this.quizActive = false;
    this.quizData = null;
    this.showQuizResults = false;
    if (this.quizTimerInterval) {
      clearInterval(this.quizTimerInterval);
      this.quizTimerInterval = null;
    }
  }

  get answeredCount(): number {
    return this.quizAnswers.size;
  }

  get totalQuestions(): number {
    return this.quizData?.questions.length ?? 0;
  }

  isQuizAnswerCorrect(questionId: string): boolean {
    return this.quizRevealedAnswers.get(questionId) ?? false;
  }

  getCorrectOption(questionId: string): string {
    return this.quizCorrectOptions.get(questionId) ?? '';
  }

  // ─────────────────────────────────────────────────────────

  // ── Internal helpers ──────────────────────────────────────

  private connectToNewUser(userId: string, stream: MediaStream): void {
    const call = this.myPeer.call(userId, stream);
    if (!call) return;
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.autoplay = true;

    call.on('stream', (remoteStream: MediaStream) => {
      console.log(`[STREAM] outgoing call stream fired for ${userId}`);
      this.addRemoteStream(video, remoteStream, userId);
    });
    call.on('close', () => {
      console.warn(`[PEER] outgoing call closed for ${userId}`);
      this.removeParticipant(userId);
    });
    call.on('error', (err: any) => {
      console.error('[PEER] outgoing call error:', err);
    });

    this.attachIceDebug(call, userId, 'outgoing', video);
    this.peers[userId] = call;
  }

  private addRemoteStream(
    video: HTMLVideoElement,
    stream: MediaStream,
    userId: string
  ): void {
    const vTracks = stream.getVideoTracks();
    const aTracks = stream.getAudioTracks();
    console.log(`[STREAM] ${userId} — videoTracks: ${vTracks.length}, audioTracks: ${aTracks.length}`);

    const existingTile = document.getElementById('tile-' + userId);
    if (existingTile) {
      const existingVideo = existingTile.querySelector('video') as HTMLVideoElement | null;
      if (existingVideo) {
        const videoOnly = new MediaStream(stream.getVideoTracks());
        existingVideo.srcObject = videoOnly;
        existingVideo.play().catch((err) => {
          if (err.name !== 'AbortError') console.error(`[STREAM] renego play error:`, err);
        });
      }
      const existingAudio = this.remoteAudios.get(userId);
      if (existingAudio && stream.getAudioTracks().length > 0) {
        existingAudio.srcObject = new MediaStream(stream.getAudioTracks());
        existingAudio.play().catch(() => {});
      }
      return;
    }

    const videoOnly = new MediaStream(stream.getVideoTracks());
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    video.muted = true;
    video.srcObject = videoOnly;

    const tile = document.createElement('div');
    tile.classList.add('meet-video-tile');
    tile.id = 'tile-' + userId;
    tile.append(video);

    // Visual pin affordance — a circular icon that appears on hover. The
    // click is captured by event delegation on the grid (see onGridClick)
    // so we don't need a per-tile listener. The icon swaps its bi-* class
    // on .meet-video-tile--pinned so the user sees the current state.
    const pinBtn = document.createElement('button');
    pinBtn.classList.add('meet-video-tile-pin');
    pinBtn.title = 'Pin / unpin';
    pinBtn.innerHTML = '<i class="bi bi-pin-angle-fill"></i>';
    pinBtn.setAttribute('aria-label', 'Pin this participant');
    tile.append(pinBtn);

    // Auto-apply the pinned class if this tile is the one currently
    // spotlighted — happens when a participant reconnects mid-pin.
    if (this.pinnedPeerId === userId) {
      tile.classList.add('meet-video-tile--pinned');
    }

    const grid = this.videoGrid?.nativeElement ?? document.querySelector('.meet-video-grid');
    if (!grid) return;
    grid.append(tile);
    this.remoteCount++;

    // Start lesson timer on first remote participant
    if (this.remoteCount >= 1 && !this.timerStarted) {
      this.startLessonTimer();
    }

    if (this.raisedHands.has(userId)) {
      this.showHandIndicator(userId, true);
    }
    // If their camera was already off when we joined, render the overlay
    // immediately — otherwise the tile would briefly show a black frame.
    if (this.cameraOffPeers.has(userId)) {
      this.applyCameraOffOverlay(userId, true);
    }

    this.remoteVideos.push(video);
    video.addEventListener('loadedmetadata', () => {
      console.log(`[VIDEO] loadedmetadata for ${userId}: ${video.videoWidth}x${video.videoHeight}`);
    });
    video.play().catch(() => {});

    if (stream.getAudioTracks().length > 0) {
      const audio = new Audio();
      audio.srcObject = new MediaStream(stream.getAudioTracks());
      audio.autoplay = true;
      audio.muted = false;
      this.remoteAudios.set(userId, audio);
      audio.play()
        .then(() => console.log(`[AUDIO] ✅ separate audio playing for ${userId}`))
        .catch((err) => {
          if (err.name === 'AbortError') return;
          console.warn(`[AUDIO] autoplay blocked for ${userId}, showing prompt`);
          this.showAudioPrompt = true;
        });
    }
  }

  private removeParticipant(userId: string): void {
    const tile = document.getElementById('tile-' + userId);
    if (tile) {
      const video = tile.querySelector('video') as HTMLVideoElement | null;
      if (video) {
        this.remoteVideos = this.remoteVideos.filter((v) => v !== video);
      }
      tile.remove();
      this.remoteCount = Math.max(0, this.remoteCount - 1);
    }
    const audio = this.remoteAudios.get(userId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      this.remoteAudios.delete(userId);
    }
    if (this.remoteCount === 0) {
      this.showAudioPrompt = false;
    }
    // Drop the spotlight if the pinned participant just left, otherwise
    // the grid would stay in pinned-layout mode with nothing to spotlight.
    if (this.pinnedPeerId === userId) {
      this.pinnedPeerId = null;
    }
  }

  private showHandIndicator(peerId: string, raised: boolean): void {
    const tile = document.getElementById('tile-' + peerId);
    if (!tile) return;
    let badge = tile.querySelector('.hand-raise-badge') as HTMLElement | null;
    if (raised) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'hand-raise-badge';
        badge.textContent = '✋';
        tile.appendChild(badge);
      }
    } else {
      badge?.remove();
    }
  }

  /** Render / remove the initials overlay on a remote tile when their
   *  camera goes off / on. Uses the cached profile (set on user-connected)
   *  to derive the initials; falls back to "?" if unknown. */
  private applyCameraOffOverlay(peerId: string, off: boolean): void {
    const tile = document.getElementById('tile-' + peerId);
    if (!tile) return;
    let overlay = tile.querySelector('.tile-cam-off') as HTMLElement | null;
    if (off) {
      if (!overlay) {
        const profile = this.peerProfiles.get(peerId);
        const name = profile?.name || peerId;
        overlay = document.createElement('div');
        overlay.className = 'tile-cam-off';
        const circle = document.createElement('div');
        circle.className = 'tile-cam-off-initials';
        circle.textContent = this.getInitials(name);
        const label = document.createElement('div');
        label.className = 'tile-cam-off-name';
        label.textContent = name;
        overlay.append(circle, label);
        tile.appendChild(overlay);
      }
    } else {
      overlay?.remove();
    }
  }

  /** Compute up to two uppercase initials from a display name. */
  getInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  private scrollChatToBottom(): void {
    const el = document.querySelector('.chat-messages') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }

  private attachIceDebug(
    call: MediaConnection,
    userId: string,
    dir: string,
    video?: HTMLVideoElement
  ): void {
    setTimeout(() => {
      const pc: RTCPeerConnection = (call as any).peerConnection;
      if (!pc) return;

      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(`[ICE][${dir}][${userId}] iceConnectionState → ${pc.iceConnectionState}`);
        if (
          (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') &&
          video
        ) {
          video.muted = false;
          if (video.paused) video.play().catch(() => {});
        }
      });

      pc.addEventListener('connectionstatechange', () => {
        console.log(`[ICE][${dir}][${userId}] connectionState → ${pc.connectionState}`);
        if (pc.connectionState === 'connected' && video) {
          video.muted = false;
          if (video.paused) video.play().catch(() => {});
        }
      });
    }, 0);
  }

  private stopLocalStream(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }
  }

  private getAudioCtx(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.audioCtx;
  }

  private playMessageSound(): void {
    try {
      const ctx = this.getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
    } catch (_) {}
  }

  private playHandSound(): void {
    try {
      const ctx = this.getAudioCtx();
      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.25, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        osc.start(start);
        osc.stop(start + duration);
      };
      playTone(600, ctx.currentTime, 0.12);
      playTone(900, ctx.currentTime + 0.14, 0.18);
    } catch (_) {}
  }
}
