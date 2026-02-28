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

    const socket = io('https://video-call-slocx.onrender.com');

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
      host: 'slocx-0-0-2.onrender.com',
      path: '/',
      secure: true,
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
          call.on('stream', (remoteStream: MediaStream) => {
            this.addRemoteStream(video, remoteStream, call.peer);
          });
          call.on('close', () => {
            this.removeParticipant(call.peer);
          });
          call.on('error', (err: any) => {
            console.error('[PEER] call error:', err);
          });
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

    call.on('stream', (remoteStream: MediaStream) => {
      this.addRemoteStream(video, remoteStream, userId);
    });
    call.on('close', () => {
      this.removeParticipant(userId);
    });
    call.on('error', (err: any) => {
      console.error('[PEER] outgoing call error:', err);
    });

    this.peers[userId] = call;
  }

  private addRemoteStream(
    video: HTMLVideoElement,
    stream: MediaStream,
    userId: string
  ): void {
    // Don't add duplicate tile for the same peer
    if (document.getElementById('tile-' + userId)) return;

    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.addEventListener('loadedmetadata', () => {
      video.play().catch(() => {});
    });

    const tile = document.createElement('div');
    tile.classList.add('meet-video-tile');
    tile.id = 'tile-' + userId;
    tile.append(video);

    if (this.videoGrid?.nativeElement) {
      this.videoGrid.nativeElement.append(tile);
      this.remoteCount++;
    }
  }

  private removeParticipant(userId: string): void {
    const tile = document.getElementById('tile-' + userId);
    if (tile) {
      tile.remove();
      this.remoteCount = Math.max(0, this.remoteCount - 1);
    }
  }

  private stopLocalStream(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }
  }
}
