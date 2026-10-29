// The `chatward` admin command. deploy/home/chatward runs it inside the server container; it talks to the running
// server through the admin socket (modules/admin.ts), so changes reach open apps right away.
//   node dist/cli.js invite [--hours 48] | invites | revoke CODE | invite-log | users
//                    reset NAME | remove NAME | restore NAME | admin NAME | member NAME
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { adminSocketPathFor } from './adminSocketPath.js';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
// deploy/home/chatward passes the server login that ran the command; it ends up in invites.log.
const issuer = process.env.CHATWARD_ADMIN?.trim() || os.userInfo().username;

const HELP = `Usage: chatward <command>

  invite [--hours N]   Make a one-time sign-up code (default 48 hours)
  invites              List codes that have not been used yet
  revoke CODE          Cancel an unused code (the whole code or its last 4 characters)
  invite-log           Show every code made, who made it and which account used it
  users                List accounts
  reset NAME           Make a one-time password reset code for NAME
  remove NAME          Turn NAME's account off (signed out everywhere, cannot sign in)
  restore NAME         Turn NAME's account back on
  admin NAME           Make NAME an admin
  member NAME          Make NAME a regular member again`;

function call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath: adminSocketPathFor(dataDir), path: route, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => {
        let json: { error?: string } = {};
        try { json = JSON.parse(text) as { error?: string }; } catch { /* not JSON */ }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(json.error ?? `server answered ${res.statusCode}`));
        else resolve(json as T);
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
        ? 'the Chatward server is not running (no admin socket found)'
        : err.message));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const when = (ms: number | null): string => {
  if (!ms) return 'never';
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('   ').trimEnd()).join('\n');
}

function needName(name: string | undefined): string {
  if (!name) throw new Error('give the account name, e.g. chatward reset jacob');
  return name;
}

async function main(argv: string[]): Promise<void> {
  const [command, arg, ...rest] = argv;
  switch (command) {
    case 'invite': {
      let hours: number | undefined;
      const flags = [arg, ...rest].filter((v): v is string => v !== undefined);
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--hours') hours = Number(flags[++i]);
        else if (flags[i].startsWith('--hours=')) hours = Number(flags[i].slice(8));
        else throw new Error(`unknown option ${flags[i]}`);
      }
      const r = await call<{ code: string; expiresAt: number; publicUrl: string; firstAccount: boolean }>(
        'POST', '/invite', { hours, issuer });
      console.log(`New sign-up code: ${r.code}   (single use, expires ${when(r.expiresAt)})`);
      if (r.firstAccount) console.log('There are no accounts yet, so the account made with this code will own the server.');
      console.log('\nSend this to them:');
      console.log('  Install Chatward and choose "Create account".');
      if (r.publicUrl) console.log(`  Server: ${r.publicUrl}`);
      console.log(`  Sign-up code: ${r.code}`);
      return;
    }
    case 'invites': {
      const { codes } = await call<{ codes: { label: string; createdBy: string; createdAt: number; expiresAt: number }[] }>('GET', '/invites');
      if (codes.length === 0) { console.log('No unused codes.'); return; }
      console.log(table([['CODE', 'MADE BY', 'MADE', 'EXPIRES'],
        ...codes.map((c) => [`…${c.label}`, c.createdBy, when(c.createdAt), when(c.expiresAt)])]));
      return;
    }
    case 'revoke': {
      if (!arg) throw new Error('give the code, or its last 4 characters from chatward invites');
      const r = await call<{ label: string }>('POST', '/revoke', { code: arg, issuer });
      console.log(`Cancelled code …${r.label}.`);
      return;
    }
    case 'invite-log': {
      const { log } = await call<{ log: string }>('GET', '/log');
      process.stdout.write(log || 'No sign-up codes have been made yet.\n');
      return;
    }
    case 'users': {
      const { users } = await call<{ users: { name: string; role: string; createdAt: number; lastSeen: number | null; invitedBy: string | null; inviteLabel: string | null }[] }>('GET', '/users');
      if (users.length === 0) { console.log('No accounts yet. Make the first sign-up code with: chatward invite'); return; }
      console.log(table([['NAME', 'ROLE', 'JOINED', 'LAST SEEN', 'INVITED BY'],
        ...users.map((u) => [u.name, u.role, when(u.createdAt).slice(0, 10), when(u.lastSeen),
          u.invitedBy ? `${u.invitedBy} (code …${u.inviteLabel})` : '-'])]));
      return;
    }
    case 'reset': {
      const r = await call<{ name: string; code: string; expiresAt: number }>('POST', '/reset', { name: needName(arg), issuer });
      console.log(`Password reset code for ${r.name}: ${r.code}   (single use, expires ${when(r.expiresAt)})`);
      console.log('They choose "Forgot password?" on the login screen and enter it with a new password.');
      return;
    }
    case 'remove': {
      const r = await call<{ name: string }>('POST', '/remove', { name: needName(arg), issuer });
      console.log(`${r.name} is turned off: signed out everywhere and cannot sign in. Undo with: chatward restore ${r.name}`);
      return;
    }
    case 'restore': {
      const r = await call<{ name: string }>('POST', '/restore', { name: needName(arg), issuer });
      console.log(`${r.name} is back on and can sign in again.`);
      return;
    }
    case 'admin':
    case 'member': {
      const r = await call<{ name: string; role: string }>('POST', '/role', { name: needName(arg), role: command, issuer });
      console.log(`${r.name} is now ${r.role === 'admin' ? 'an admin' : 'a member'}.`);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`chatward: ${err.message}`);
  process.exit(1);
});
