const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const MAP = 200;

function rid() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }
function d3(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2); }
function rnd(a, b) { return a + Math.random() * (b - a); }

io.on('connection', (socket) => {
  let room = null;

  socket.on('create', (data, cb) => {
    const id = rid();
    rooms[id] = {
      id, type: data.type || 'battle',
      players: {}, bullets: [], items: [],
      state: 'lobby', scores: { red: 0, blue: 0 },
      zone: null, wave: 0, zombies: [], loop: null
    };
    room = id;
    join(socket, rooms[id], data.name || 'Player', true);
    cb({ ok: true, id });
  });

  socket.on('join', (data, cb) => {
    const id = data.id.toUpperCase();
    const r = rooms[id];
    if (!r) return cb({ ok: false, msg: 'Not found' });
    if (Object.keys(r.players).length >= 16) return cb({ ok: false, msg: 'Full' });
    if (r.state === 'playing') return cb({ ok: false, msg: 'Started' });
    room = id;
    join(socket, r, data.name || 'Player', false);
    cb({ ok: true, id });
  });

  socket.on('start', () => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    if (!r.players[socket.id]?.host) return;
    begin(r);
  });

  socket.on('input', (data) => {
    if (!room || !rooms[room]) return;
    const p = rooms[room].players[socket.id];
    if (!p || !p.alive) return;
    p.mx = data.mx || 0;
    p.mz = data.mz || 0;
    p.ry = data.ry || 0;
    if (data.jump && p.grounded) { p.vy = 8; p.grounded = false; }
  });

  socket.on('shoot', (data) => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    const p = r.players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastShot < 200) return;
    p.lastShot = now;
    const speed = 80;
    r.bullets.push({
      x: p.x, y: p.y + 1.5, z: p.z,
      vx: data.dx * speed, vy: data.dy * speed, vz: data.dz * speed,
      owner: socket.id, team: p.team, life: 40
    });
  });

  socket.on('disconnect', () => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    delete r.players[socket.id];
    io.to(room).emit('lobby', lobbyState(r));
    if (!Object.keys(r.players).length) {
      if (r.loop) clearInterval(r.loop);
      delete rooms[room];
    }
  });
});

function join(socket, r, name, host) {
  socket.join(r.id);
  r.players[socket.id] = {
    id: socket.id, name, host,
    x: rnd(-40, 40), y: 0, z: rnd(-40, 40),
    vx: 0, vy: 0, vz: 0,
    ry: 0, mx: 0, mz: 0,
    hp: 100, maxHp: 100, alive: true,
    team: null, color: '#' + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0'),
    score: 0, kills: 0, deaths: 0,
    lastShot: 0, respawnAt: 0, grounded: true
  };
  io.to(r.id).emit('lobby', lobbyState(r));
  socket.emit('me', socket.id);
}

function lobbyState(r) {
  return { id: r.id, type: r.type, state: r.state,
    list: Object.values(r.players).map(p => ({ id: p.id, name: p.name, host: p.host }))
  };
}

function begin(r) {
  r.state = 'playing';
  r.bullets = []; r.items = []; r.zombies = [];
  r.scores = { red: 0, blue: 0 }; r.wave = 0;
  const ids = Object.keys(r.players);

  if (r.type === 'team' || r.type === 'ctf') {
    ids.forEach((id, i) => {
      r.players[id].team = i < Math.ceil(ids.length/2) ? 'red' : 'blue';
      r.players[id].color = r.players[id].team === 'red' ? '#ff4466' : '#4488ff';
    });
  }

  ids.forEach(id => {
    const p = r.players[id];
    p.x = rnd(-60, 60); p.y = 0; p.z = rnd(-60, 60);
    p.hp = 100; p.alive = true; p.score = 0; p.kills = 0; p.deaths = 0;
  });

  if (r.type === 'battle') {
    r.zone = { x: 0, z: 0, r: 120, tr: 120, tx: 0, tz: 0, next: Date.now() + 25000 };
  }

  for (let i = 0; i < 15; i++) {
    r.items.push({ x: rnd(-80, 80), y: 0.5, z: rnd(-80, 80), type: 'hp' });
  }

  io.to(r.id).emit('start', { type: r.type, map: MAP });
  r.loop = setInterval(() => tick(r), 1000 / 30);
}

function tick(r) {
  if (r.state !== 'playing') return;

  for (const p of Object.values(r.players)) {
    if (!p.alive) {
      if (p.respawnAt && Date.now() > p.respawnAt && r.type !== 'battle') {
        p.alive = true; p.hp = 100;
        p.x = rnd(-40, 40); p.y = 0; p.z = rnd(-40, 40);
        p.respawnAt = 0;
      }
      continue;
    }

    const spd = 0.35;
    const sin = Math.sin(p.ry), cos = Math.cos(p.ry);
    const fx = p.mx * cos - p.mz * sin;
    const fz = p.mx * sin + p.mz * cos;
    p.x += fx * spd;
    p.z += fz * spd;

    // Gravity
    p.vy -= 0.4;
    p.y += p.vy * 0.05;
    if (p.y <= 0) { p.y = 0; p.vy = 0; p.grounded = true; }

    p.x = Math.max(-MAP/2, Math.min(MAP/2, p.x));
    p.z = Math.max(-MAP/2, Math.min(MAP/2, p.z));
  }

  r.bullets = r.bullets.filter(b => {
    b.x += b.vx * 0.033; b.y += b.vy * 0.033; b.z += b.vz * 0.033;
    b.life--;
    if (b.life <= 0 || b.y < 0) return false;

    for (const p of Object.values(r.players)) {
      if (!p.alive || p.id === b.owner) continue;
      if (p.team && p.team === b.team) continue;
      if (d3(p, b) < 2) {
        p.hp -= 18;
        if (p.hp <= 0) {
          p.alive = false; p.deaths++;
          const k = r.players[b.owner];
          if (k) { k.kills++; k.score += 100; }
          if (r.type === 'battle') {
            const alive = Object.values(r.players).filter(pp => pp.alive);
            if (alive.length <= 1) return end(r, alive[0]?.id, null);
          } else { p.respawnAt = Date.now() + 3000; }
        }
        return false;
      }
    }

    for (let i = r.zombies.length - 1; i >= 0; i--) {
      const z = r.zombies[i];
      if (d3(z, b) < 2) {
        z.hp -= 18;
        if (z.hp <= 0) {
          r.zombies.splice(i, 1);
          const k = r.players[b.owner];
          if (k) { k.kills++; k.score += 10; }
        }
        return false;
      }
    }
    return true;
  });

  if (r.type === 'battle' && r.zone) {
    const z = r.zone;
    if (Date.now() > z.next && z.tr > 15) {
      z.tr *= 0.6;
      z.tx = rnd(-20, 20); z.tz = rnd(-20, 20);
      z.next = Date.now() + 25000;
    }
    z.r += (z.tr - z.r) * 0.008;
    z.x += (z.tx - z.x) * 0.008;
    z.z += (z.tz - z.z) * 0.008;
    for (const p of Object.values(r.players)) {
      if (!p.alive) continue;
      const dd = Math.sqrt((p.x-z.x)**2 + (p.z-z.z)**2);
      if (dd > z.r) { p.hp -= 0.4; if (p.hp <= 0) { p.alive = false; p.deaths++; } }
    }
  }

  if (r.type === 'team') {
    r.scores.red = Object.values(r.players).filter(p => p.team==='red').reduce((s,p) => s+p.kills, 0);
    r.scores.blue = Object.values(r.players).filter(p => p.team==='blue').reduce((s,p) => s+p.kills, 0);
    if (r.scores.red >= 20) end(r, null, 'red');
    if (r.scores.blue >= 20) end(r, null, 'blue');
  }

  if (r.type === 'zombie') {
    const alive = Object.values(r.players).filter(p => p.alive);
    if (r.zombies.length === 0 && Date.now() > (r.waveTimer || 0)) {
      r.wave++;
      for (let i = 0; i < 4 + r.wave * 3; i++) {
        const a = Math.random() * Math.PI * 2;
        r.zombies.push({
          x: Math.cos(a) * 90, y: 0, z: Math.sin(a) * 90,
          hp: 30 + r.wave * 8, speed: 0.06 + r.wave * 0.005, lastAtk: 0
        });
      }
      r.waveTimer = Date.now() + 999999;
    }
    r.zombies.forEach(z => {
      let near = null, nd = Infinity;
      alive.forEach(p => { const d = d3(p, z); if (d < nd) { nd = d; near = p; } });
      if (near) {
        const dx = near.x - z.x, dz = near.z - z.z;
        const d = Math.sqrt(dx*dx + dz*dz) || 1;
        z.x += (dx/d) * z.speed; z.z += (dz/d) * z.speed;
        if (d < 2.5 && Date.now() - z.lastAtk > 800) {
          z.lastAtk = Date.now(); near.hp -= 8;
          if (near.hp <= 0) { near.alive = false; near.deaths++; }
        }
      }
    });
    if (alive.length === 0 && r.wave > 0) end(r, null, null, r.wave);
    if (r.zombies.length === 0 && r.wave > 0) {
      r.waveTimer = Date.now() + 4000;
      alive.forEach(p => p.hp = Math.min(100, p.hp + 20));
    }
  }

  r.items = r.items.filter(it => {
    for (const p of Object.values(r.players)) {
      if (!p.alive) continue;
      if (d3(p, it) < 2.5) {
        if (it.type === 'hp') p.hp = Math.min(100, p.hp + 30);
        return false;
      }
    }
    return true;
  });

  const state = { players: {}, bullets: r.bullets, items: r.items, zombies: r.zombies, zone: r.zone, scores: r.scores, wave: r.wave };
  for (const p of Object.values(r.players)) {
    state.players[p.id] = {
      x: p.x, y: p.y, z: p.z, ry: p.ry,
      hp: p.hp, maxHp: p.maxHp, alive: p.alive,
      team: p.team, color: p.color, name: p.name,
      score: p.score, kills: p.kills, deaths: p.deaths
    };
  }
  io.to(r.id).emit('state', state);
}

function end(r, wid, wteam, wave) {
  r.state = 'ended';
  if (r.loop) clearInterval(r.loop);
  io.to(r.id).emit('end', {
    winnerId: wid, winnerTeam: wteam, wave,
    list: Object.values(r.players).map(p => ({
      id: p.id, name: p.name, score: p.score, kills: p.kills, deaths: p.deaths, team: p.team
    })).sort((a,b) => b.score - a.score)
  });
}

server.listen(3000, () => console.log('🎮 GAMEVERSE 3D: http://localhost:3000'));
