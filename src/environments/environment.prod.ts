export const environment = {
  production: true,
  apiUrl: 'https://api.slocx.com',
  socketUrl: 'https://video.slocx.com',
  peerHost: 'peer.slocx.com',
  // Web frontend base. Class-tool "Materials" iframes
  // slocx.com/materials/:id from here.
  contentsBaseUrl: 'https://slocx.com',
  // TURN — served by Cloudflare via short-lived credentials from
  // `${apiUrl}/v1/turn/credentials`. No standalone TURN URL required
  // in the frontend; the backend proxies + signs everything.
};
