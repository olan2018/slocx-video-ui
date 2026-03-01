export const environment = {
  production: true,
  apiUrl: 'https://api.slocx.com',
  socketUrl: 'https://video-call-slocx.onrender.com',
  peerHost: 'slocx-0-0-2.onrender.com',
  // TURN server — fallback if backend credential endpoint is unavailable
  turnUrl: 'turn.slocx.com',
  turnUsername: 'slocx',
  turnCredential: 'AdeSlocxunle',
  // turnUsername: "6cd2bd6552c9c01f4bb75822"
  // turnUrl: global.relay.metered.ca:80
  // turnCredential: "NnRurMddTHIbVDV9"
};

// iceServers: [
//   { urls: 'stun:stun.relay.metered.ca:80' },
//   {
//     urls: 'turn:global.relay.metered.ca:80',
//     username: '6cd2bd6552c9c01f4bb75822',
//     credential: 'NnRurMddTHIbVDV9',
//   },
//   {
//     urls: 'turn:global.relay.metered.ca:80?transport=tcp',
//     username: '6cd2bd6552c9c01f4bb75822',
//     credential: 'NnRurMddTHIbVDV9',
//   },
//   {
//     urls: 'turn:global.relay.metered.ca:443',
//     username: '6cd2bd6552c9c01f4bb75822',
//     credential: 'NnRurMddTHIbVDV9',
//   },
//   {
//     urls: 'turns:global.relay.metered.ca:443?transport=tcp',
//     username: '6cd2bd6552c9c01f4bb75822',
//     credential: 'NnRurMddTHIbVDV9',
//   },
// ],