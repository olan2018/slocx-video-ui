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

  // State
  isMuted: boolean = false;
  isCameraOn: boolean = true;
  permissionError: boolean = false;
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

    this.isTutor = roleParam === 'tutor';
    this.lessonId = room; // room param is the lesson ID

    // Parse lesson duration
    const durationMins = parseInt(durationParam, 10);
    if (!isNaN(durationMins) && durationMins > 0) {
      this.lessonDurationSecs = durationMins * 60;
    }
    this.timerRemainingSecs = this.lessonDurationSecs;

    this.myUsername = username || 'Me';
    this.myDisplayName = name || this.myUsername;
    this.myAvatarUrl = photo || '';

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

        navigator.mediaDevices
          .getUserMedia({
            video: true,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          })
          .then((stream) => {
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
          })
          .catch((err) => {
            console.error('[MEDIA] getUserMedia error:', err);
            this.permissionError = true;
          });
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
    this.isCameraOn = !this.isCameraOn;
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = this.isCameraOn;
      });
    }
  }

  toggleHand(): void {
    this.handRaised = !this.handRaised;
    this.socket.emit(this.handRaised ? 'raise-hand' : 'lower-hand');
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

  async toggleScreenShare(): Promise<void> {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  private async startScreenShare(): Promise<void> {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      this.screenStream = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];
      this.replaceVideoTrackInPeers(screenTrack);
      this.isScreenSharing = true;
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

  private async stopScreenShare(): Promise<void> {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    const cameraTrack = this.localStream?.getVideoTracks()[0];
    if (cameraTrack) {
      this.replaceVideoTrackInPeers(cameraTrack);
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

  enableAudio(): void {
    this.remoteAudios.forEach((audio) => {
      audio.muted = false;
      if (audio.paused) audio.play().catch(() => {});
    });
    this.showAudioPrompt = false;
  }

  leaveCall(): void {
    this.stopLocalStream();
    if (this.myPeer) {
      this.myPeer.destroy();
    }
    window.close();
    setTimeout(() => {
      window.location.href = 'about:blank';
    }, 300);
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
