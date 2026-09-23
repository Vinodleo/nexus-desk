// socket.io-client is pinned to 2.4.0 (CoinDCX's stream speaks Socket.IO v2),
// which ships no type definitions. This covers the surface server.ts uses.
declare module "socket.io-client" {
  interface Socket {
    on(event: string, listener: (...args: any[]) => void): Socket;
    emit(event: string, ...args: any[]): Socket;
    close(): Socket;
    connected: boolean;
  }
  interface ConnectOpts {
    transports?: string[];
    reconnection?: boolean;
    [key: string]: unknown;
  }
  function io(uri: string, opts?: ConnectOpts): Socket;
  export default io;
}
