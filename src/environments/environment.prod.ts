export const environment = {
  production: true,
  apiUrl: 'https://api.slocx.com',
  socketUrl: 'https://video.slocx.com',
  peerHost: 'peer.slocx.com',
  // TURN — served by Cloudflare via short-lived credentials from
  // `${apiUrl}/v1/turn/credentials`. No standalone TURN URL required
  // in the frontend; the backend proxies + signs everything.
};
