// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  apiUrl: 'https://api.slocx.com',
  socketUrl: 'https://video.slocx.com',
  peerHost: 'peer.slocx.com',
  // Web frontend base. Class-tool "Materials" opens content by iframing
  // slocx.com/materials/:id inside the tool popup — this is where that
  // URL is rooted. Keep in sync with the actual slocx-frontend host.
  contentsBaseUrl: 'https://slocx.com',
  // TURN — served by Cloudflare via short-lived credentials from
  // `${apiUrl}/v1/turn/credentials`. No standalone TURN URL required
  // in the frontend; the backend proxies + signs everything.
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
