import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { ChatComponent } from './chat/chat.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { provideFirebaseApp, getApp, initializeApp } from '@angular/fire/app';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';
import { SocketIoModule, SocketIoConfig } from 'ngx-socket-io';



const config: SocketIoConfig = { url: 'http://localhost:4000', options: {} };


@NgModule({
  declarations: [AppComponent, ChatComponent],
  imports: [
    BrowserModule,
    FormsModule,
    AppRoutingModule,
    BrowserAnimationsModule,
    MatGridListModule,
    MatSidenavModule,
    MatToolbarModule,
    provideFirebaseApp(() =>
      initializeApp({
        apiKey: 'AIzaSyDBepPJW0o9sJ_sV0qmKqpwrgFyVEAZO3Y',
        authDomain: 'slocx-9b4cb.firebaseapp.com',
        projectId: 'slocx-9b4cb',
        storageBucket: 'slocx-9b4cb.appspot.com',
        messagingSenderId: '6346900164',
        appId: '1:6346900164:web:5c70e7ccde53c2941b7f91',
        measurementId: 'G-8M7V8KE71S',
      })
    ),
    SocketIoModule.forRoot(config),
    provideFirestore(() => getFirestore()),
  ],
  providers: [],
  bootstrap: [AppComponent],
})
export class AppModule {}
