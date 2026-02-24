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


interface IKoshatishise {
   
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
})
export class ChatComponent implements OnInit, OnDestroy {
  // @ViewChild('chatForm') chatForm!: ElementRef;
  // @ViewChild('chatMessages') chatMessages!: ElementRef;
  // @ViewChild('roomName') roomName!: ElementRef;
  // @ViewChild('userList') userList!: ElementRef;
  @ViewChild('videos') videoGrid!: ElementRef;
  // @ViewChild('myVideo') myVideo!: ElementRef;
  // @ViewChild('inputMessage') inputMessage!: ElementRef;
  localVideoActive: boolean = true;
  inCall: boolean = false;
  // const peer = new Peer("pick-an-id");

  videos: {
    name: string;
    videostream: any;
  }[] = [];

  TYPING_TIMER_LENGTH: number = 400;
  myPeer!: Peer;
  peers: { [key: string]: MediaConnection } = {};
  typing: boolean = false;
  lastTypingTime: number = 0;
  userPeerId: string = '';

  constructor() {}

  ngOnInit(): void {
    const { user: username, room } = Qs.parse(location.search, {
      ignoreQueryPrefix: true,
    });
    console.log('[INIT] parsed query params — username:', username, '| room:', room);

    this.myPeer = new Peer('', {
      host: 'slocx-0-0-2.onrender.com',
      path: '/',
      secure: true,
    });
    console.log('[PEER] Peer instance created');

    this.myPeer.on('open', (userPeerId: string) => {
      this.userPeerId = userPeerId;
      console.log('[PEER] open — my peerId:', userPeerId);
      console.log('[SOCKET] emitting joinRoom:', { userPeerId, username, room });
      socket.emit('joinRoom', { userPeerId, username, room });
    });

    this.myPeer.on('error', (err: any) => {
      console.error('[PEER] error:', err);
    });

    const socket = io('https://video-call-slocx.onrender.com');

    socket.on('connect', () => {
      console.log('[SOCKET] connected — socketId:', socket.id);
    });

    socket.on('disconnect', (reason: string) => {
      console.warn('[SOCKET] disconnected — reason:', reason);
    });

    socket.on('connect_error', (err: Error) => {
      console.error('[SOCKET] connect_error:', err.message);
    });

    socket.on('sameName', () => {
      console.warn('[SOCKET] sameName — already in call');
      alert(
        'You already joined the call, please disconnect before continuing here.'
      );
      window.history.back();
    });

    socket.on('roomNotValid', () => {
      console.warn('[SOCKET] roomNotValid — room:', room);
      alert('Invalid slocx classroom call link!.');
    });

    socket.on('doNotBelongToClass', () => {
      console.warn('[SOCKET] doNotBelongToClass — username:', username, '| room:', room);
      alert('You do not belong to this class.');
    });

    navigator.mediaDevices
      .getUserMedia({
        video: true,
        audio: true,
      })
      .then((stream) => {
        console.log('[MEDIA] getUserMedia success — stream id:', stream.id);
        const video = document.createElement('video');
        video.muted = true;
        this.addVideoStream(video, stream, this.userPeerId);

        this.myPeer.on('call', (call: MediaConnection) => {
          console.log('[PEER] incoming call from:', call.peer);
          call.answer(stream);
          console.log('[PEER] answered call from:', call.peer);
          const video = document.createElement('video');
          call.on('stream', (userVideoStream: MediaStream) => {
            console.log('[PEER] incoming call stream received from:', call.peer, '| stream id:', userVideoStream.id);
            this.addVideoStream(video, userVideoStream);
          });
          call.on('error', (err: any) => {
            console.error('[PEER] incoming call error from:', call.peer, err);
          });
          call.on('close', () => {
            console.log('[PEER] incoming call closed from:', call.peer);
          });
        });

        socket.on('user-connected', (userPeerId: string) => {
          console.log('[SOCKET] user-connected — remote peerId:', userPeerId);
          setTimeout(() => {
            console.log('[SOCKET] calling connectToNewUser after delay — remote peerId:', userPeerId);
            this.connectToNewUser(userPeerId, stream);
          }, 1000);
        });
      })
      .catch((err) => {
        console.error('[MEDIA] getUserMedia error:', err);
      });

    socket.on('user-disconnected', (userId: string) => {
      console.log('[SOCKET] user-disconnected — peerId:', userId);
      if (this.peers[userId]) {
        this.peers[userId].close();
      } else {
        console.warn('[SOCKET] user-disconnected — no peer found for:', userId);
      }
    });

    // this.inputMessage?.nativeElement.addEventListener('input', () => {
    //   this.updateTyping();
    // });

    socket.on('typing', (data: any) => {
      this.addChatTyping(data);
    });

    socket.on('stop typing', (data: any) => {
      this.removeChatTyping(data);
    });

    socket.on('roomUsers', ({ room, users }: { room: any; users: any }) => {
      this.outputRoomName(room);
      this.outputUsers(users);
    });

    // socket.on('message', (message) => {
    //   console.log(message);
    //   this.outputMessage(message);
    //   this.chatMessages.nativeElement.scrollTop =
    //     this.chatMessages?.nativeElement.scrollHeight;
    // });
  }

  ngOnDestroy(): void {
    // Clean up code or unsubscribe from observables if needed
  }

  connectToNewUser(userId: string, stream: MediaStream): void {
    const call = this.myPeer.call(userId, stream);
    const video = document.createElement('video');

    call.on('stream', (userVideoStream: MediaStream) => {
      console.log('stream 3', userVideoStream);
      this.addVideoStream(video, userVideoStream, userId);
    });
    call.on('close', () => {
      // video.remove()
      console.log('a-a-a-a- colse');
      video.parentElement?.remove();
    });

    this.peers[userId] = call;
  }

  addVideoStream(
    video: HTMLVideoElement,
    stream: MediaStream,
    userId?: string
  ): void {
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
      video.play();
    });
    const videocontainer = document.createElement('div');
    videocontainer.classList.add('video-participant');
    // if (userId) {
    //   videocontainer.id = userId;
    // }
    videocontainer.append(video);
    this.videoGrid.nativeElement.append(videocontainer);
  }

  updateTyping(): void {
    if (!this.typing) {
      this.typing = true;
      // Emit typing event to server
    }
    this.lastTypingTime = new Date().getTime();

    setTimeout(() => {
      const typingTimer = new Date().getTime();
      const timeDiff = typingTimer - this.lastTypingTime;
      if (timeDiff >= this.TYPING_TIMER_LENGTH && this.typing) {
        // Emit stop typing event to server
        this.typing = false;
      }
    }, this.TYPING_TIMER_LENGTH);
  }

  addChatTyping(data: any): void {
    data.typing = true;
    data.message = ' is typing..';
    // Add typing message to UI
  }

  removeChatTyping(data: any): void {
    const typingElement = document.getElementsByClassName('typing');
    while (typingElement.length > 0) {
      typingElement[0].remove();
    }
  }

  outputMessage(message: any): void {
    // Output message to UI    
  }

  outputRoomName(room: any): void {
    // Output room name to UI
  }

  outputUsers(users: any): void {
    // Output user list to UI 
  }

  sendMessage(): void {
    // Send message to server  
  }

  onSubmit(): void {
    // Handle form submission
  }
}
