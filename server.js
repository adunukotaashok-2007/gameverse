const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const TICK = 1000 / 60;
const rooms = {};

// ===================== CONFIGS =====================
const CONFIGS = {
  battleroyale: {
    mapW: 3000, mapH: 3000, maxPlayers: 30,
    hp: 100, speed: 3, bulletSpeed: 12, fireRate: 280,
    zoneShrink: 25000, zoneDmg: 4, weaponSpawns: 30, healthSpawns: 15
  },
  teamshooter: {
    mapW: 2000, mapH: 1500, maxPlayers: 8, perTeam: 4,
    hp: 100, speed: 4, bulletSpeed: 14, fireRate: 180,
    respawn: 3000, scoreToWin: 25
  },
  ctf: {
    mapW: 2400, mapH: 1400, maxPlayers: 10, perTeam: 5,
    hp: 100, speed: 3.5, bulletSpeed: 12, fireRate: 250,
    respawn: 3000, capturesToWin: 3, flagReturnTime: 15000
  },
  zombie: {
    mapW: 2000, mapH: 2000, maxPlayers: 8,
    hp: 150, speed: 3.2, bulletSpeed: 13, fireRate: 200,
    waveInterval: 5000, zombieSpeed: 1.2, zombieHp: 40, zombieDmg: 10,
    zombiesPerWave: 8, waveGrowth: 4
  },
  deathmatch: {
    mapW: 1600, mapH: 1600, maxPlayers: 12,
    hp: 100, speed: 3.8, bulletSpeed: 13, fireRate: 200,
    respawn: 2000, scoreToWin: 20, powerupInterval: 8000
  },
  koth: {
    mapW: 1800, mapH: 1800, maxPlayers: 10, perTeam: 5,
    hp: 100, speed: 3.5, bulletSpeed: 12, fireRate: 250,
    respawn: 3000, scoreToWin: 100, hillRadius: 120, hillMoveInterval: 20000
  }
};

// ===================== ROOM MGMT =====================
io.on('connection', (socket) => {
  let roomId = null, pName = null;

  socket.on('createRoom', ({ name, gameType }, cb) => {
    const id = uuid().slice(0, 6).toUpperCase();
    rooms[id] = {
      id, type: gameType, players: {}, state: 'lobby',
      cfg: CONFIGS[gameType], tick: 0,
      projectiles: [], pickups: [], entities: [],
      zone: null, flags: null, hill: null, wave: 0,
      teamScores: { red: 0, blue: 0 }, startTime: 0
    };
    roomId = id; pName = name || 'Player';
    joinRoom(socket, rooms[id], pName);
    cb({ ok: true, roomId: id });
  });

  socket.on('joinRoom', ({ name, roomId: rid }, cb) => {
    rid = rid.toUpperCase();
    const r = rooms[rid];
    if (!r) return cb({ ok: false, err: 'Room not found' });
    if (Object.keys(r.players).length >= r.cfg.maxPlayers) return cb({ ok: false, err: 'Full' });
    if (r.state === 'playing') return cb({ ok: false, err: 'Game in progress' });
    roomId = rid; pName = name || 'Player';
    joinRoom(socket, r, pName);
    cb({ ok: true, roomId: rid });
  });

  socket.on('startGame', () => {
    if (!roomId) return;
    const r = rooms[roomId];
    const p = r.players[socket.id];
    if (!p?.isHost) return;
    const count = Object.keys(r.players).length;
    const min = r.type === 'zombie' ? 1 : 2;
    if (count < min) return socket.emit('toast', `Need ${min}+ players`);
    startGame(r);
  });

  socket.on('input', (inp) => {
    if (!roomId) return;
    const r = rooms[roomId];
    const p = r?.players[socket.id];
    if (p && r.state === 'playing') p.input = inp;
  });

  socket.on('shoot', (data) => {
    if (!roomId) return;
    const r = rooms[roomId];
    const p = r?.players[socket.id];
    if (!p || !p.alive || r.state !== 'playing') return;
    const now = Date.now();
    if (now - (p.lastShot || 0) < (p.fireRate || r.cfg.fireRate)) return;
    p.lastShot = now;
    r.projectiles.push({
      id: uuid().slice(0, 6), x: p.x, y: p.y,
      vx: Math.cos(data.angle) * (p.bulletSpeed || r.cfg.bulletSpeed),
      vy: Math.sin(data.angle) * (p.bulletSpeed || r.cfg.bulletSpeed),
      owner: socket.id, team: p.team, dmg: p.dmg || 20, life: 55
    });
  });

  socket.on('disconnect', () => {
    if (!roomId || !rooms[roomId]) return;
    const r = rooms[roomId];
    delete r.players[socket.id];
    io.to(roomId).emit('roomUpdate', roomState(r));
    if (Object.keys(r.players).length === 0) {
      clearInterval(r.loop);
      delete rooms[roomId];
    }
  });
});

function joinRoom(socket, r, name) {
  socket.join(r.id);
  const host = Object.keys(r.players).length === 0;
  r.players[socket.id] = {
    id: socket.id, name, isHost: host,
    x: 0, y: 0, vx: 0, vy: 0, radius: 16,
    hp: r.cfg.hp, maxHp: r.cfg.hp,
    score: 0, kills: 0, deaths: 0,
    team: null, color: rndColor(), angle: 0,
    input: { mx: 0, my: 0 }, alive: true,
    respawnAt: 0, lastShot: 0,
    weapon: 'pistol', dmg: 20, fireRate: r.cfg.fireRate,
    bulletSpeed: r.cfg.bulletSpeed,
    hasFlag: null, shield: 0, speedBoost: 0
  };
  io.to(r.id).emit('roomUpdate', roomState(r));
  socket.emit('joined', { roomId: r.id, pid: socket.id });
}

function roomState(r) {
  return {
    id: r.id, type: r.type, state: r.state,
    players: Object.values(r.players).map(p => ({
      id: p.id, name: p.name, isHost: p.isHost
    }))
  };
}

// ===================== START GAME =====================
function startGame(r) {
  r.state = 'playing';
  r.tick = 0;
  r.startTime = Date.now();
  r.projectiles = [];
  r.pickups = [];
  r.entities = [];
  r.teamScores = { red: 0, blue: 0 };
  const c = r.cfg;
  const ids = Object.keys(r.players);

  // Team assignment
  const teamGames = ['teamshooter', 'ctf', 'koth'];
  if (teamGames.includes(r.type)) {
    ids.forEach((id, i) => {
      r.players[id].team = i < c.perTeam ? 'red' : 'blue';
      r.players[id].color = i < c.perTeam ? '#ff4466' : '#4488ff';
    });
  }

  // Spawn players
  ids.forEach(id => {
    const p = r.players[id];
    spawnPlayer(r, p);
  });

  // Game-specific init
  if (r.type === 'battleroyale') initBR(r);
  if (r.type === 'ctf') initCTF(r);
  if (r.type === 'deathmatch') initDM(r);
  if (r.type === 'koth') initKOTH(r);
  if (r.type === 'zombie') initZombie(r);

  io.to(r.id).emit('gameStart', {
    type: r.type, cfg: c,
    entities: r.entities, pickups: r.pickups,
    zone: r.zone, flags: r.flags, hill: r.hill
  });

  r.loop = setInterval(() => tick(r), TICK);
}

function spawnPlayer(r, p) {
  const c = r.cfg;
  if (r.type === 'ctf' || r.type === 'koth' || r.type === 'teamshooter') {
    const isRed = p.team === 'red';
    p.x = isRed ? 100 + Math.random() * 200 : c.mapW - 300 + Math.random() * 200;
    p.y = Math.random() * c.mapH;
  } else {
    p.x = 100 + Math.random() * (c.mapW - 200);
    p.y = 100 + Math.random() * (c.mapH - 200);
  }
  p.hp = c.hp; p.maxHp = c.hp;
  p.alive = true; p.hasFlag = null;
  p.weapon = 'pistol'; p.dmg = 20;
  p.fireRate = c.fireRate; p.bulletSpeed = c.bulletSpeed;
  p.shield = 0; p.speedBoost = 0;
}

// ===================== GAME INIT =====================
function initBR(r) {
  const c = r.cfg;
  r.zone = {
    x: c.mapW / 2, y: c.mapH / 2,
    radius: Math.max(c.mapW, c.mapH),
    targetR: Math.max(c.mapW, c.mapH),
    tx: c.mapW / 2, ty: c.mapH / 2,
    nextShrink: Date.now() + c.zoneShrink
  };
  const weps = ['shotgun', 'rifle', 'sniper', 'smg'];
  for (let i = 0; i < c.weaponSpawns; i++) {
    r.pickups.push({
      id: uuid().slice(0, 6), type: 'weapon',
      weapon: weps[Math.floor(Math.random() * weps.length)],
      x: Math.random() * c.mapW, y: Math.random() * c.mapH, radius: 12
    });
  }
  for (let i = 0; i < c.healthSpawns; i++) {
    r.pickups.push({
      id: uuid().slice(0, 6), type: 'health', heal: 40,
      x: Math.random() * c.mapW, y: Math.random() * c.mapH, radius: 10
    });
  }
}

function initCTF(r) {
  const c = r.cfg;
  r.flags = {
    red: { x: 80, y: c.mapH / 2, home: true, carrier: null, color: '#ff4466' },
    blue: { x: c.mapW - 80, y: c.mapH / 2, home: true, carrier: null, color: '#4488ff' }
  };
}

function initDM(r) {
  r.lastPowerup = Date.now();
}

function initKOTH(r) {
  const c = r.cfg;
  r.hill = {
    x: c.mapW / 2, y: c.mapH / 2,
    radius: c.hillRadius,
    tx: c.mapW / 2, ty: c.mapH / 2,
    nextMove: Date.now() + c.hillMoveInterval
  };
}

function initZombie(r) {
  r.wave = 0;
  r.waveTimer = Date.now() + 3000;
  r.zombiesAlive = 0;
  r.entities = [];
}

// ===================== GAME TICK =====================
function tick(r) {
  if (r.state !== 'playing') return;
  r.tick++;
  const c = r.cfg;

  // Move players
  Object.values(r.players).forEach(p => {
    if (!p.alive) {
      if (p.respawnAt && Date.now() > p.respawnAt && r.type !== 'battleroyale' && r.type !== 'zombie') {
        spawnPlayer(r, p);
      }
      return;
    }
    const spd = (c.speed + (p.speedBoost > Date.now() ? 2 : 0));
    if (p.input) {
      let mx = p.input.mx || 0, my = p.input.my || 0;
      const mag = Math.sqrt(mx * mx + my * my) || 1;
      p.x += (mx / mag) * spd;
      p.y += (my / mag) * spd;
      p.angle = Math.atan2(my, mx);
    }
    p.x = Math.max(p.radius, Math.min(c.mapW - p.radius, p.x));
    p.y = Math.max(p.radius, Math.min(c.mapH - p.radius, p.y));
  });

  // Projectiles
  r.projectiles = r.projectiles.filter(b => {
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.life <= 0 || b.x < 0 || b.x > c.mapW || b.y < 0 || b.y > c.mapH) return false;

    // Hit players
    for (const p of Object.values(r.players)) {
      if (!p.alive || p.id === b.owner) continue;
      if (p.team && p.team === b.team) continue;
      if (dist(p, b) < p.radius + 4) {
        let dmg = b.dmg;
        if (p.shield > Date.now()) dmg *= 0.3;
        p.hp -= dmg;
        if (p.hp <= 0) killPlayer(r, p, b.owner);
        return false;
      }
    }

    // Hit zombies
    if (r.type === 'zombie') {
      for (let i = r.entities.length - 1; i >= 0; i--) {
        const z = r.entities[i];
        if (z.type !== 'zombie') continue;
        if (dist(z, b) < z.radius + 4) {
          z.hp -= b.dmg;
          if (z.hp <= 0) {
            r.entities.splice(i, 1);
            r.zombiesAlive--;
            const killer = r.players[b.owner];
            if (killer) { killer.score += 10; killer.kills++; }
          }
          return false;
        }
      }
    }
    return true;
  });

  // Game-specific
  if (r.type === 'battleroyale') tickBR(r);
  if (r.type === 'teamshooter') tickTDM(r);
  if (r.type === 'ctf') tickCTF(r);
  if (r.type === 'zombie') tickZombie(r);
  if (r.type === 'deathmatch') tickDM(r);
  if (r.type === 'koth') tickKOTH(r);

  // Broadcast
  const state = { players: {}, projectiles: r.projectiles, pickups: r.pickups, entities: r.entities, zone: r.zone, flags: r.flags, hill: r.hill, teamScores: r.teamScores, wave: r.wave, tick: r.tick };
  Object.values(r.players).forEach(p => {
    state.players[p.id] = {
      x: p.x, y: p.y, radius: p.radius, hp: p.hp, maxHp: p.maxHp,
      score: p.score, kills: p.kills, deaths: p.deaths,
      name: p.name, color: p.color, angle: p.angle,
      alive: p.alive, team: p.team, weapon: p.weapon,
      hasFlag: p.hasFlag, shield: p.shield > Date.now()
    };
  });
  io.to(r.id).emit('state', state);
}

function killPlayer(r, victim, killerId) {
  victim.alive = false;
  victim.deaths++;
  victim.hp = 0;
  const killer = r.players[killerId];
  if (killer) { killer.kills++; killer.score += 100; }

  // Drop flag
  if (victim.hasFlag) {
    const flag = r.flags[victim.hasFlag];
    if (flag) {
      flag.carrier = null;
      flag.x = victim.x;
      flag.y = victim.y;
      flag.home = false;
      flag.dropTime = Date.now();
    }
    victim.hasFlag = null;
  }

  if (r.type === 'battleroyale') {
    const alive = Object.values(r.players).filter(p => p.alive);
    if (alive.length <= 1) endGame(r, alive[0]?.id);
  } else {
    victim.respawnAt = Date.now() + (r.cfg.respawn || 3000);
  }
}

// ===================== BR =====================
function tickBR(r) {
  const c = r.cfg, z = r.zone;
  if (!z) return;
  if (Date.now() > z.nextShrink && z.targetR > 80) {
    z.targetR *= 0.6;
    z.tx = c.mapW / 2 + (Math.random() - 0.5) * z.targetR * 0.3;
    z.ty = c.mapH / 2 + (Math.random() - 0.5) * z.targetR * 0.3;
    z.nextShrink = Date.now() + c.zoneShrink;
  }
  z.radius += (z.targetR - z.radius) * 0.008;
  z.x += (z.tx - z.x) * 0.008;
  z.y += (z.ty - z.y) * 0.008;

  Object.values(r.players).forEach(p => {
    if (!p.alive) return;
    if (dist(p, z) > z.radius) {
      p.hp -= c.zoneDmg * (TICK / 1000);
      if (p.hp <= 0) killPlayer(r, p, null);
    }
  });

  r.pickups = r.pickups.filter(pk => {
    for (const p of Object.values(r.players)) {
      if (!p.alive) continue;
      if (dist(p, pk) < p.radius + pk.radius) {
        if (pk.type === 'health') p.hp = Math.min(p.maxHp, p.hp + pk.heal);
        if (pk.type === 'weapon') {
          p.weapon = pk.weapon;
          p.dmg = { shotgun: 35, rifle: 15, sniper: 55, smg: 10 }[pk.weapon];
          p.fireRate = { shotgun: 700, rifle: 180, sniper: 1100, smg: 90 }[pk.weapon];
          p.bulletSpeed = { shotgun: 10, rifle: 14, sniper: 18, smg: 13 }[pk.weapon];
        }
        return false;
      }
    }
    return true;
  });
}

function tickTDM(r) {
  r.teamScores.red = Object.values(r.players).filter(p => p.team === 'red').reduce((s, p) => s + p.kills, 0);
  r.teamScores.blue = Object.values(r.players).filter(p => p.team === 'blue').reduce((s, p) => s + p.kills, 0);
  if (r.teamScores.red >= r.cfg.scoreToWin) endGame(r, null, 'red');
  if (r.teamScores.blue >= r.cfg.scoreToWin) endGame(r, null, 'blue');
}

// ===================== CTF =====================
function tickCTF(r) {
  const c = r.cfg, f = r.flags;
  if (!f) return;

  ['red', 'blue'].forEach(team => {
    const flag = f[team];
    // Auto-return dropped flag
    if (!flag.home && !flag.carrier && flag.dropTime && Date.now() - flag.dropTime > c.flagReturnTime) {
      flag.home = true;
      flag.x = team === 'red' ? 80 : c.mapW - 80;
      flag.y = c.mapH / 2;
    }

    // Pickup enemy flag
    const enemy = team === 'red' ? 'blue' : 'red';
    Object.values(r.players).forEach(p => {
      if (!p.alive || p.team !== team || p.hasFlag) return;
      const ef = f[enemy];
      if (!ef.carrier && dist(p, ef) < p.radius + 20) {
        ef.carrier = p.id;
        p.hasFlag = enemy;
      }
    });

    // Capture
    Object.values(r.players).forEach(p => {
      if (!p.alive || p.hasFlag !== enemy) return;
      const homeFlag = f[team];
      if (homeFlag.home && dist(p, homeFlag) < 50) {
        r.teamScores[team]++;
        p.hasFlag = null;
        f[enemy].carrier = null;
        f[enemy].home = true;
        f[enemy].x = enemy === 'red' ? 80 : c.mapW - 80;
        f[enemy].y = c.mapH / 2;
        p.score += 500;
        if (r.teamScores[team] >= c.capturesToWin) endGame(r, null, team);
      }
    });

    // Move flag with carrier
    if (flag.carrier) {
      const carrier = r.players[flag.carrier];
      if (carrier?.alive) {
        flag.x = carrier.x;
        flag.y = carrier.y;
      } else {
        flag.carrier = null;
        flag.dropTime = Date.now();
        if (carrier) carrier.hasFlag = null;
      }
    }
  });
}

// ===================== ZOMBIE =====================
function tickZombie(r) {
  const c = r.cfg;
  if (Date.now() > r.waveTimer && r.zombiesAlive <= 0) {
    r.wave++;
    const count = c.zombiesPerWave + (r.wave - 1) * c.waveGrowth;
    for (let i = 0; i < count; i++) {
      const side = Math.floor(Math.random() * 4);
      let x, y;
      if (side === 0) { x = Math.random() * c.mapW; y = -20; }
      else if (side === 1) { x = c.mapW + 20; y = Math.random() * c.mapH; }
      else if (side === 2) { x = Math.random() * c.mapW; y = c.mapH + 20; }
      else { x = -20; y = Math.random() * c.mapH; }

      const isBoss = r.wave >= 3 && Math.random() < 0.1;
      r.entities.push({
        id: uuid().slice(0, 6), type: 'zombie',
        x, y, radius: isBoss ? 24 : 12,
        hp: isBoss ? c.zombieHp * 5 : c.zombieHp + r.wave * 5,
        maxHp: isBoss ? c.zombieHp * 5 : c.zombieHp + r.wave * 5,
        speed: isBoss ? c.zombieSpeed * 0.6 : c.zombieSpeed + r.wave * 0.08,
        dmg: isBoss ? c.zombieDmg * 3 : c.zombieDmg,
        color: isBoss ? '#ff0000' : '#44aa44',
        lastAttack: 0
      });
      r.zombiesAlive++;
    }
    r.waveTimer = Date.now() + 999999;
  }

  // Check wave clear
  if (r.zombiesAlive <= 0 && r.wave > 0) {
    r.waveTimer = Date.now() + c.waveInterval;
    // Heal players between waves
    Object.values(r.players).forEach(p => {
      if (p.alive) p.hp = Math.min(p.maxHp, p.hp + 30);
    });
  }

  // Move zombies toward nearest player
  r.entities.forEach(z => {
    if (z.type !== 'zombie') return;
    let nearest = null, nearDist = Infinity;
    Object.values(r.players).forEach(p => {
      if (!p.alive) return;
      const d = dist(p, z);
      if (d < nearDist) { nearDist = d; nearest = p; }
    });
    if (nearest) {
      const dx = nearest.x - z.x, dy = nearest.y - z.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      z.x += (dx / d) * z.speed;
      z.y += (dy / d) * z.speed;

      // Attack
      if (d < nearest.radius + z.radius + 4 && Date.now() - z.lastAttack > 800) {
        z.lastAttack = Date.now();
        nearest.hp -= z.dmg;
        if (nearest.hp <= 0) {
          nearest.alive = false;
          nearest.deaths++;
          // In zombie mode, dead players spectate until next wave
          nearest.respawnAt = Date.now() + 999999;
        }
      }
    }
  });

  // Check all dead
  const alive = Object.values(r.players).filter(p => p.alive);
  if (alive.length === 0 && r.wave > 0) {
    endGame(r, null, null, r.wave);
  }
}

// ===================== DEATHMATCH =====================
function tickDM(r) {
  const c = r.cfg;
  // Powerups
  if (Date.now() - (r.lastPowerup || 0) > c.powerupInterval) {
    r.lastPowerup = Date.now();
    const types = ['speed', 'shield', 'damage', 'rapid'];
    r.pickups.push({
      id: uuid().slice(0, 6), type: 'powerup',
      power: types[Math.floor(Math.random() * types.length)],
      x: 100 + Math.random() * (c.mapW - 200),
      y: 100 + Math.random() * (c.mapH - 200),
      radius: 14
    });
  }

  r.pickups = r.pickups.filter(pk => {
    for (const p of Object.values(r.players)) {
      if (!p.alive) continue;
      if (dist(p, pk) < p.radius + pk.radius) {
        if (pk.type === 'powerup') {
          const dur = 8000;
          if (pk.power === 'speed') p.speedBoost = Date.now() + dur;
          if (pk.power === 'shield') p.shield = Date.now() + dur;
          if (pk.power === 'damage') { p.dmg = 45; setTimeout(() => { if (r.players[p.id]) r.players[p.id].dmg = 20; }, dur); }
          if (pk.power === 'rapid') { p.fireRate = 60; setTimeout(() => { if (r.players[p.id]) r.players[p.id].fireRate = c.fireRate; }, dur); }
          p.score += 25;
        }
        return false;
      }
    }
    return true;
  });

  // Win check
  for (const p of Object.values(r.players)) {
    if (p.kills >= c.scoreToWin) endGame(r, p.id);
  }
}

// ===================== KOTH =====================
function tickKOTH(r) {
  const c = r.cfg, h = r.hill;
  if (!h) return;

  // Move hill
  if (Date.now() > h.nextMove) {
    h.tx = 200 + Math.random() * (c.mapW - 400);
    h.ty = 200 + Math.random() * (c.mapH - 400);
    h.nextMove = Date.now() + c.hillMoveInterval;
  }
  h.x += (h.tx - h.x) * 0.01;
  h.y += (h.ty - h.y) * 0.01;

  // Score for team in hill
  const inHill = { red: 0, blue: 0 };
  Object.values(r.players).forEach(p => {
    if (!p.alive || !p.team) return;
    if (dist(p, h) < h.radius) inHill[p.team]++;
  });

  if (inHill.red > 0 && inHill.blue === 0) r.teamScores.red += 0.05;
  if (inHill.blue > 0 && inHill.red === 0) r.teamScores.blue += 0.05;

  if (r.teamScores.red >= c.scoreToWin) endGame(r, null, 'red');
  if (r.teamScores.blue >= c.scoreToWin) endGame(r, null, 'blue');
}

// ===================== END =====================
function endGame(r, winnerId, winnerTeam, waveReached) {
  r.state = 'ended';
  clearInterval(r.loop);
  io.to(r.id).emit('gameEnd', {
    winnerId, winnerTeam, waveReached,
    players: Object.values(r.players).map(p => ({
      id: p.id, name: p.name, score: p.score,
      kills: p.kills, deaths: p.deaths, team: p.team
    })).sort((a, b) => b.score - a.score)
  });
}

// ===================== UTILS =====================
function dist(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }
function rndColor() {
  const c = ['#ff4466', '#00f0ff', '#00ff88', '#ffaa00', '#aa44ff', '#ff88cc', '#44ddff', '#ffdd44'];
  return c[Math.floor(Math.random() * c.length)];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 GAMEVERSE on http://localhost:${PORT}`));
