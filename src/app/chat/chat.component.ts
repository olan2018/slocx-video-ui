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

  // Chat
  chatOpen: boolean = false;
  chatMessages: ChatMessage[] = [];
  chatInput: string = '';
  unreadMessages: number = 0;

  // Raise hand
  handRaised: boolean = false;
  raisedHands: Set<string> = new Set();

  // Audio prompt (browser autoplay policy blocks unmuted playback)
  showAudioPrompt: boolean = false;

  // Screen sharing
  isScreenSharing: boolean = false;
  private screenStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;

  private myPeer!: Peer;
  private localStream!: MediaStream;
  private peers: { [key: string]: MediaConnection } = {};
  private remoteVideos: HTMLVideoElement[] = [];
  private timeInterval!: any;
  private socket!: ReturnType<typeof io>;
  private myUsername: string = '';
  myDisplayName: string = 'Me';
  myAvatarUrl: string = '';
  private peerProfiles: Map<string, { name: string; avatar: string }> = new Map();

  constructor() {}

  ngOnInit(): void {
    this.timeInterval = setInterval(() => {
      this.currentTime = new Date();
    }, 1000);

    const { user: username, room, name, photo } = Qs.parse(location.search, {
      ignoreQueryPrefix: true,
    });

    this.myUsername = (username as string) || 'Me';
    this.myDisplayName = (name as string) || this.myUsername;
    this.myAvatarUrl = (photo as string) || '';

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

    // Chat messages from others
    this.socket.on('chat-message', (msg: { displayName: string; avatarUrl: string; text: string; timestamp: number }) => {
      this.chatMessages.push({ ...msg, self: false });
      this.playMessageSound();
      if (!this.chatOpen) {
        this.unreadMessages++;
      }
      setTimeout(() => this.scrollChatToBottom(), 0);
    });

    // Raise hand events
    this.socket.on('user-raised-hand', (peerId: string) => {
      this.raisedHands.add(peerId);
      this.showHandIndicator(peerId, true);
      this.playHandSound();
    });
    this.socket.on('user-lowered-hand', (peerId: string) => {
      this.raisedHands.delete(peerId);
      this.showHandIndicator(peerId, false);
    });

    // Screen share state from remote peers — toggle CSS mirror flip on their tile
    this.socket.on('user-started-screen-share', (peerId: string) => {
      document.getElementById('tile-' + peerId)?.classList.add('screen-sharing');
    });
    this.socket.on('user-stopped-screen-share', (peerId: string) => {
      document.getElementById('tile-' + peerId)?.classList.remove('screen-sharing');
    });

    // Remote user left — handled separately so we can clean up raised hands too
    this.socket.on('user-disconnected', (userId: string) => {
      this.raisedHands.delete(userId);
      this.peerProfiles.delete(userId);
      if (this.peers[userId]) {
        this.peers[userId].close();
        delete this.peers[userId];
      }
      this.removeParticipant(userId);
    });

    // Fetch fresh Cloudflare TURN credentials from backend, fall back to env values
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
          this.socket.emit('joinRoom', {
            userPeerId,
            username,
            room,
            displayName: this.myDisplayName,
            avatarUrl: this.myAvatarUrl,
          });
        });

        this.myPeer.on('error', (err: any) => {
          console.error('[PEER] error:', err);
        });

        navigator.mediaDevices
          .getUserMedia({ video: true, audio: true })
          .then((stream) => {
            this.localStream = stream;

            setTimeout(() => {
              if (this.localVideoEl?.nativeElement) {
                this.localVideoEl.nativeElement.srcObject = stream;
                this.localVideoEl.nativeElement.play().catch(() => {});
              }
            }, 0);

            // Answer incoming PeerJS calls
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

            // New user joined — call them
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
    clearInterval(this.timeInterval);
    this.stopLocalStream();
    if (this.myPeer) {
      this.myPeer.destroy();
    }
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

      if (this.localVideoEl?.nativeElement) {
        this.localVideoEl.nativeElement.srcObject = screenStream;
      }

      this.isScreenSharing = true;
      this.socket.emit('start-screen-share');

      // Auto-revert when user clicks the browser's native "Stop sharing" button
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

    if (this.localVideoEl?.nativeElement) {
      this.localVideoEl.nativeElement.srcObject = this.localStream;
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
    // Called from a real user click — satisfies browser autoplay gesture requirement
    this.remoteVideos.forEach((v) => {
      v.muted = false;
      if (v.paused) v.play().catch(() => {});
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
    // Log stream track states for diagnosis
    const vTracks = stream.getVideoTracks();
    const aTracks = stream.getAudioTracks();
    console.log(`[STREAM] ${userId} — videoTracks: ${vTracks.length}, audioTracks: ${aTracks.length}`);
    vTracks.forEach((t) =>
      console.log(`  [TRACK] video: enabled=${t.enabled}, readyState=${t.readyState}, muted=${t.muted}`)
    );

    const existingTile = document.getElementById('tile-' + userId);
    if (existingTile) {
      // ICE renegotiation — swap srcObject without pausing (avoids AbortError)
      console.log(`[STREAM] renegotiation for ${userId}, swapping srcObject`);
      video.srcObject = stream;
      video.muted = false;
      video.play().catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(`[STREAM] renegotiation play() error for ${userId}:`, err);
        }
      });
      return;
    }

    // Build and attach tile to DOM first so the video element is live
    const tile = document.createElement('div');
    tile.classList.add('meet-video-tile');
    tile.id = 'tile-' + userId;
    tile.append(video);

    const grid = this.videoGrid?.nativeElement ?? document.querySelector('.meet-video-grid');
    if (!grid) return;
    grid.append(tile);
    this.remoteCount++;

    // Show raised hand badge if already raised before tile appeared
    if (this.raisedHands.has(userId)) {
      this.showHandIndicator(userId, true);
    }

    // Track this video element so enableAudio() can unmute it on user click
    this.remoteVideos.push(video);

    // Set stream after element is in DOM, then play
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    video.muted = true; // Start muted — required for autoplay on mobile
    video.srcObject = stream;

    video.addEventListener('loadedmetadata', () => {
      console.log(`[VIDEO] loadedmetadata for ${userId}: ${video.videoWidth}x${video.videoHeight}`);
    });

    video.play()
      .then(() => {
        // Try to unmute — works on desktop Chrome; may silently stay muted on mobile
        video.muted = false;
        console.log(`[AUDIO] after unmute attempt: video.muted=${video.muted}`);
        // After a short delay, verify muted status (browser may keep it muted)
        setTimeout(() => {
          if (video.muted) {
            console.warn(`[AUDIO] video still muted for ${userId} — showing audio prompt`);
            this.showAudioPrompt = true;
          }
        }, 300);
      })
      .catch((err) => {
        // AbortError is expected when renegotiation swaps srcObject before play() resolves
        if (err.name !== 'AbortError') {
          console.error(`[STREAM] play() error for ${userId}:`, err);
        }
      });
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
    // Hide audio prompt if no more remote participants
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
      if (!pc) {
        console.warn(`[ICE][${dir}][${userId}] peerConnection not available`);
        return;
      }

      // Log the state right now — we may have already missed early transitions
      console.log(
        `[ICE][${dir}][${userId}] INIT: ice=${pc.iceConnectionState}, conn=${pc.connectionState}, signaling=${pc.signalingState}`
      );

      // Use addEventListener (not onXxx) so we don't overwrite PeerJS's own handlers
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(`[ICE][${dir}][${userId}] iceConnectionState → ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          console.error(`[ICE][${dir}][${userId}] ICE FAILED — no relay path. Check TURN credentials.`);
        }
        if (pc.iceConnectionState === 'disconnected') {
          console.warn(`[ICE][${dir}][${userId}] ICE disconnected — may recover or fail`);
        }
        // ICE connected/completed → force video to play if it got stuck
        if (
          (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') &&
          video
        ) {
          console.log(`[ICE][${dir}][${userId}] ICE connected — forcing video play`);
          video.muted = false;
          if (video.paused) {
            video.play().catch(() => {});
          }
        }
      });

      pc.addEventListener('icegatheringstatechange', () => {
        console.log(`[ICE][${dir}][${userId}] iceGatheringState → ${pc.iceGatheringState}`);
      });

      pc.addEventListener('icecandidate', (event) => {
        if (!event.candidate) {
          console.log(`[ICE][${dir}][${userId}] candidate gathering complete`);
          return;
        }
        const c = event.candidate;
        console.log(
          `[ICE][${dir}][${userId}] candidate: type=${c.type} protocol=${c.protocol} address=${c.address}`
        );
      });

      pc.addEventListener('connectionstatechange', () => {
        console.log(`[ICE][${dir}][${userId}] connectionState → ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          // Log which candidate pair was selected
          pc.getStats().then((stats) => {
            stats.forEach((report) => {
              if (
                report.type === 'candidate-pair' &&
                (report as any).state === 'succeeded' &&
                (report as any).nominated
              ) {
                const local = (stats as any).get((report as any).localCandidateId);
                const remote = (stats as any).get((report as any).remoteCandidateId);
                const localType = local?.candidateType ?? '?';
                const remoteType = remote?.candidateType ?? '?';
                console.log(
                  `[ICE][${dir}][${userId}] ✅ SELECTED PAIR — local: ${localType}, remote: ${remoteType}` +
                    (localType === 'relay' || remoteType === 'relay'
                      ? ' ← TURN relay in use'
                      : ' ← direct/STUN path')
                );
              }
            });
          });
          // Force video play when fully connected
          if (video) {
            video.muted = false;
            if (video.paused) {
              video.play().catch(() => {});
            }
          }
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
