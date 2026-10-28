// One device, run as its own node process and driven by run.ts over JSON lines on stdin/stdout.
// Each command runs the real app modules (crypto/index.ts, api/http.ts, state/session.ts).
import './shim';
import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { api } from '../../src/renderer/src/api/http';
import {
  accountKey, decryptBlob, decryptMessage, encryptBlob, encryptPayload, getDevice, initDevice, syncChannelKeys,
} from '../../src/renderer/src/crypto';
import { useSession, type ServerBundle } from '../../src/renderer/src/state/session';
import { secureStoreContents } from './shim';

const PASSWORD = 'correct-horse-1';
let accountId = '';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Message { id: string; channelId: string; authorId: string; keyVersion: number; ciphertext: string }
interface Attachment { uploadId: string; name: string; mime: string; size: number; key: string; iv: string }

const handlers: Record<string, (args: any) => Promise<unknown>> = {
  async init({ serverUrl, username }) {
    useSession.setState({ serverUrl });
    accountId = accountKey(serverUrl, username);
    const device = await initDevice(accountId);
    return { deviceId: device.deviceId };
  },

  async register({ username, inviteCode }) {
    const body = { username, displayName: username, password: PASSWORD, device: getDevice(), inviteCode };
    const r = await api.post<{ token: string; user: { id: string } }>('/api/auth/register', body);
    useSession.setState({ token: r.token, user: r.user as never });
    return { userId: r.user.id };
  },

  async createServer({ name }) {
    const r = await api.post<{ server: { id: string }; channels: { id: string; name: string; kind: string }[] }>('/api/servers', { name });
    const general = r.channels.find((c) => c.name === 'general' && c.kind === 'text')!;
    return { serverId: r.server.id, channelId: general.id };
  },

  async invite({ serverId }) {
    const r = await api.post<{ code: string }>(`/api/servers/${serverId}/invites`, { maxUses: 3 });
    return { code: r.code };
  },

  async sync() {
    const { servers } = await api.get<{ servers: ServerBundle[] }>('/api/servers');
    useSession.getState().setServers(servers);
    await syncChannelKeys(servers);
    return {};
  },

  async kick({ serverId, userId }) {
    await api.del(`/api/servers/${serverId}/members/${userId}`);
    return {};
  },

  /** Epoch of this device's view of the channel group, read from the vault it persisted. */
  async status({ channelId }) {
    const vault = JSON.parse(secureStoreContents.get(`crypto.vault.v2|${accountId}`) ?? '{}');
    return { epoch: vault.groups?.[channelId]?.epoch ?? null };
  },

  async send({ channelId, text }) {
    const sealed = await encryptPayload(channelId, useSession.getState().user!.id, { text });
    await api.post(`/api/channels/${channelId}/messages`, sealed);
    return {};
  },

  /** Decrypts every message in the channel. null marks a message this device cannot read. */
  async read({ channelId }) {
    const { messages } = await api.get<{ messages: Message[] }>(`/api/channels/${channelId}/messages`);
    const texts: (string | null)[] = [];
    for (const m of messages) texts.push((await decryptMessage(m))?.text ?? null);
    return { texts, raw: messages };
  },

  /** Decrypts a message as this device would, given the raw message from another device. */
  async decrypt({ message }) {
    const payload = await decryptMessage(message as Message);
    return { text: payload?.text ?? null };
  },

  /** Encrypts a deterministic-size random blob, uploads it, and sends it as an attachment. Returns the plaintext hash. */
  async sendAttachment({ channelId, sizeBytes }) {
    const bytes = new Uint8Array(randomBytes(sizeBytes));
    const enc = await encryptBlob(bytes);
    const up = await api.putRaw<{ uploadId: string }>('POST', '/api/uploads', enc.blob, 'application/octet-stream');
    const attachment: Attachment = { uploadId: up.uploadId, name: 'big.bin', mime: 'application/octet-stream', size: bytes.length, key: enc.key, iv: enc.iv };
    const sealed = await encryptPayload(channelId, useSession.getState().user!.id, { text: 'see attached', attachments: [attachment] });
    await api.post(`/api/channels/${channelId}/messages`, sealed);
    return { sha256: sha256(bytes), size: bytes.length };
  },

  /** Downloads and decrypts the newest attachment in the channel. */
  async fetchAttachment({ channelId }) {
    const { messages } = await api.get<{ messages: Message[] }>(`/api/channels/${channelId}/messages`);
    for (const m of [...messages].reverse()) {
      const payload = await decryptMessage(m);
      const attachment = payload?.attachments?.[0] as Attachment | undefined;
      if (!attachment) continue;
      const blob = new Uint8Array(await api.getBytes(`/api/uploads/${attachment.uploadId}`));
      const plain = await decryptBlob(blob, attachment.key, attachment.iv);
      return { sha256: sha256(plain), size: plain.length };
    }
    throw new Error('no attachment in channel');
  },
};

function reply(message: object): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, cmd, args } = JSON.parse(line) as { id: number; cmd: string; args?: Record<string, unknown> };
  try {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unknown command ${cmd}`);
    reply({ id, ok: true, result: await handler(args ?? {}) });
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
