import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { ChatComponent } from './chat/chat.component';
import { LandingComponent } from './landing/landing.component';
import { ClassToolComponent } from './class-tool/class-tool.component';
import { MaterialsDrawerComponent } from './class-tool/materials-drawer.component';
import { VocabDrawerComponent } from './class-tool/vocab-drawer.component';
import { DraggableDirective } from './class-tool/draggable.directive';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { provideFirebaseApp, getApp, initializeApp } from '@angular/fire/app';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';

// NOTE: ngx-socket-io's SocketIoModule was removed. It was spawning a
// SECOND socket connection separate from chat.component's `io(...)`
// socket, and ClassToolSyncService (which used to inject the ngx
// Socket) emitted class-tool events on THAT socket — which never
// called joinRoom, so the server saw an anonymous socket and dropped
// every board:open / material:open / vocab:state silently. The
// service now takes chat's own socket via bindSocket(); we only ever
// have one connection.


@NgModule({
  declarations: [
    AppComponent,
    ChatComponent,
    LandingComponent,
    ClassToolComponent,
    MaterialsDrawerComponent,
    VocabDrawerComponent,
    DraggableDirective,
  ],
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
    provideFirestore(() => getFirestore()),
  ],
  providers: [],
  bootstrap: [AppComponent],
})
export class AppModule {}
