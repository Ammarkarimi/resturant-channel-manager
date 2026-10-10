const express = require('express');
const {
  getProperty, saveProperty, listRoomTypes, createRoomType, updateRoomType, deleteRoomType,
} = require('../hotel');
const { logActivity } = require('../activity');

/** Settings: the hotel itself and its room types. */
function hotelRoutes({ db, engine }) {
  const r = express.Router();

  r.get('/property', (req, res) => res.json(getProperty(db)));

  r.patch('/property', (req, res) => {
    const before = getProperty(db);
    const after = saveProperty(db, { ...before, ...req.body });
    const changes = [];
    if (after.name !== before.name) changes.push(`name to "${after.name}"`);
    if (after.currency !== before.currency) changes.push(`currency to ${after.currency}`);
    if (changes.length) logActivity(db, req.user, `Changed hotel ${changes.join(' and ')}`);
    res.json(after);
  });

  r.get('/room-types', (req, res) => res.json(listRoomTypes(db)));

  r.post('/room-types', (req, res) => {
    const rt = createRoomType(db, req.body || {});
    logActivity(db, req.user, `Added room type ${rt.name} (${rt.code}): ${rt.total_rooms} rooms at ${rt.base_rate}`);
    engine.kick();
    res.status(201).json(rt);
  });

  r.patch('/room-types/:id', (req, res) => {
    const before = db.prepare('SELECT * FROM room_types WHERE id = ?').get(Number(req.params.id));
    const rt = updateRoomType(db, Number(req.params.id), req.body || {});
    const changes = ['name', 'total_rooms', 'base_rate']
      .filter((k) => before[k] !== rt[k])
      .map((k) => `${k.replace('_', ' ')} ${before[k]} → ${rt[k]}`);
    if (changes.length) logActivity(db, req.user, `Changed ${rt.name}: ${changes.join(', ')}`);
    engine.kick();
    res.json(rt);
  });

  r.delete('/room-types/:id', (req, res) => {
    const rt = deleteRoomType(db, Number(req.params.id));
    logActivity(db, req.user, `Deleted room type ${rt.name} (${rt.code})`);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { hotelRoutes };
