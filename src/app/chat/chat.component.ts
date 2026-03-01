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

  private myPeer!: Peer;
  private localStream!: MediaStream;
  private peers: { [key: string]: MediaConnection } = {};
  private timeInterval!: any;

  constructor() {}

  ngOnInit(): void {
    this.timeInterval = setInterval(() => {
      this.currentTime = new Date();
    }, 1000);

    const { user: username, room } = Qs.parse(location.search, {
      ignoreQueryPrefix: true,
    });

    const socket = io(environment.socketUrl);

    socket.on('connect', () => {
      console.log('[SOCKET] connected');
    });
    socket.on('disconnect', (reason: string) => {
      console.warn('[SOCKET] disconnected:', reason);
    });
    socket.on('connect_error', (err: Error) => {
      console.error('[SOCKET] connect_error:', err.message);
    });

    socket.on('roomNotValid', () => {
      this.connectionError = true;
      this.connectionErrorMsg = 'This classroom link is invalid or the lesson has not started yet.';
    });

    socket.on('doNotBelongToClass', () => {
      this.connectionError = true;
      this.connectionErrorMsg = 'You are not a participant of this lesson.';
    });

    socket.on('sameName', () => {
      this.connectionError = true;
      this.connectionErrorMsg = 'You are already connected to this lesson from another window.';
    });

    this.myPeer = new Peer('', {
      host: environment.peerHost,
      path: '/',
      secure: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:slocx.metered.live:80' },
          {
            urls: 'turn:slocx.metered.live:80',
            username: '6cd2bd6552c9c01f4bb75822',
            credential: 'NnRurMddTHIbVDV9',
          },
          {
            urls: 'turn:slocx.metered.live:443',
            username: '6cd2bd6552c9c01f4bb75822',
            credential: 'NnRurMddTHIbVDV9',
          },
          {
            urls: 'turns:slocx.metered.live:443?transport=tcp',
            username: '6cd2bd6552c9c01f4bb75822',
            credential: 'NnRurMddTHIbVDV9',
          },
        ],
      },
    });

    this.myPeer.on('open', (userPeerId: string) => {
      socket.emit('joinRoom', { userPeerId, username, room });
    });

    this.myPeer.on('error', (err: any) => {
      console.error('[PEER] error:', err);
    });

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        this.localStream = stream;

        // Show local video in PiP — use setTimeout to wait for ViewChild
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
          this.attachIceDebug(call, call.peer, 'incoming');
        });

        // New user joined — call them
        socket.on('user-connected', (userPeerId: string) => {
          setTimeout(() => {
            this.connectToNewUser(userPeerId, stream);
          }, 1000);
        });
      })
      .catch((err) => {
        console.error('[MEDIA] getUserMedia error:', err);
        this.permissionError = true;
      });

    // Remote user left
    socket.on('user-disconnected', (userId: string) => {
      if (this.peers[userId]) {
        this.peers[userId].close();
        delete this.peers[userId];
      }
      this.removeParticipant(userId);
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

  leaveCall(): void {
    this.stopLocalStream();
    if (this.myPeer) {
      this.myPeer.destroy();
    }
    // Close the tab; fall back to blank page if window.close() is blocked
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

    this.attachIceDebug(call, userId, 'outgoing');
    this.peers[userId] = call;
  }

  private addRemoteStream(
    video: HTMLVideoElement,
    stream: MediaStream,
    userId: string
  ): void {
    const existingTile = document.getElementById('tile-' + userId);
    if (existingTile) {
      // ICE renegotiation fired stream again — pause first to avoid AbortError,
      // then swap srcObject and resume
      video.pause();
      video.srcObject = null;
      video.srcObject = stream;
      video.play().catch(console.error);
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

    // Set stream after element is in DOM, then play
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    video.muted = true; // Start muted — required for autoplay on mobile
    video.srcObject = stream;
    video.play()
      .then(() => {
        // Unmute immediately — works on desktop; silently stays muted on mobile
        video.muted = false;
        if (video.muted) {
          // Still muted (mobile autoplay policy) — show tap-to-unmute on tile
          tile.setAttribute('data-muted', '1');
          tile.title = 'Tap to enable audio';
          tile.style.cursor = 'pointer';
          tile.addEventListener('click', () => {
            video.muted = false;
            tile.removeAttribute('data-muted');
            tile.title = '';
            tile.style.cursor = '';
          }, { once: true });
        }
      })
      .catch(console.error);
  }

  private removeParticipant(userId: string): void {
    const tile = document.getElementById('tile-' + userId);
    if (tile) {
      tile.remove();
      this.remoteCount = Math.max(0, this.remoteCount - 1);
    }
  }

  private attachIceDebug(call: MediaConnection, userId: string, dir: string): void {
    // Wait a tick for PeerJS to create peerConnection internally
    setTimeout(() => {
      const pc: RTCPeerConnection = (call as any).peerConnection;
      if (!pc) {
        console.warn(`[ICE][${dir}][${userId}] peerConnection not available`);
        return;
      }

      pc.oniceconnectionstatechange = () => {
        console.log(`[ICE][${dir}][${userId}] iceConnectionState → ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          console.error(`[ICE][${dir}][${userId}] ICE FAILED — no path could be established. Check TURN server.`);
        }
        if (pc.iceConnectionState === 'disconnected') {
          console.warn(`[ICE][${dir}][${userId}] ICE disconnected — may recover or fail`);
        }
      };

      pc.onicegatheringstatechange = () => {
        console.log(`[ICE][${dir}][${userId}] iceGatheringState → ${pc.iceGatheringState}`);
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          console.log(`[ICE][${dir}][${userId}] candidate gathering complete`);
          return;
        }
        const c = event.candidate;
        console.log(`[ICE][${dir}][${userId}] candidate: type=${c.type} protocol=${c.protocol} address=${c.address}`);
      };

      // Log the selected candidate pair once connected
      pc.onconnectionstatechange = () => {
        console.log(`[ICE][${dir}][${userId}] connectionState → ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          pc.getStats().then((stats) => {
            stats.forEach((report) => {
              if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                const local = (stats as any).get(report.localCandidateId);
                const remote = (stats as any).get(report.remoteCandidateId);
                const localType = local?.candidateType ?? '?';
                const remoteType = remote?.candidateType ?? '?';
                console.log(
                  `[ICE][${dir}][${userId}] ✅ SELECTED PAIR — local: ${localType}, remote: ${remoteType}` +
                  (localType === 'relay' || remoteType === 'relay' ? ' ← TURN relay in use' : ' ← direct/STUN path')
                );
              }
            });
          });
        }
      };
    }, 0);
  }

  private stopLocalStream(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }
  }
}
