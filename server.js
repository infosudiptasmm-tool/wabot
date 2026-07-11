require('dotenv').config();
const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const makeWASocket = baileys.default;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const DisconnectReason = baileys.DisconnectReason;

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.AI_MODEL || 'openai/gpt-3.5-turbo';
const PROMPT = process.env.SYSTEM_PROMPT || 'You are a helpful assistant. Reply in the same language the user writes in.';

let currentQR = null;
let isConnected = false;
let sock = null;

async function startWhatsApp() {
  const auth = await useMultiFileAuthState('./auth');
  sock = makeWASocket({
    auth: auth.state,
    logger: pino({ level: 'silent' }),
    browser: ['MyBot', 'Chrome', '1.0'],
  });
  sock.ev.on('creds.update', auth.saveCreds);
  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      currentQR = await QRCode.toDataURL(update.qr);
      isConnected = false;
    }
    if (update.connection === 'open') {
      currentQR = null;
      isConnected = true;
      console.log('Connected');
    }
    if (update.connection === 'close') {
      isConnected = false;
      const code = update.lastDisconnect && update.lastDisconnect.error
        ? update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode
        : null;
      if (code !== DisconnectReason.loggedOut) {
        startWhatsApp();
      } else {
        startWhatsApp();
      }
    }
  });
  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return;
    for (const msg of ev.messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid.indexOf('@g.us') !== -1) continue;
      if (jid === 'status@broadcast') continue;
      let text = '';
      if (msg.message && msg.message.conversation) {
        text = msg.message.conversation;
      } else if (msg.message && msg.message.extendedTextMessage) {
        text = msg.message.extendedTextMessage.text;
      }
      if (!text) continue;
      const reply = await askAI(text);
      if (reply) {
        await sock.sendMessage(jid, { text: reply });
      }
    }
  });
}

async function askAI(userText) {
  if (!KEY) return 'AI key not set';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: userText },
        ],
        max_tokens: 500,
      }),
    });
    const data = await res.json();
    if (data.choices && data.choices[0]) {
      return data.choices[0].message.content;
    }
    return null;
  } catch (err) {
    console.error('AI error', err.message);
    return null;
  }
}

function buildPage() {
  const p = [];
  p.push('<!DOCTYPE html><html><head>');
  p.push('<meta charset="utf-8">');
  p.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  p.push('<title>WhatsApp Login</title>');
  p.push('<style>body{font-family:sans-serif;text-align:center;background:#111;color:#fff;padding-top:40px}');
  p.push('img{width:280px;height:280px;background:#fff;padding:12px;border-radius:12px}');
  p.push('.ok{color:#25D366;font-size:22px}p{color:#aaa}</style></head><body>');
  p.push('<h2>WhatsApp Bot Login</h2>');
  p.push('<div id="box">Loading...</div><p id="hint"></p>');
  p.push('<' + 'script>');
  p.push('async function load(){');
  p.push('var r=await fetch("/status");var d=await r.json();');
  p.push('var box=document.getElementById("box");var hint=document.getElementById("hint");');
  p.push('if(d.connected){box.innerHTML="<div class=ok>Connected. Bot running.</div>";hint.textContent="You can close this page.";}');
  p.push('else if(d.qr){box.innerHTML="<img src="+d.qr+">";hint.textContent="WhatsApp > Linked Devices > Link a device. Refresh 30s.";}');
  p.push('else{box.textContent="Generating QR...";}}');
  p.push('load();setInterval(load,30000);');
  p.push('</' + 'script></body></html>');
  return p.join('');
}

const app = express();
app.get('/', (req, res) => { res.send(buildPage()); });
app.get('/status', (req, res) => { res.json({ connected: isConnected, qr: currentQR }); });
app.listen(PORT, () => {
  console.log('Running on ' + PORT);
  startWhatsApp();
});
