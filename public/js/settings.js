// Settings page: hotel details, room types and rate plans, occupancy-based
// pricing, properties, users and roles, own password and two-factor login.

async function loadHotelForm() {
  const p = await api('GET', '/api/property');
  const f = $('#hotel-form');
  f.name.value = p.name;
  f.city.value = p.city || '';
  f.country.value = p.country || '';
  $('#hotel-currency').innerHTML = currencyOptions(p.currency);
}

$('#hotel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  if (f.currency !== state.property.currency && !confirm(`Change currency to ${f.currency}? Existing prices are not converted.`)) return;
  try {
    const p = await api('PATCH', '/api/property', f);
    Object.assign(state.property, p);
    const listed = state.properties.find((x) => x.id === p.id);
    if (listed) Object.assign(listed, p);
    renderPropertySwitch();
    flash($('#hotel-msg'), 'Saved.');
  } catch (err) {
    flash($('#hotel-msg'), err.message, false);
  }
});

// ---------- Room types & rate plans ----------

function planPrices(p) {
  if (p.parent_id) {
    const parent = state.roomTypes.flatMap((r) => r.rate_plans).find((x) => x.id === p.parent_id);
    const v = p.derive_value;
    const amount = p.derive_type === 'percent' ? `${v >= 0 ? '+' : ''}${v}%` : `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;
    return `<span class="muted">Derived:</span> ${esc(parent?.name ?? '?')}${parent && parent.room_type_id !== p.room_type_id ? ` (${esc(state.roomTypes.find((r) => r.id === parent.room_type_id)?.name)})` : ''} ${amount}`;
  }
  const parts = [`<strong>${money(p.rate_double)}</strong> 2 adults`];
  if (p.rate_single != null) parts.push(`${money(p.rate_single)} 1 adult`);
  if (p.rate_triple != null) parts.push(`${money(p.rate_triple)} 3 adults`);
  if (p.extra_adult != null) parts.push(`+${money(p.extra_adult)} extra adult`);
  if (p.extra_child != null) parts.push(`+${money(p.extra_child)} extra child`);
  return parts.join(' · ');
}

async function loadRoomTypes() {
  await ensureRoomTypes();
  const edit = can('setup');
  $('#room-types').innerHTML = state.roomTypes.length === 0
    ? '<p class="muted">No room types yet. Add the kinds of rooms you sell, e.g. "Deluxe Room, 10 rooms, ₹4,500 a night".</p>'
    : state.roomTypes.map((rt) => `
      <div class="room-card">
        <div class="section-head">
          <div><strong>${esc(rt.name)}</strong> <code>${esc(rt.code)}</code>
            <span class="muted small">${rt.total_rooms} rooms · up to ${rt.max_adults} adult${rt.max_adults === 1 ? "" : "s"}, ${rt.max_children} child${rt.max_children === 1 ? "" : "ren"} · ${rt.upcoming_bookings} upcoming booking(s)</span></div>
          ${edit ? `<div class="nowrap"><button data-edit-room="${rt.id}">Edit</button> <button data-add-plan="${rt.id}">Add rate plan</button>
            <button data-delete-room="${rt.id}" class="danger">Delete</button></div>` : ''}
        </div>
        <table class="list"><tbody>${rt.rate_plans.map((p) => `<tr>
          <td><strong>${esc(p.name)}</strong> <code>${esc(p.code)}</code><div class="muted small">${esc(MEAL_PLANS[p.meal_plan] || p.meal_plan)}</div></td>
          <td>${planPrices(p)}</td>
          <td>${p.active ? '<span class="badge ok">On sale</span>' : '<span class="badge off">Switched off</span>'}</td>
          <td class="nowrap">${edit ? `<button data-edit-plan="${p.id}">Edit</button> <button data-delete-plan="${p.id}" class="danger">Delete</button>` : ''}</td>
        </tr>`).join('') || '<tr><td class="muted">No rate plans yet: add one to start selling this room.</td></tr>'}</tbody></table>
      </div>`).join('');
}

function roomDialog(rt) {
  openDialog({
    title: rt ? `Edit ${rt.name}` : 'Add room type',
    body: `
      <label>Code <input name="code" required maxlength="10" pattern="[A-Za-z0-9]{2,10}" placeholder="e.g. DLX" value="${esc(rt?.code || '')}" ${rt ? 'disabled' : ''}>
        <span class="muted small">2–10 letters or digits. Can't be changed later.</span></label>
      <label>Name <input name="name" required maxlength="80" placeholder="e.g. Deluxe Room" value="${esc(rt?.name || '')}"></label>
      <div class="row two">
        <label>Number of rooms <input name="total_rooms" type="number" min="1" max="1000" step="1" required value="${rt?.total_rooms ?? ''}"></label>
        <label>Max adults <input name="max_adults" type="number" min="1" max="20" value="${rt?.max_adults ?? 2}"></label>
        <label>Max children <input name="max_children" type="number" min="0" max="20" value="${rt?.max_children ?? 1}"></label>
        ${rt ? '' : '<label>Room-only price (2 adults) <input name="base_rate" type="number" min="1" step="0.01" placeholder="Optional"></label>'}
      </div>
      ${rt ? '' : '<p class="muted small">With a price, a "Room only (EP)" rate plan is created for you. You can add more plans afterwards.</p>'}`,
    onSave: async (form) => {
      const body = { name: form.name.value.trim(), total_rooms: Number(form.total_rooms.value), max_adults: Number(form.max_adults.value), max_children: Number(form.max_children.value) };
      if (rt) await api('PATCH', `/api/room-types/${rt.id}`, body);
      else await api('POST', '/api/room-types', { ...body, code: form.code.value.trim().toUpperCase(), base_rate: numOrNull(form.base_rate.value) });
      await loadRoomTypes();
      bulkBuiltFor = '';
      flash($('#rooms-msg'), rt ? 'Saved. Channels will be updated.' : 'Room type added.');
    },
  });
}

function planDialog(rt, plan) {
  const parents = state.roomTypes.flatMap((r) => r.rate_plans.filter((p) => !plan || p.id !== plan.id).map((p) => [p.id, `${r.name} · ${p.name}`]));
  const v = (k) => (plan?.[k] ?? '');
  openDialog({
    title: plan ? `Edit ${plan.name}` : `Add rate plan to ${rt.name}`,
    wide: true,
    body: `
      <div class="row two">
        <label>Code <input name="code" required maxlength="10" pattern="[A-Za-z0-9]{2,10}" placeholder="e.g. CP" value="${esc(v('code'))}" ${plan ? 'disabled' : ''}></label>
        <label>Name <input name="name" required maxlength="80" placeholder="e.g. With breakfast" value="${esc(v('name'))}"></label>
        <label>Meal plan <select name="meal_plan">${options(Object.entries(MEAL_PLANS), plan?.meal_plan || 'EP')}</select></label>
        <label>Pricing
          <select name="mode"><option value="own" ${plan?.parent_id ? '' : 'selected'}>Its own prices</option>
            <option value="derived" ${plan?.parent_id ? 'selected' : ''}>Derived from another plan</option></select></label>
      </div>
      <fieldset id="own-prices"><legend>Default prices per night (you can change single nights in the calendar)</legend>
        <div class="row two">
          <label>2 adults <input name="rate_double" type="number" min="1" step="0.01" value="${v('rate_double') || ''}"></label>
          <label>1 adult <input name="rate_single" type="number" min="1" step="0.01" value="${v('rate_single')}" placeholder="Same as 2 adults"></label>
          <label>3 adults <input name="rate_triple" type="number" min="1" step="0.01" value="${v('rate_triple')}" placeholder="2 adults + extra adult"></label>
          <label>Extra adult <input name="extra_adult" type="number" min="0" step="0.01" value="${v('extra_adult')}"></label>
          <label>Extra child <input name="extra_child" type="number" min="0" step="0.01" value="${v('extra_child')}"></label>
        </div>
      </fieldset>
      <fieldset id="derived-prices"><legend>Follow another plan</legend>
        <div class="row two">
          <label>Parent plan <select name="parent_id">${options(parents, plan?.parent_id ?? '')}</select></label>
          <label>Adjust by <select name="derive_type">${options([['amount', 'An amount'], ['percent', 'A percentage']], plan?.derive_type || 'amount')}</select></label>
          <label>Value <input name="derive_value" type="number" step="0.01" value="${v('derive_value')}" placeholder="e.g. 600 or -10"></label>
        </div>
        <p class="muted small">Example: "With breakfast" = "Room only" + 600. Negative values give a discount. Extra-guest charges come from the parent.</p>
      </fieldset>
      ${plan ? `<label class="check"><input type="checkbox" name="active" ${plan.active ? 'checked' : ''}> On sale (untick to close it on every channel)</label>` : ''}`,
    onOpen: (form) => {
      const sync = () => {
        const derived = form.mode.value === 'derived';
        $('#own-prices').hidden = derived;
        $('#derived-prices').hidden = !derived;
        form.rate_double.required = !derived;
        form.derive_value.required = derived;
      };
      form.mode.onchange = sync;
      sync();
    },
    onSave: async (form) => {
      const body = { name: form.name.value.trim(), meal_plan: form.meal_plan.value };
      if (form.mode.value === 'derived') {
        Object.assign(body, { parent_id: Number(form.parent_id.value), derive_type: form.derive_type.value, derive_value: Number(form.derive_value.value) });
      } else {
        if (plan?.parent_id) body.parent_id = null;
        for (const k of ['rate_double', 'rate_single', 'rate_triple', 'extra_adult', 'extra_child']) body[k] = numOrNull(form[k].value);
      }
      if (plan) {
        body.active = form.active.checked;
        await api('PATCH', `/api/rate-plans/${plan.id}`, body);
      } else {
        await api('POST', '/api/rate-plans', { ...body, room_type_id: rt.id, code: form.code.value.trim().toUpperCase() });
      }
      await loadRoomTypes();
      bulkBuiltFor = '';
      flash($('#rooms-msg'), plan ? 'Rate plan saved. Channels will be updated.' : 'Rate plan added.');
    },
  });
}

$('#room-add').addEventListener('click', () => roomDialog(null));
$('#room-types').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  const findPlan = (id) => state.roomTypes.flatMap((r) => r.rate_plans).find((p) => p.id === Number(id));
  try {
    if (d.editRoom) roomDialog(state.roomTypes.find((r) => r.id === Number(d.editRoom)));
    if (d.addPlan) planDialog(state.roomTypes.find((r) => r.id === Number(d.addPlan)), null);
    if (d.editPlan) {
      const p = findPlan(d.editPlan);
      planDialog(state.roomTypes.find((r) => r.id === p.room_type_id), p);
    }
    if (d.deleteRoom) {
      const rt = state.roomTypes.find((r) => r.id === Number(d.deleteRoom));
      if (!confirm(`Delete ${rt.name} and its rate plans? This can't be undone.`)) return;
      await api('DELETE', `/api/room-types/${rt.id}`);
      await loadRoomTypes();
      flash($('#rooms-msg'), `${rt.name} deleted.`);
    }
    if (d.deletePlan) {
      const p = findPlan(d.deletePlan);
      if (!confirm(`Delete the rate plan ${p.name}? Its nightly prices are lost.`)) return;
      await api('DELETE', `/api/rate-plans/${p.id}`);
      await loadRoomTypes();
      flash($('#rooms-msg'), `${p.name} deleted.`);
    }
  } catch (err) {
    flash($('#rooms-msg'), err.message, false);
  }
});

// ---------- Occupancy-based pricing ----------

let rules = [];

async function loadRules() {
  rules = await api('GET', '/api/yield-rules');
  const edit = can('setup');
  $('#yield-rules').innerHTML = rules.length === 0
    ? '<tr><td class="muted">No rules. Example: when Suites are 70% booked for a night, raise their price by 15%.</td></tr>'
    : `<thead><tr><th>Room type</th><th>When occupancy reaches</th><th>Change prices by</th><th></th><th></th></tr></thead><tbody>${
      rules.map((r) => `<tr><td>${esc(r.room_type_name || 'All room types')}</td><td>${pct(r.min_occupancy)}</td>
        <td><strong>${r.adjust_pct > 0 ? '+' : ''}${r.adjust_pct}%</strong></td>
        <td>${r.active ? '<span class="badge ok">On</span>' : '<span class="badge off">Off</span>'}</td>
        <td class="nowrap">${edit ? `<button data-toggle-rule="${r.id}">${r.active ? 'Switch off' : 'Switch on'}</button>
          <button data-delete-rule="${r.id}" class="danger">Delete</button>` : ''}</td></tr>`).join('')}</tbody>`;
}

$('#rule-add').addEventListener('click', async () => {
  await ensureRoomTypes();
  openDialog({
    title: 'Add occupancy pricing rule',
    body: `
      <label>Room type <select name="room_type_id">${options(state.roomTypes.map((r) => [r.id, r.name]), '', { empty: 'All room types' })}</select></label>
      <div class="row two">
        <label>When occupancy reaches (%) <input name="min_occupancy" type="number" min="0" max="100" step="1" required placeholder="e.g. 70"></label>
        <label>Change prices by (%) <input name="adjust_pct" type="number" min="-90" max="300" step="0.5" required placeholder="e.g. 15 or -10"></label>
      </div>
      <p class="muted small">Occupancy counts rooms booked for that night. A 0% threshold with a negative change works as a standing discount.</p>`,
    onSave: async (form) => {
      await api('POST', '/api/yield-rules', {
        room_type_id: numOrNull(form.room_type_id.value), min_occupancy: Number(form.min_occupancy.value), adjust_pct: Number(form.adjust_pct.value),
      });
      await loadRules();
      flash($('#rules-msg'), 'Rule added. Prices on matching nights are being updated on every channel.');
    },
  });
});

$('#yield-rules').addEventListener('click', async (e) => {
  const { toggleRule, deleteRule } = e.target.dataset;
  try {
    if (toggleRule) {
      const r = rules.find((x) => x.id === Number(toggleRule));
      await api('PATCH', `/api/yield-rules/${r.id}`, { active: !r.active });
    } else if (deleteRule) {
      if (!confirm('Delete this rule?')) return;
      await api('DELETE', `/api/yield-rules/${deleteRule}`);
    } else {
      return;
    }
    await loadRules();
  } catch (err) {
    flash($('#rules-msg'), err.message, false);
  }
});

// ---------- Properties (admins) ----------

function loadProperties() {
  $('#properties').innerHTML = `<thead><tr><th>Property</th><th>City</th><th>Currency</th><th></th></tr></thead><tbody>${
    state.properties.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.city || '')}</td><td>${esc(p.currency)}</td>
      <td>${p.id === state.property.id ? '<span class="muted small">Current</span>' : `<button data-switch="${p.id}">Open</button>`}</td></tr>`).join('')}</tbody>`;
}

$('#properties').addEventListener('click', (e) => { if (e.target.dataset.switch) switchProperty(Number(e.target.dataset.switch)); });

$('#property-add').addEventListener('click', () => openDialog({
  title: 'Add property',
  body: `
    <label>Hotel name <input name="name" required maxlength="120"></label>
    <div class="row two">
      <label>City <input name="city" maxlength="80"></label>
      <label>Country <input name="country" maxlength="80"></label>
      <label>Currency <select name="currency">${currencyOptions(state.property.currency)}</select></label>
    </div>
    <p class="muted small">It starts empty: add its room types, rate plans and channel connection after switching to it.</p>`,
  saveLabel: 'Add and open',
  onSave: async (form) => {
    const p = await api('POST', '/api/properties', formData(form));
    state.properties = await api('GET', '/api/properties');
    await switchProperty(p.id, '#/settings');
  },
}));

// ---------- Users & roles (admins) ----------

let users = [];

async function loadUsers() {
  if (!can('users')) return;
  users = await api('GET', '/api/users');
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || `#${id}`;
  $('#users').innerHTML = `<thead><tr><th>Name</th><th>Role</th><th>Properties</th><th>Two-factor</th><th></th></tr></thead><tbody>${
    users.map((u) => `<tr><td><strong>${esc(u.name)}</strong>${u.id === state.user.id ? ' <span class="muted small">(you)</span>' : ''}
      <div class="muted small">${esc(u.email)}</div></td>
      <td>${esc(ROLE_NAMES[u.role] || u.role)}</td>
      <td>${u.all_properties ? 'All' : esc(u.property_ids.map(propName).join(', '))}</td>
      <td>${u.totp_enabled ? '<span class="badge ok">✓ On</span>' : '<span class="muted small">Off</span>'}</td>
      <td class="nowrap"><button data-edit-user="${u.id}">Edit access</button>
        ${u.totp_enabled && u.id !== state.user.id ? `<button data-reset-2fa="${u.id}">Reset two-factor</button>` : ''}
        ${u.id === state.user.id ? '' : `<button data-remove-user="${u.id}" class="danger">Remove</button>`}</td></tr>`).join('')}</tbody>`;
}

function accessFields(u) {
  const ids = new Set(u?.property_ids || []);
  return `
    <label>Role <select name="role">${options(Object.entries(state.roles), u?.role || 'front_desk')}</select></label>
    <label class="check"><input type="checkbox" name="all_properties" ${!u || u.all_properties ? 'checked' : ''}> All properties, including ones added later</label>
    <fieldset class="prop-list"><legend>Or only these</legend>${state.properties.map((p) => `
      <label class="check"><input type="checkbox" name="prop" value="${p.id}" ${ids.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</fieldset>`;
}

function readAccess(form) {
  const all = form.all_properties.checked;
  return { role: form.role.value, all_properties: all, property_ids: all ? [] : $$('input[name=prop]:checked', form).map((i) => Number(i.value)) };
}

function wireAccess(form) {
  const sync = () => { $('.prop-list', form).disabled = form.all_properties.checked; };
  form.all_properties.onchange = sync;
  sync();
}

$('#user-add').addEventListener('click', () => openDialog({
  title: 'Add user',
  body: `
    <div class="row two">
      <label>Name <input name="name" required maxlength="80"></label>
      <label>Email <input name="email" type="email" required autocomplete="off"></label>
    </div>
    <label>Temporary password <input name="password" type="password" required minlength="8" autocomplete="new-password">
      <span class="muted small">Share it privately; they can change it under Settings → Your security.</span></label>
    ${accessFields(null)}`,
  onOpen: wireAccess,
  onSave: async (form) => {
    const u = await api('POST', '/api/users', { name: form.name.value, email: form.email.value, password: form.password.value, ...readAccess(form) });
    await loadUsers();
    flash($('#user-msg'), `${u.name} can now log in.`);
  },
}));

$('#users').addEventListener('click', async (e) => {
  const { editUser, reset2fa, removeUser } = e.target.dataset;
  try {
    if (editUser) {
      const u = users.find((x) => x.id === Number(editUser));
      openDialog({
        title: `Access for ${u.name}`,
        body: accessFields(u),
        onOpen: wireAccess,
        onSave: async (form) => {
          await api('PATCH', `/api/users/${u.id}`, readAccess(form));
          await loadUsers();
        },
      });
    } else if (reset2fa) {
      if (!confirm('Turn off two-factor login for this user? They will be logged out and can set it up again.')) return;
      await api('POST', `/api/users/${reset2fa}/reset-2fa`);
      await loadUsers();
    } else if (removeUser) {
      if (!confirm('Remove this user? They will be logged out.')) return;
      await api('DELETE', `/api/users/${removeUser}`);
      await loadUsers();
    }
  } catch (err) {
    flash($('#user-msg'), err.message, false);
  }
});

// ---------- Own security ----------

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/auth/password', formData(e.target));
    e.target.reset();
    flash($('#password-msg'), 'Password changed. Other devices have been logged out.');
  } catch (err) {
    flash($('#password-msg'), err.message, false);
  }
});

function renderTwoFactor() {
  const on = state.user.totp_enabled;
  $('#twofa').innerHTML = `
    <h3>Two-factor login</h3>
    <p class="muted small">Asks for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) after your password.</p>
    ${on ? '<p><span class="badge ok">✓ On</span></p><button id="twofa-off" class="danger">Turn off</button>'
      : '<p><span class="badge off">Off</span></p><button id="twofa-on" class="primary">Set up</button>'}
    <span id="twofa-msg" class="msg" role="status"></span>`;
}

$('#twofa').addEventListener('click', async (e) => {
  if (e.target.id === 'twofa-on') {
    try {
      const s = await api('POST', '/api/auth/2fa/setup');
      openDialog({
        title: 'Set up two-factor login',
        body: `
          <ol class="steps">
            <li>Open your authenticator app and add an account by scanning this code:</li>
          </ol>
          <img class="qr" src="${s.qr}" alt="QR code for your authenticator app" width="200" height="200">
          <p class="muted small">Can't scan? Enter this key: <code>${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
          <label>Then enter the 6-digit code it shows <input name="code" inputmode="numeric" maxlength="7" required autocomplete="one-time-code"></label>`,
        saveLabel: 'Turn on',
        onSave: async (form) => {
          state.user = await api('POST', '/api/auth/2fa/enable', { code: form.code.value });
          renderTwoFactor();
          flash($('#twofa-msg'), 'Two-factor login is on. Other devices have been logged out.');
        },
      });
    } catch (err) {
      flash($('#twofa-msg'), err.message, false);
    }
  }
  if (e.target.id === 'twofa-off') {
    openDialog({
      title: 'Turn off two-factor login',
      body: '<label>Your password <input name="password" type="password" required autocomplete="current-password"></label>',
      saveLabel: 'Turn off',
      onSave: async (form) => {
        state.user = await api('POST', '/api/auth/2fa/disable', { password: form.password.value });
        renderTwoFactor();
      },
    });
  }
});

Views.settings = {
  show: async () => {
    renderTwoFactor();
    loadProperties();
    await Promise.all([can('setup') ? loadHotelForm() : null, loadRoomTypes(), loadRules(), loadUsers()]);
  },
};
