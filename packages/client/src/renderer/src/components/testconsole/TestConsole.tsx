// Feature test console: a plain page that exercises each feature against the real server, through the same code paths
// the app uses, and says in words what passed and what failed. Not styled on purpose; it is for checking a server.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Track, type Participant } from 'livekit-client';
import type { Message, ServerFrame } from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import { onFrame } from '../../api/ws';
import { decryptBlob, decryptMessage, encryptPayload, getDevice, onKeysChanged } from '../../crypto';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import { micLevel } from '../../state/voiceAudio';
import { uploadAttachment } from '../media';
import ShareControls from '../voice/ShareControls';
import { WatchPartyPanel } from '../watchparty';
import './testconsole.css';

type Outcome = 'pass' | 'fail' | 'info';
interface LogLine { id: number; at: number; area: string; outcome: Outcome; text: string }

let nextLine = 1;

function errText(e: unknown): string {
  if (e instanceof ApiError) return `HTTP ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** One test: returns a short pass line, or throws with the reason it failed. */
type Check = () => Promise<string>;

export default function TestConsole({ onClose }: { onClose: () => void }): ReactElement {
  const servers = useSession((s) => s.servers);
  const serverUrl = useSession((s) => s.serverUrl);
  const user = useSession((s) => s.user);
  const activeServerId = useSession((s) => s.activeServerId);
  const [serverId, setServerId] = useState<string>(activeServerId ?? servers[0]?.server.id ?? '');
  const bundle = servers.find((b) => b.server.id === serverId);
  const textChannels = bundle?.channels.filter((c) => c.kind === 'text') ?? [];
  const voiceChannels = bundle?.channels.filter((c) => c.kind === 'voice') ?? [];
  const [textId, setTextId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const text = textChannels.find((c) => c.id === textId) ?? textChannels[0];
  const voiceChannel = voiceChannels.find((c) => c.id === voiceId) ?? voiceChannels[0];

  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const add = (area: string, outcome: Outcome, line: string) =>
    setLog((l) => [...l.slice(-199), { id: nextLine++, at: Date.now(), area, outcome, text: line }]);

  const run = async (area: string, check: Check) => {
    setRunning(area);
    try {
      add(area, 'pass', await check());
    } catch (e) {
      add(area, 'fail', errText(e));
    } finally {
      setRunning(null);
    }
  };

  // Every socket frame, so a second PC's actions can be seen arriving.
  const [frames, setFrames] = useState<{ id: number; at: number; t: string; detail: string }[]>([]);
  useEffect(() => onFrame((f: ServerFrame) => {
    const { t, ...rest } = f as ServerFrame & Record<string, unknown>;
    const detail = JSON.stringify(rest, (k, v) => (k === 'ciphertext' && typeof v === 'string' ? `${v.slice(0, 16)}… (${v.length} chars)` : v));
    setFrames((l) => [...l.slice(-99), { id: nextLine++, at: Date.now(), t, detail: detail.slice(0, 240) }]);
  }), []);

  // ---- checks ----

  const checkHealth: Check = async () => {
    const t0 = performance.now();
    const health = await api.get<{ ok: boolean }>('/api/health');
    const ms = Math.round(performance.now() - t0);
    if (!health.ok) throw new Error('/api/health did not say ok');
    const v = await api.get<{ serverVersion: string; minClientVersion: string; latestClientVersion: string | null }>('/api/version');
    return `Server answered in ${ms} ms. Server ${v.serverVersion}, min client ${v.minClientVersion}, latest installer ${v.latestClientVersion ?? 'none'}`;
  };

  const checkAccount: Check = async () => {
    const { user: me } = await api.get<{ user: { username: string; displayName: string } }>('/api/me');
    const { devices } = await api.get<{ devices: { deviceId: string }[] }>('/api/me/devices');
    const mine = getDevice().deviceId;
    if (!devices.some((d) => d.deviceId === mine)) throw new Error(`This PC's device ${mine} is not registered to the account`);
    return `Signed in as ${me.displayName} (@${me.username}). ${devices.length} device(s); this PC is one of them`;
  };

  const checkServers: Check = async () => {
    const res = await api.get<{ servers: { server: { name: string }; channels: unknown[]; members: unknown[] }[] }>('/api/servers');
    if (res.servers.length === 0) throw new Error('No servers yet. Create one from the sidebar');
    return res.servers.map((b) => `${b.server.name}: ${b.channels.length} channels, ${b.members.length} members`).join('; ');
  };

  const checkInvite: Check = async () => {
    if (!bundle) throw new Error('Pick a server first');
    const { code, expiresAt } = await api.post<{ code: string; expiresAt: number }>(`/api/servers/${bundle.server.id}/invites`, {});
    return `Invite code ${code} (single use, expires ${new Date(expiresAt).toLocaleString()}). Use it to register a second account`;
  };

  const checkE2ee: Check = async () => {
    if (!user || !text) throw new Error('Pick a server with a text channel first');
    const nonce = `chatward test ${Math.random().toString(36).slice(2, 10)}`;
    const { ciphertext, keyVersion } = await encryptPayload(text.id, user.id, { text: `🧪 ${nonce}` });
    const { message } = await api.post<{ message: Message }>(`/api/channels/${text.id}/messages`, {
      ciphertext, keyVersion, attachmentIds: [], clientId: crypto.randomUUID(),
    });
    // Read it back the way another member would: as stored by the server.
    const { messages } = await api.get<{ messages: Message[] }>(`/api/channels/${text.id}/messages?limit=20`);
    const stored = messages.find((m) => m.id === message.id);
    if (!stored) throw new Error('Sent, but the message is missing from the channel history');
    if (stored.ciphertext.includes(nonce) || atob(stored.ciphertext).includes(nonce)) throw new Error('The server copy contains the plain text');
    const opened = await decryptMessage(stored);
    if (opened?.text !== `🧪 ${nonce}`) throw new Error('Could not decrypt the stored copy');
    return `Sent "${nonce}" to #${text.name} with key version ${keyVersion}. The server copy is ciphertext only and decrypts back. Other members should see it appear`;
  };

  const checkUpload: Check = async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const att = await uploadAttachment(new File([bytes], 'test.bin', { type: 'application/octet-stream' }));
    const blob = new Uint8Array(await api.getBytes(`/api/uploads/${att.uploadId}`));
    if (blob.length === bytes.length) throw new Error('The stored blob is the same size as the plain file, so it may not be encrypted');
    const back = await decryptBlob(blob, att.key, att.iv);
    if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) throw new Error('Downloaded file does not match after decrypting');
    return `Uploaded 64 KB encrypted (${blob.length} bytes stored), downloaded and decrypted it byte for byte`;
  };

  const checkGifs: Check = async () => {
    const res = await api.get<{ results: unknown[]; disabled?: boolean }>('/api/gifs/trending');
    if (res.disabled) return 'GIFs are off on this server (no KLIPY_API_KEY). That is fine';
    return `GIF trending returned ${res.results.length} results`;
  };

  const checkLinkPreview: Check = async () => {
    // The server must refuse to fetch addresses on the home network, so it cannot be used to probe the LAN.
    try {
      await api.get(`/api/linkpreview?url=${encodeURIComponent('http://192.168.1.1/')}`);
      throw new Error('The server fetched a private LAN address (192.168.1.1). Link previews must refuse those');
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    try {
      const res = await api.get<{ title?: string }>(`/api/linkpreview?url=${encodeURIComponent('https://example.com/')}`);
      return `LAN address refused, as it should be. Preview of example.com: "${res.title ?? '(no title)'}"`;
    } catch (e) {
      throw new Error(`LAN address refused (good), but a public page failed: ${errText(e)}. Can the server reach the internet?`);
    }
  };

  const checkSoundboard: Check = async () => {
    if (!bundle) throw new Error('Pick a server first');
    const { sounds } = await api.get<{ sounds: unknown[] }>(`/api/servers/${bundle.server.id}/sounds`);
    return `${sounds.length} soundboard clip(s) on ${bundle.server.name}`;
  };

  const checkVoiceToken: Check = async () => {
    if (!bundle) throw new Error('Pick a server first');
    const { channels } = await api.get<{ channels: Record<string, string[]> }>(`/api/servers/${bundle.server.id}/voice-state`);
    const inCalls = Object.values(channels).reduce((n, ids) => n + ids.length, 0);
    return `${inCalls} people in voice on ${bundle.server.name} right now`;
  };

  const quick: [string, Check][] = [
    ['Connection', checkHealth], ['Account', checkAccount], ['Servers', checkServers],
    ['Text chat (E2EE)', checkE2ee], ['Uploads', checkUpload], ['GIFs', checkGifs],
    ['Link previews', checkLinkPreview], ['Soundboard', checkSoundboard], ['Voice state', checkVoiceToken],
  ];
  const runAll = async () => {
    for (const [area, check] of quick) await run(area, check);
  };

  // Keys can arrive a moment after sign-in, so say when they do.
  const [keysTick, setKeysTick] = useState(0);
  useEffect(() => onKeysChanged(() => setKeysTick((n) => n + 1)), []);

  const fmt = (t: number) => new Date(t).toLocaleTimeString();
  const passes = log.filter((l) => l.outcome === 'pass').length;
  const fails = log.filter((l) => l.outcome === 'fail').length;

  return (
    <div className="cw-test">
      <header>
        <h1>Feature test console</h1>
        <button type="button" onClick={onClose}>Close</button>
      </header>
      <p className="muted">
        Server <code>{serverUrl}</code> · signed in as <b>{user?.displayName}</b> · key updates seen: {keysTick}.
        Each button calls the real server through the app's own code. Run it on two PCs (or two profiles) to check delivery between people.
      </p>

      <section>
        <h2>Target</h2>
        <label>Server{' '}
          <select value={serverId} onChange={(e) => { setServerId(e.target.value); setTextId(''); setVoiceId(''); }}>
            {servers.length === 0 && <option value="">(none, create one first)</option>}
            {servers.map((b) => <option key={b.server.id} value={b.server.id}>{b.server.name}</option>)}
          </select>
        </label>{' '}
        <label>Text channel{' '}
          <select value={text?.id ?? ''} onChange={(e) => setTextId(e.target.value)}>
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>{' '}
        <label>Voice channel{' '}
          <select value={voiceChannel?.id ?? ''} onChange={(e) => setVoiceId(e.target.value)}>
            {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </section>

      <section>
        <h2>1. Server, account and text checks</h2>
        <div className="cw-test-buttons">
          <button type="button" className="primary" disabled={running !== null} onClick={() => void runAll()}>Run all</button>
          {quick.map(([area, check]) => (
            <button key={area} type="button" disabled={running !== null} onClick={() => void run(area, check)}>{area}</button>
          ))}
          <button type="button" disabled={running !== null} onClick={() => void run('Invite', checkInvite)}>Make invite code</button>
        </div>
        <p className="muted">{running ? `Running ${running}…` : `${passes} passed, ${fails} failed`}</p>
        <ol className="cw-test-log">
          {log.map((l) => (
            <li key={l.id} className={`cw-${l.outcome}`}>
              <span>{fmt(l.at)}</span> <b>{l.outcome === 'pass' ? 'PASS' : l.outcome === 'fail' ? 'FAIL' : 'INFO'}</b> {l.area}: {l.text}
            </li>
          ))}
        </ol>
        {log.length > 0 && <button type="button" onClick={() => setLog([])}>Clear results</button>}
      </section>

      <VoiceSection serverId={bundle?.server.id} channelId={voiceChannel?.id} channelName={voiceChannel?.name} />

      <WatchSection />

      <section>
        <h2>6. Live socket frames</h2>
        <p className="muted">What the server pushes to this PC. Messages, typing, voice joins and watch-party syncs from other people show up here.</p>
        <ol className="cw-test-log">
          {frames.map((f) => <li key={f.id}><span>{fmt(f.at)}</span> <b>{f.t}</b> {f.detail}</li>)}
        </ol>
      </section>
    </div>
  );
}

/** Voice, camera and screen share, using the app's call store so it is the same call as the normal UI. */
function VoiceSection({ serverId, channelId, channelName }: { serverId?: string; channelId?: string; channelName?: string }): ReactElement {
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const notice = useVoice((s) => s.notice);
  const callId = useVoice((s) => s.channelId);
  const room = useVoice((s) => s.room);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const speaking = useVoice((s) => s.speaking);
  useVoice((s) => s.version);
  const { join, leave, toggleMute, toggleDeafen } = useVoice.getState();
  const members = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members);
  const nameOf = (id: string) => members?.find((m) => m.user.id === id)?.user.displayName ?? id;

  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (status !== 'connected') { setLevel(0); return; }
    const t = setInterval(() => setLevel(micLevel()), 100);
    return () => clearInterval(t);
  }, [status]);

  const participants: Participant[] = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
  const inThisCall = callId !== null && callId === channelId;

  return (
    <>
      <section>
        <h2>2. Voice</h2>
        <div className="cw-test-buttons">
          <button type="button" className="primary" disabled={!serverId || !channelId || status === 'connecting' || inThisCall}
            onClick={() => serverId && channelId && void join(serverId, channelId)}>
            Join {channelName ?? 'voice'}
          </button>
          <button type="button" disabled={callId === null} onClick={() => void leave()}>Leave call</button>
          <button type="button" disabled={status !== 'connected'} onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
          <button type="button" disabled={status !== 'connected'} onClick={toggleDeafen}>{deafened ? 'Undeafen' : 'Deafen'}</button>
        </div>
        <p>
          Status: <b>{status}</b>
          {error && <span className="cw-fail"> · {error}</span>}
          {notice && <span className="muted"> · {notice}</span>}
          {room && <> · E2EE {room.isE2EEEnabled ? <b className="cw-pass">on</b> : <b className="cw-fail">off</b>}</>}
        </p>
        {status === 'connected' && (
          <p>Your mic level: <meter min={0} max={0.3} value={level} /> {muted ? '(muted)' : 'speak to see it move'}</p>
        )}
        {participants.length > 0 && (
          <table className="cw-test-table">
            <thead><tr><th>Person</th><th>Mic</th><th>Speaking</th><th>Camera</th><th>Screen</th><th>Connection</th></tr></thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.identity}>
                  <td>{nameOf(p.identity)}{p === room?.localParticipant ? ' (you)' : ''}</td>
                  <td>{p.isMicrophoneEnabled ? 'on' : 'off'}</td>
                  <td>{speaking.includes(p.identity) ? 'yes' : ''}</td>
                  <td>{p.isCameraEnabled ? 'on' : 'off'}</td>
                  <td>{p.isScreenShareEnabled ? 'on' : 'off'}</td>
                  <td>{p.connectionQuality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">Pass: a second person joins, you each hear the other, the speaking column follows who talks, and E2EE says on.</p>
      </section>

      <section>
        <h2>3–4. Video and screen share</h2>
        <ShareControls />
        <p className="muted">Join the call first. Camera and Share use the same picker and quality settings as the normal call view.</p>
        <div className="cw-test-videos">
          {participants.flatMap((p) => [Track.Source.Camera, Track.Source.ScreenShare].map((source) => {
            const pub = p.getTrackPublication(source);
            const track = pub && !pub.isMuted ? pub.track : undefined;
            return track ? <VideoTile key={`${p.identity}:${source}`} track={track} label={`${nameOf(p.identity)} · ${source === Track.Source.Camera ? 'camera' : 'screen'}`} /> : null;
          }))}
        </div>
      </section>
    </>
  );
}

function VideoTile({ track, label }: { track: Track; label: string }): ReactElement {
  const ref = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    const t = setInterval(() => { if (el.videoWidth) setSize(`${el.videoWidth}×${el.videoHeight}`); }, 1000);
    return () => { clearInterval(t); track.detach(el); };
  }, [track]);
  return (
    <figure>
      <video ref={ref} autoPlay muted playsInline />
      <figcaption>{label} {size && `· ${size}`}</figcaption>
    </figure>
  );
}

/** The real watch-party panel for the current call, plus the raw snapshot the server holds. */
function WatchSection(): ReactElement {
  const callId = useVoice((s) => s.channelId);
  const servers = useSession((s) => s.servers);
  const call = servers.find((b) => b.channels.some((c) => c.id === callId));
  const keyChannelId = call?.channels.find((c) => c.kind === 'text')?.id;
  const [snapshot, setSnapshot] = useState<string>('');

  const readSnapshot = async () => {
    if (!callId) return;
    try {
      const res = await api.get<{ state: { keyVersion: number; authorId: string; ts: number } | null }>(`/api/channels/${callId}/watch`);
      setSnapshot(res.state ? `Server snapshot: key version ${res.state.keyVersion}, set ${new Date(res.state.ts).toLocaleTimeString()} (encrypted, the server cannot read it)` : 'Server has no snapshot for this call yet');
    } catch (e) {
      setSnapshot(`FAIL ${errText(e)}`);
    }
  };

  return (
    <section>
      <h2>5. YouTube watch party</h2>
      {callId && keyChannelId ? (
        <>
          <p className="muted">Paste a YouTube link below. Pass: everyone in the call sees the same video, and play, pause and seek follow along within a second.</p>
          <WatchPartyPanel key={callId} callChannelId={callId} keyChannelId={keyChannelId} />
          <p><button type="button" onClick={() => void readSnapshot()}>Read server snapshot</button> {snapshot}</p>
        </>
      ) : <p className="muted">Join a voice channel in section 2 first. A watch party belongs to a call.</p>}
    </section>
  );
}

