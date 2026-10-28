/* Chat Plays Tetris – networking.
 * Online: the OBS overlay is the "host" peer (PeerJS / WebRTC, free public broker + TURN),
 *         every player connects directly to it. No server of your own is needed.
 * Local test mode (?local on both pages): BroadcastChannel between tabs of one browser. */
(function (root) {
  'use strict';
  const PREFIX = 'chatplaystetris-v1-';

  function cleanRoom(r) { return String(r || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32); }

  // ---------------- host (overlay) ----------------
  function hostPeer(room, h) {
    const conns = new Map();
    let peer = null, n = 0;
    function start() {
      h.onStatus('connecting');
      peer = new Peer(PREFIX + room, { debug: 0 });
      peer.on('open', () => h.onStatus('online'));
      peer.on('connection', conn => {
        const id = 'c' + (++n);
        conn.on('open', () => { conns.set(id, conn); h.onOpen(id); });
        conn.on('data', d => h.onMessage(id, d));
        conn.on('close', () => { if (conns.get(id) === conn) { conns.delete(id); h.onClose(id); } });
        conn.on('error', () => {});
      });
      peer.on('disconnected', () => {
        h.onStatus('reconnecting');
        setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
      });
      peer.on('error', e => {
        if (e.type === 'unavailable-id') {
          h.onStatus('id-taken');
          peer.destroy(); setTimeout(start, 4000);
        } else if (e.type === 'peer-unavailable') {
          /* ignore */
        } else {
          h.onStatus('error:' + e.type);
          if (peer.destroyed) setTimeout(start, 4000);
        }
      });
    }
    start();
    return {
      send(id, m) { const c = conns.get(id); if (c && c.open) try { c.send(m); } catch (e) { } },
      drop(id) { const c = conns.get(id); conns.delete(id); if (c) try { c.close(); } catch (e) { } },
    };
  }

  function hostLocal(room, h) {
    const bc = new BroadcastChannel(PREFIX + room);
    const known = new Set();
    bc.onmessage = e => {
      const d = e.data || {};
      if (!d.from || !d.m) return;
      if (d.m.t === 'bye') { if (known.delete(d.from)) h.onClose(d.from); return; }
      if (!known.has(d.from)) { known.add(d.from); h.onOpen(d.from); }
      h.onMessage(d.from, d.m);
    };
    setTimeout(() => h.onStatus('online'), 0);
    return {
      send(id, m) { bc.postMessage({ to: id, m }); },
      drop(id) { known.delete(id); },
    };
  }

  // ---------------- client (player) ----------------
  function clientPeer(room, h) {
    const hostId = PREFIX + room;
    let peer = null, conn = null, timer = null;
    function schedule(ms = 3000) { clearTimeout(timer); timer = setTimeout(connect, ms); }
    function connect() {
      clearTimeout(timer);
      if (!peer || peer.destroyed) return;
      if (peer.disconnected || !peer.open) { schedule(); return; }
      if (conn) { const old = conn; conn = null; try { old.close(); } catch (e) { } }
      const c = peer.connect(hostId, { reliable: true, serialization: 'json' });
      conn = c;
      let opened = false;
      const slow = setTimeout(() => {
        if (!opened && conn === c) { h.onStatus('Still connecting… (retrying)'); try { c.close(); } catch (e) { } schedule(500); }
      }, 15000);
      c.on('open', () => { opened = true; clearTimeout(slow); h.onOpen(); });
      c.on('data', d => h.onMessage(d));
      c.on('close', () => { clearTimeout(slow); if (conn !== c) return; conn = null; if (opened) h.onClose(); schedule(); });
      c.on('error', () => {});
    }
    peer = new Peer({ debug: 0 });
    peer.on('open', () => connect());
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') {
        h.onStatus('Room "' + room + '" was not found. Is the stream overlay running and the room code right? Retrying…');
        schedule(4000);
      } else if (e.type === 'browser-incompatible') {
        h.onStatus('Your browser does not support WebRTC. Please use a current Chrome, Firefox, Edge or Safari.');
      } else {
        h.onStatus('Connection problem (' + e.type + '), retrying…');
        schedule(4000);
      }
    });
    peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000));
    return { send(m) { if (conn && conn.open) try { conn.send(m); } catch (e) { } } };
  }

  function clientLocal(room, h) {
    const id = 'L' + Math.random().toString(36).slice(2, 10);
    const bc = new BroadcastChannel(PREFIX + room);
    bc.onmessage = e => { const d = e.data || {}; if (d.to === id || d.to === '*') h.onMessage(d.m); };
    addEventListener('pagehide', () => bc.postMessage({ from: id, m: { t: 'bye' } }));
    setTimeout(() => h.onOpen(), 50);
    return { send(m) { bc.postMessage({ from: id, m }); } };
  }

  function needPeer() {
    if (typeof Peer === 'undefined') throw new Error('PeerJS failed to load (check your internet connection / ad blocker).');
  }

  root.Net = {
    cleanRoom,
    createHost(room, local, h) { if (local) return hostLocal(room, h); needPeer(); return hostPeer(room, h); },
    createClient(room, local, h) { if (local) return clientLocal(room, h); needPeer(); return clientPeer(room, h); },
  };
})(window);
