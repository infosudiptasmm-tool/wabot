require('dotenv').config();
const express = require('express');
const fs = require('fs');
const baileys = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const makeWASocket = baileys.default;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const DisconnectReason = baileys.DisconnectReason;

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.AI_MODEL || 'openai/gpt-3.5-turbo';

const PROMPT = `You are EricHost's official AI Assistant.

Your job is to help customers with hosting, VPS, cloud hosting, reseller hosting, enterprise hosting, domain registration, domain transfer, SSL certificates, website migration, billing information, hosting plans, cPanel, WordPress installation, email hosting, DNS, backups, security, and technical support.

LANGUAGE STYLE:
- You speak in three languages: Bangla, Hindi, and English.
- For Hindi, always WRITE it using English letters (romanized Hindi), but the language must be Hindi. Example: "Haan bhai, main aapki help kar sakta hoon."
- Match the language the customer uses. If they write Bangla, reply in Bangla. If romanized Hindi, reply in romanized Hindi. If English, reply in English.
- Be fun, playful, and a little extra masti-loving. Use light humor, be friendly and warm, not robotic. But stay helpful.

If a customer asks about hosting plans, explain options and recommend the best one.
If a customer asks technical questions, provide troubleshooting. If it needs account access, advise them to contact EricHost Support.
Never invent pricing or features. If unavailable, tell them to check the official website or contact support.

Key Features: NVMe SSD, LiteSpeed, Free SSL, Free Website Migration, Daily Backup, cPanel, Softaculous, WordPress Hosting, 99.9% Uptime, 24/7 Customer Support.
Support Email: support@erichost.com
Support Number: +91 80 6937 8184

Keep replies polite, concise, and human-like.`;

let currentQR = null;
let isConnected = false;
let sock = null;
let starting = false;

const chatMemory = {};
const MAX_HISTORY = 12;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startWhatsApp() {
  if (starting) return;
  starting = true;
  try {
    const auth = await useMultiFileAuthState('./auth');
    const versionInfo = await baileys.fetchLatestBaileysVersion();
    console.log('Using WA version', versionInfo.version);

    sock = makeWASocket({
      version: versionInfo.version,
      auth: auth.state,
      logger: pino({ level: 'silent' }),
      browser: baileys.Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', auth.saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (update.qr) {
        currentQR = await QRCode.toDataURL(update.qr);
        isConnected = false;
        console.log('QR ready');
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
        console.log('Connection closed, code', code);
        starting = false;
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync('./auth', { recursive: true, force: true }); } catch (e) {}
          currentQR = null;
        }
        setTimeout(startWhatsApp, 3000);
      }
    });

    // সব ধরনের incoming event ধরার চেষ্টা
    sock.ev.on('messages.upsert', async (ev) => {
      console.log('EVENT messages.upsert type:', ev.type, 'count:', ev.messages ? ev.messages.length : 0);
      try {
        for (const msg of ev.messages) {
          if (!msg.message) continue;
          if (msg.key && msg.key.fromMe) continue;
          const jid = msg.key.remoteJid;
          if (!jid) continue;
          if (jid.indexOf('@g.us') !== -1) continue;
          if (jid === 'status@broadcast') continue;
          if (jid.indexOf('@broadcast') !== -1) continue;

          let text = '';
          const m = msg.message;
          if (m.conversation) text = m.conversation;
          else if (m.extendedTextMessage && m.extendedTextMessage.text) text = m.extendedTextMessage.text;
          else if (m.imageMessage && m.imageMessage.caption) text = m.imageMessage.caption;

          console.log('IN from', jid, ':', text);
          if (!text) continue;

          const reply = await askAI(jid, text);
          console.log('AI reply:', reply ? reply.slice(0, 80) : 'NULL');

          if (reply) {
            await sleep(2000);
            try {
              await sock.sendMessage(jid, { text: reply });
              console.log('SENT to', jid);
            } catch (e) {
              console.log('sendMessage err', e.message);
            }
          }
        }
      } catch (e) {
        console.log('upsert err', e.message);
      }
    });
  } catch (err) {
    console.log('startWhatsApp error', err.message);
    starting = false;
    setTimeout(startWhatsApp, 5000);
  }
}

async function askAI(jid, userText) {
  if (!KEY) { console.log('No API key'); return 'AI key missing'; }
  if (!chatMemory[jid]) chatMemory[jid] = [];
  chatMemory[jid].push({ role: 'user', content: userText });
  if (chatMemory[jid].length > MAX_HISTORY) chatMemory[jid] = chatMemory[jid].slice(-MAX_HISTORY);
  const messages = [{ role: 'system', content: PROMPT }].concat(chatMemory[jid]);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: messages, max_tokens: 500 }),
    });
    const data = await res.json();
    console.log('OpenRouter:', JSON.stringify(data).slice(0, 250));
    if (data.choices && data.choices[0]) {
      const answer = data.choices[0].message.content;
      chatMemory[jid].push({ role: 'assistant', content: answer });
      return answer;
    }
    return null;
  } catch (err) {
    console.error('AI err', err.message);
    return null;
  }
}

function buildPage() {
  const p = [];
  p.push('<!DOCTYPE html><html><head><meta charset="utf-8">');
  p.push('<meta name="viewport" content="width=device-width, initial-scale=1"><title>WhatsApp Login</title>');
  p.push('<style>body{font-family:sans-serif;text-align:center;background:#111;color:#fff;padding-top:30px}');
  p.push('img{width:280px;height:280px;background:#fff;padding:12px;border-radius:12px}');
  p.push('.ok{color:#25D366;font-size:22px}p{color:#aaa}#t{color:#25D366;font-size:14px;margin-top:10px}');
  p.push('button{margin-top:16px;padding:10px 20px;background:#25D366;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:bold}</style></head><body>');
  p.push('<h2>WhatsApp Bot Login</h2><div id="box">Loading...</div><p id="hint"></p><div id="t"></div>');
  p.push('<button onclick="reset()">New QR / Reset</button>');
  p.push('<' + 'script>var sec=0;');
  p.push('async function load(){var r=await fetch("/status");var d=await r.json();');
  p.push('var box=document.getElementById("box");var hint=document.getElementById("hint");var t=document.getElementById("t");');
  p.push('if(d.connected){box.innerHTML="<div class=ok>Connected. Bot running.</div>";hint.textContent="You can close this page.";t.textContent="";sec=0;}');
  p.push('else if(d.qr){box.innerHTML="<img src="+d.qr+">";hint.textContent="WhatsApp > Linked Devices > Link a device.";sec=0;}');
  p.push('else{sec++;box.textContent="Generating QR...";if(sec>4){t.textContent="Taking long? Tap New QR / Reset.";}}}');
  p.push('async function reset(){document.getElementById("box").textContent="Resetting...";await fetch("/reset");sec=0;setTimeout(load,2000);}');
  p.push('load();setInterval(load,3000);</' + 'script></body></html>');
  return p.join('');
}

const app = express();
app.get('/', (req, res) => { res.send(buildPage()); });
app.get('/status', (req, res) => { res.json({ connected: isConnected, qr: currentQR }); });
app.get('/reset', async (req, res) => {
  try {
    isConnected = false; currentQR = null;
    try { if (sock) sock.end(); } catch (e) {}
    try { fs.rmSync('./auth', { recursive: true, force: true }); } catch (e) {}
    starting = false;
    setTimeout(startWhatsApp, 1000);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});
app.listen(PORT, () => { console.log('Running on ' + PORT); startWhatsApp(); });
