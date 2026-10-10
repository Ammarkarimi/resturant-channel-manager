// Settings page: hotel details, room types, users, own password.

async function loadHotelForm() {
  const p = await api('GET', '/api/property');
  const f = $('#hotel-form');
  f.name.value = p.name;
  $('#hotel-currency').innerHTML = currencyOptions(p.currency);
}

$('#hotel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const changingCurrency = f.currency !== state.property.currency;
  if (changingCurrency && !confirm(`Change currency to ${f.currency}? Existing rates are not converted.`)) return;
  try {
    state.property = await api('PATCH', '/api/property', f);
    $('#property-name').textContent = state.property.name;
    document.title = `${state.property.name} · Channel Manager`;
    flash($('#hotel-msg'), 'Saved.');
  } catch (err) {
    flash($('#hotel-msg'), err.message, false);
  }
});

// ---------- Room types ----------

async function loadRoomTypes() {
  await ensureRoomTypes();
  $('#room-types').innerHTML = state.roomTypes.length === 0
    ? '<tr><td class="muted">No room types yet. Add the kinds of rooms you sell, e.g. "Deluxe Room, 10 rooms".</td></tr>'
    : `<thead><tr><th>Code</th><th>Name</th><th>Rooms</th><th>Base rate</th><th>Upcoming bookings</th><th></th></tr></thead><tbody>${
      state.roomTypes.map((rt) => `<tr>
        <td><code>${esc(rt.code)}</code></td><td>${esc(rt.name)}</td><td>${rt.total_rooms}</td><td>${money(rt.base_rate)}</td>
        <td>${rt.upcoming_bookings}</td>
        <td class="nowrap"><button data-edit="${rt.id}">Edit</button>
          <button data-delete="${rt.id}" class="danger">Delete</button></td>
      </tr>`).join('')}</tbody>`;
}

function openRoomDialog(rt) {
  const dlg = $('#room-dialog');
  const f = $('#room-form');
  $('#room-title').textContent = rt ? `Edit ${rt.name}` : 'Add room type';
  f.code.value = rt?.code || '';
  f.code.disabled = Boolean(rt);
  f.name.value = rt?.name || '';
  f.total_rooms.value = rt?.total_rooms ?? '';
  f.base_rate.value = rt?.base_rate ?? '';
  $('#room-msg').textContent = '';
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const body = { name: f.name.value.trim(), total_rooms: Number(f.total_rooms.value), base_rate: Number(f.base_rate.value) };
    try {
      if (rt) await api('PATCH', `/api/room-types/${rt.id}`, body);
      else await api('POST', '/api/room-types', { ...body, code: f.code.value.trim().toUpperCase() });
      dlg.close();
      await loadRoomTypes();
      flash($('#rooms-msg'), rt ? 'Saved. Channels will be updated.' : 'Room type added.');
    } catch (err) {
      flash($('#room-msg'), err.message, false);
    }
  };
  dlg.showModal();
}

$('#room-add').addEventListener('click', () => openRoomDialog(null));
$('#room-types').addEventListener('click', async (e) => {
  const { edit, delete: del } = e.target.dataset;
  if (edit) openRoomDialog(state.roomTypes.find((rt) => rt.id === Number(edit)));
  if (del) {
    const rt = state.roomTypes.find((r) => r.id === Number(del));
    if (!confirm(`Delete ${rt.name}? This can't be undone.`)) return;
    try {
      await api('DELETE', `/api/room-types/${rt.id}`);
      await loadRoomTypes();
      flash($('#rooms-msg'), `${rt.name} deleted.`);
    } catch (err) {
      flash($('#rooms-msg'), err.message, false);
    }
  }
});

// ---------- Users ----------

async function loadUsers() {
  const users = await api('GET', '/api/users');
  $('#users').innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Added</th><th></th></tr></thead><tbody>${
    users.map((u) => `<tr><td>${esc(u.name)}${u.id === state.user.id ? ' <span class="muted small">(you)</span>' : ''}</td>
      <td>${esc(u.email)}</td><td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td>${u.id === state.user.id ? '' : `<button data-remove="${u.id}" class="danger">Remove</button>`}</td></tr>`).join('')}</tbody>`;
}

$('#users').addEventListener('click', async (e) => {
  const id = e.target.dataset.remove;
  if (!id || !confirm('Remove this user? They will be logged out.')) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    await loadUsers();
  } catch (err) {
    flash($('#user-msg'), err.message, false);
  }
});

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const u = await api('POST', '/api/users', formData(e.target));
    e.target.reset();
    await loadUsers();
    flash($('#user-msg'), `${u.name} can now log in. Share the temporary password with them privately.`);
  } catch (err) {
    flash($('#user-msg'), err.message, false);
  }
});

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

Views.settings = {
  show: () => Promise.all([loadHotelForm(), loadRoomTypes(), loadUsers()]),
};
