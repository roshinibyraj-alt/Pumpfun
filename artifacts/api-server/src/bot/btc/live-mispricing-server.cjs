'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const COOKIE_NAME = 'btc_live_dashboard';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 8;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(password, issuedAt) {
  return crypto.createHmac('sha256', password).update(String(issuedAt)).digest('hex');
}

function cookieValue(header) {
  const item = String(header || '').split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${COOKIE_NAME}=`));
  return item ? decodeURIComponent(item.slice(COOKIE_NAME.length + 1)) : '';
}

function hasSession(request, password, now = Date.now()) {
  if (!password) return false;
  const [issuedText, providedSignature] = cookieValue(request.headers.cookie).split('.');
  const issuedAt = Number(issuedText);
  if (!Number.isFinite(issuedAt) || now - issuedAt < 0
    || now - issuedAt > SESSION_MAX_AGE_MS) return false;
  return safeEqual(providedSignature, signature(password, issuedAt));
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8_192) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function createLiveMispricingServer({ bot, password }) {
  const htmlCandidates = [
    path.resolve(__dirname, '../../../public/live-mispricing.html'),
    path.resolve(__dirname, '../public/live-mispricing.html'),
    path.resolve(process.cwd(), 'public/live-mispricing.html'),
  ];
  const htmlPath = htmlCandidates.find(candidate => fs.existsSync(candidate));
  if (!htmlPath) throw new Error('Live mispricing dashboard HTML was not found.');
  const html = fs.readFileSync(htmlPath);
  const loginAttempts = new Map();
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/healthz') {
      return sendJson(response, 200, {
        status: 'ok',
        botStatus: bot.snapshot().status,
        at: new Date().toISOString(),
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      if (!password) {
        return sendJson(response, 503, { error: 'Dashboard password is not configured.' });
      }
      try {
        const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '')
          .split(',')[0].trim();
        const now = Date.now();
        const attempts = loginAttempts.get(ip);
        if (attempts && now - attempts.startedAt < LOGIN_WINDOW_MS
          && attempts.count >= LOGIN_MAX_ATTEMPTS) {
          return sendJson(response, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
        }
        const payload = await readJson(request);
        if (!safeEqual(payload.password, password)) {
          const current = loginAttempts.get(ip);
          if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
            loginAttempts.set(ip, { startedAt: now, count: 1 });
          } else {
            current.count += 1;
          }
          return sendJson(response, 401, { error: 'Incorrect password.' });
        }
        loginAttempts.delete(ip);
        const issuedAt = Date.now();
        const value = `${issuedAt}.${signature(password, issuedAt)}`;
        return sendJson(response, 200, { authenticated: true }, {
          'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}`,
        });
      } catch (error) {
        return sendJson(response, 400, { error: error.message || 'Invalid login request.' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      return sendJson(response, 200, { authenticated: false }, {
        'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      if (!hasSession(request, password)) {
        return sendJson(response, 401, { error: 'Sign in to view account details.' });
      }
      return sendJson(response, 200, bot.snapshot());
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      });
      return response.end(html);
    }
    return sendJson(response, 404, { error: 'Not found.' });
  });
}

module.exports = { createLiveMispricingServer, hasSession };
