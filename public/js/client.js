const socket = io();
let myId = null, gType = 'battleroyale', cfg = null, gs = null;
let ents = [], pks = [], zone = null, flags = null, hill = null;
const keys = {};
let mx = 0, my = 0, mDown = false;
const cam = { x: 0, y: 0 };

const cv = document.getElementById('cv');
const c = cv.getContext('2d');
const mc = document.getElementById('mmc');
const mm = mc.getContext('2d');

function resize() { cv.width = innerWidth; cv.height = innerHeight; }
addEventListener('resize', resize); resize();

addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
cv.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
cv.addEventListener('mousedown', () => mDown = true);
cv.addEventListener('mouseup', () => mDown = false);
cv.addEventListener('touchstart', e => { mDown = true; mx = e.touches[0].clientX; my = e.touches[0].clientY; }, { passive: true });
cv.addEventListener('touchmove', e => { mx = e.touches[0].clientX; my = e.touches[0].clientY; }, { passive: true });
cv.addEventListener('touchend', () => mDown = false);
cv.addEventListener('contextmenu', e => e.preventDefault());

// LOBBY
document.querySelectorAll('.gcard').forEach(card => {
  card.onclick = () => {
    document.querySelectorAll('.gcard').forEach(c => c.classList.remove('sel'));
    card.classList.add('sel');
    gType = card.dataset.g;
  };
});

document.getElementById('bcreate').onclick = () => {
  const n = document.getElementById('pname').value.trim() || 'Player';
  socket.emit('createRoom', { name: n, gameType: gType }, r => {
    if (r.ok) showRoom(r.roomId); else toast(r.err);
  });
};

document.getElementById('bjoin').onclick = () => {
  const n = document.getElementById('pname').value.trim() || 'Player';
  const code = document.getElementById('rcode').value.trim();
  if (!code) return toast('Enter code');
  socket.emit('joinRoom', { name: n, roomId: code }, r => {
    if (r.ok) showRoom(r.roomId); else toast(r.err);
  });
};

document.getElementById('bcopy').onclick = () => {
  navigator.clipboard?.writeText(document.getElementById('dcode').innerText);
  toast('Copied!');
};
document.getElementById('bstart').onclick = () => socket.emit('startGame');
document.getElementById('bleave').onclick = () => location.reload();
document.getElementById('rback').onclick = () => location.reload();

function showRoom(id) {
  document.querySelector('.actions').classList.add('hidden');
  document.querySelector('.gcards').classList.add('hidden');
  document.getElementById('rwait').classList.remove('hidden');
  document.getElementById('dcode').innerText = id;
}
function toast(m) {
  const t = document.getElementById('toast');
  t.innerText = m; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// SOCKET
socket.on('joined', d => myId = d.pid);
socket.on('roomUpdate', d => {
  document.getElementById('plist').innerHTML = d.players.map(p =>
    `<div class="ptag">${p.name} ${p.isHost ? '👑' : ''}</div>`
  ).join('');
  const me = d.players.find(p => p.id === myId);
  document.getElementById('bstart').classList.toggle('hidden', !me?.isHost);
});

socket.on('gameStart', d => {
  cfg = d.cfg; ents = d.entities || []; pks = d.pickups || [];
  zone = d.zone; flags = d.flags; hill = d.hill;
  document.getElementById('lobby').classList.add('hidden');
  cv.classList.remove('hidden');
  document.getElementById('hud').classList.remove('hidden');
  if (gType === 'battleroyale') document.getElementById('h-zone').classList.remove('hidden');
  if (gType === 'zombie') document.getElementById('h-wave').classList.remove('hidden');
  if (['teamshooter','ctf','koth'].includes(gType)) document.getElementById('h-tscore').classList.remove('hidden');
  requestAnimationFrame(loop);
  inputLoop();
});

socket.on('state', d => {
  gs = d; ents = d.entities || ents; pks = d.pickups || pks;
  zone = d.zone; flags = d.flags; hill = d.hill;
});

socket.on('gameEnd', d => {
  cv.classList.add('hidden');
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('results').classList.remove('hidden');
  const me = d.players.find(p => p.id === myId);
  let won = false;
  if (d.winnerTeam) won = me?.team === d.winnerTeam;
  else if (d.winnerId) won = d.winnerId === myId;
  else if (d.waveReached) won = false;
  document.getElementById('r-title').innerText = won ? '🏆 VICTORY!' : (d.waveReached ? `💀 Survived ${d.waveReached} Waves` : '💀 DEFEATED');
  document.getElementById('r-list').innerHTML = d.players.map((p, i) =>
    `<div class="rrow"><span>${i+1}. ${p.name} ${p.id===myId?'(You)':''} ${p.team?'['+p.team+']':''}</span><span>K:${p.kills} D:${p.deaths} S:${p.score}</span></div>`
  ).join('');
});

socket.on('toast', toast);

function inputLoop() {
  setInterval(() => {
    if (!gs || !cfg) return;
    let ix = 0, iy = 0;
    if (keys.w || keys.arrowup) iy -= 1;
    if (keys.s || keys.arrowdown) iy += 1;
    if (keys.a || keys.arrowleft) ix -= 1;
    if (keys.d || keys.arrowright) ix += 1;
    socket.emit('input', { mx: ix, my: iy });
    if (mDown && gType !== 'zombie' || mDown) {
      const me = gs.players[myId];
      if (me?.alive) {
        const a = Math.atan2(my + cam.y - me.y, mx + cam.x - me.x);
        socket.emit('shoot', { angle: a });
      }
    }
  }, 1000 / 30);
}

// RENDER
function loop() {
  if (!gs || !cfg) return;
  requestAnimationFrame(loop);
  const me = gs.players[myId];
  if (!me) return;

  cam.x = me.x - cv.width / 2;
  cam.y = me.y - cv.height / 2;
  c.clearRect(0, 0, cv.width, cv.height);

  // Grid
  c.strokeStyle = 'rgba(255,255,255,.025)';
  c.lineWidth = 1;
  const gs2 = 60;
  for (let x = -(cam.x % gs2); x < cv.width; x += gs2) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, cv.height); c.stroke(); }
  for (let y = -(cam.y % gs2); y < cv.height; y += gs2) { c.beginPath(); c.moveTo(0, y); c.lineTo(cv.width, y); c.stroke(); }

  // Border
  c.strokeStyle = 'rgba(255,68,102,.4)';
  c.lineWidth = 3;
  c.strokeRect(-cam.x, -cam.y, cfg.mapW, cfg.mapH);

  // Zone
  if (zone && gType === 'battleroyale') {
    c.save();
    c.beginPath();
    c.rect(0, 0, cv.width, cv.height);
    c.arc(zone.x - cam.x, zone.y - cam.y, zone.radius, 0, Math.PI * 2, true);
    c.fillStyle = 'rgba(255,0,0,.12)';
    c.fill();
    c.restore();
    c.beginPath();
    c.arc(zone.x - cam.x, zone.y - cam.y, zone.radius, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,68,102,.5)';
    c.lineWidth = 2;
    c.stroke();
  }

  // Hill (KOTH)
  if (hill && gType === 'koth') {
    const hx = hill.x - cam.x, hy = hill.y - cam.y;
    c.beginPath();
    c.arc(hx, hy, hill.radius, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,170,0,.12)';
    c.fill();
    c.strokeStyle = 'rgba(255,170,0,.5)';
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = 'rgba(255,170,0,.6)';
    c.font = 'bold 14px Inter';
    c.textAlign = 'center';
    c.fillText('👑 HILL', hx, hy + 5);
  }

  // Flags (CTF)
  if (flags && gType === 'ctf') {
    ['red', 'blue'].forEach(t => {
      const f = flags[t];
      if (f.carrier) return;
      const fx = f.x - cam.x, fy = f.y - cam.y;
      c.font = '22px serif';
      c.textAlign = 'center';
      c.fillText('🚩', fx, fy + 8);
      c.beginPath();
      c.arc(fx, fy, 20, 0, Math.PI * 2);
      c.strokeStyle = f.color;
      c.lineWidth = 2;
      c.setLineDash([4, 4]);
      c.stroke();
      c.setLineDash([]);
    });
  }

  // Bases (CTF / TDM)
  if (gType === 'ctf' || gType === 'teamshooter' || gType === 'koth') {
    c.fillStyle = 'rgba(255,68,102,.06)';
    c.fillRect(-cam.x, -cam.y, 200, cfg.mapH);
    c.fillStyle = 'rgba(68,136,255,.06)';
    c.fillRect(cfg.mapW - 200 - cam.x, -cam.y, 200, cfg.mapH);
  }

  // Entities
  ents.forEach(e => {
    const sx = e.x - cam.x, sy = e.y - cam.y;
    if (sx < -60 || sx > cv.width + 60 || sy < -60 || sy > cv.height + 60) return;
    if (e.type === 'zombie') {
      c.beginPath();
      c.arc(sx, sy, e.radius, 0, Math.PI * 2);
      c.fillStyle = e.color;
      c.fill();
      c.strokeStyle = '#225522';
      c.lineWidth = 2;
      c.stroke();
      // HP bar
      if (e.hp < e.maxHp) {
        c.fillStyle = 'rgba(0,0,0,.5)';
        c.fillRect(sx - e.radius, sy - e.radius - 6, e.radius * 2, 3);
        c.fillStyle = '#ff4466';
        c.fillRect(sx - e.radius, sy - e.radius - 6, e.radius * 2 * (e.hp / e.maxHp), 3);
      }
    } else if (e.type === 'food') {
      c.beginPath();
      c.arc(sx, sy, e.radius, 0, Math.PI * 2);
      c.fillStyle = e.color;
      c.fill();
    }
  });

  // Pickups
  pks.forEach(pk => {
    const sx = pk.x - cam.x, sy = pk.y - cam.y;
    if (sx < -40 || sx > cv.width + 40 || sy < -40 || sy > cv.height + 40) return;
    c.beginPath();
    c.arc(sx, sy, pk.radius, 0, Math.PI * 2);
    if (pk.type === 'health') { c.fillStyle = '#00ff88'; c.fill(); c.fillStyle = '#fff'; c.font = 'bold 11px Inter'; c.textAlign = 'center'; c.fillText('+', sx, sy + 4); }
    else if (pk.type === 'weapon') { c.fillStyle = '#ffaa00'; c.fill(); c.fillStyle = '#fff'; c.font = 'bold 9px Inter'; c.textAlign = 'center'; c.fillText(pk.weapon[0].toUpperCase(), sx, sy + 3); }
    else if (pk.type === 'powerup') {
      const cols = { speed: '#00f0ff', shield: '#aa44ff', damage: '#ff4466', rapid: '#ffdd44' };
      c.fillStyle = cols[pk.power] || '#fff';
      c.fill();
      c.fillStyle = '#fff'; c.font = 'bold 9px Inter'; c.textAlign = 'center';
      c.fillText(pk.power[0].toUpperCase(), sx, sy + 3);
    }
  });

  // Projectiles
  gs.projectiles?.forEach(b => {
    const sx = b.x - cam.x, sy = b.y - cam.y;
    c.beginPath(); c.arc(sx, sy, 3, 0, Math.PI * 2);
    c.fillStyle = b.team === 'red' ? '#ff8888' : (b.team === 'blue' ? '#8888ff' : '#ffdd44');
    c.fill();
    c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx - b.vx * 2, sy - b.vy * 2);
    c.strokeStyle = 'rgba(255,221,68,.3)'; c.lineWidth = 2; c.stroke();
  });

  // Players
  Object.values(gs.players).forEach(p => {
    if (!p.alive) return;
    const sx = p.x - cam.x, sy = p.y - cam.y;
    if (sx < -80 || sx > cv.width + 80 || sy < -80 || sy > cv.height + 80) return;

    // Shield glow
    if (p.shield) {
      c.beginPath(); c.arc(sx, sy, p.radius + 6, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(170,68,255,.5)'; c.lineWidth = 3; c.stroke();
    }

    // Body
    c.beginPath(); c.arc(sx, sy, p.radius, 0, Math.PI * 2);
    c.fillStyle = p.color; c.fill();
    c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = 2; c.stroke();

    // Gun direction
    const a = p.id === myId ? Math.atan2(my + cam.y - p.y, mx + cam.x - p.x) : p.angle;
    c.beginPath();
    c.moveTo(sx + Math.cos(a) * p.radius, sy + Math.sin(a) * p.radius);
    c.lineTo(sx + Math.cos(a) * (p.radius + 14), sy + Math.sin(a) * (p.radius + 14));
    c.strokeStyle = '#ddd'; c.lineWidth = 3; c.stroke();

    // Flag indicator
    if (p.hasFlag) {
      c.font = '14px serif'; c.textAlign = 'center';
      c.fillText('🚩', sx, sy - p.radius - 20);
    }

    // Name
    c.fillStyle = '#fff'; c.font = 'bold 11px Inter'; c.textAlign = 'center';
    c.fillText(p.name, sx, sy - p.radius - (p.hasFlag ? 32 : 10));

    // HP bar
    if (p.hp < p.maxHp) {
      const bw = p.radius * 2.2;
      c.fillStyle = 'rgba(0,0,0,.5)';
      c.fillRect(sx - bw / 2, sy - p.radius - 5, bw, 3);
      c.fillStyle = p.hp > p.maxHp * .5 ? '#00ff88' : (p.hp > p.maxHp * .25 ? '#ffaa00' : '#ff4466');
      c.fillRect(sx - bw / 2, sy - p.radius - 5, bw * (p.hp / p.maxHp), 3);
    }
  });

  // HUD
  if (me) {
    document.getElementById('h-score').innerText = `Score: ${me.score}`;
    document.getElementById('h-kills').innerText = `Kills: ${me.kills}`;
    const alive = Object.values(gs.players).filter(p => p.alive).length;
    document.getElementById('h-alive').innerText = `Alive: ${alive}`;
    document.getElementById('h-hpf').style.width = `${(me.hp / me.maxHp) * 100}%`;
    document.getElementById('h-hpf').style.background = me.hp > me.maxHp * .5 ? 'var(--s)' : (me.hp > me.maxHp * .25 ? 'var(--w)' : 'var(--r)');
    document.getElementById('h-wep').innerText = `🔫 ${(me.weapon || 'pistol').toUpperCase()}`;

    // Flag alert
    document.getElementById('h-flag').classList.toggle('hidden', !me.hasFlag);

    if (gs.wave) document.getElementById('h-wave').innerText = `Wave: ${gs.wave}`;
    if (gs.teamScores) document.getElementById('h-tscore').innerText = `Red ${Math.floor(gs.teamScores.red)} - ${Math.floor(gs.teamScores.blue)} Blue`;
    if (zone?.nextShrink) document.getElementById('h-zt').innerText = Math.max(0, Math.ceil((zone.nextShrink - Date.now()) / 1000));
  }

  // Minimap
  const mw = mc.width, mh = mc.height;
  const sx2 = mw / cfg.mapW, sy2 = mh / cfg.mapH;
  mm.clearRect(0, 0, mw, mh);
  mm.fillStyle = 'rgba(10,10,26,.8)'; mm.fillRect(0, 0, mw, mh);
  if (zone) { mm.beginPath(); mm.arc(zone.x * sx2, zone.y * sy2, zone.radius * sx2, 0, Math.PI * 2); mm.strokeStyle = 'rgba(255,68,102,.4)'; mm.lineWidth = 1; mm.stroke(); }
  if (hill) { mm.beginPath(); mm.arc(hill.x * sx2, hill.y * sy2, hill.radius * sx2, 0, Math.PI * 2); mm.fillStyle = 'rgba(255,170,0,.2)'; mm.fill(); }
  Object.values(gs.players).forEach(p => {
    if (!p.alive) return;
    mm.beginPath(); mm.arc(p.x * sx2, p.y * sy2, p.id === myId ? 3 : 2, 0, Math.PI * 2);
    mm.fillStyle = p.id === myId ? '#fff' : p.color; mm.fill();
  });
  ents.filter(e => e.type === 'zombie').forEach(z => {
    mm.beginPath(); mm.arc(z.x * sx2, z.y * sy2, 1, 0, Math.PI * 2);
    mm.fillStyle = '#44aa44'; mm.fill();
  });
}
