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
import { SocketIoModule, SocketIoConfig } from 'ngx-socket-io';
import { environment } from '../environments/environment';



// Point ngx-socket-io at the same signaling server the rest of the app
// uses (chat.component.ts also does `io(environment.socketUrl)`).
// Hardcoded 'http://localhost:4000' was a dev leftover — in prod it
// hits meet.slocx.com's browser and fails with ERR_CONNECTION_REFUSED,
// which silently breaks every class-tool sync event.
const config: SocketIoConfig = { url: environment.socketUrl, options: {} };


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
    SocketIoModule.forRoot(config),
    provideFirestore(() => getFirestore()),
  ],
  providers: [],
  bootstrap: [AppComponent],
})
export class AppModule {}
