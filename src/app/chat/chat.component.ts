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
    // this.videoGrid = document.getElementById('video-grid') as HTMLDivElement;
    // this.myVideo = document.createElement('video');
    // this.myVideo.muted = true;

    this.myPeer = new Peer('', {
      host: 'slocx-0-0-2.onrender.com',
      port: 9000,
      path: `/`,
      secure: true,
    });
    console.log('peer');
    const { username, room } = Qs.parse(location.search, {
      ignoreQueryPrefix: true,
    });

    const socket = io(
      'https://video-call-slocx.onrender.com'
    );

    socket.on('sameName', () => {
      alert(
        'You already joined the call, please disconnect before continuing here.'
      );
      window.history.back();  
    });

    socket.on('roomNotValid', () => {
      alert('Invalid slocx classroom call link!.');
      // window.history.back();
    });

    navigator.mediaDevices
      .getUserMedia({
        video: true,
        audio: true,
      })
      .then((stream) => {
        const video = document.createElement('video');
        video.muted = true;
        this.addVideoStream(video, stream, this.userPeerId);
        console.log('stream 1');

        this.myPeer.on('call', (call) => {
          call.answer(stream);
          const video = document.createElement('video');
          call.on('stream', (userVideoStream) => {
            console.log('caller stream:', userVideoStream)
            this.addVideoStream(video, userVideoStream);
          });
        });

        socket.on('user-connected', ({ userPeerId }) => {
          setTimeout(() => {
            this.connectToNewUser(userPeerId, stream);
          }, 1000);
        });
      });

    socket.on('user-disconnected', (userId) => {
      // console.log('user-disconnected a', this.userPeerId, userId);
      // document.getElementById(userId)?.parentElement?.remove();
      if (this.peers[userId]) {
        console.log('user-disconnected b', userId);
        this.peers[userId].close();
      }
    });

    this.myPeer.on('open', (userPeerId) => {
      this.userPeerId = userPeerId;
      socket.emit('joinRoom', { userPeerId, username, room });
    });

    // this.inputMessage?.nativeElement.addEventListener('input', () => {
    //   this.updateTyping();
    // });

    socket.on('typing', (data) => {
      this.addChatTyping(data);
    });

    socket.on('stop typing', (data) => {
      this.removeChatTyping(data);
    });

    socket.on('roomUsers', ({ room, users }) => {
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

    call.on('stream', (userVideoStream) => {
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
