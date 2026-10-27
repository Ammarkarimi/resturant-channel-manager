const { HttpError } = require('./errors');

// What each role may do. "view" covers reading the calendar, bookings,
// channels and reports.
const ROLES = {
  admin: ['view', 'reports', 'bookings', 'rates', 'channels', 'setup', 'users'],
  manager: ['view', 'reports', 'bookings', 'rates', 'channels', 'setup'],
  front_desk: ['view', 'reports', 'bookings'],
  viewer: ['view', 'reports'],
};

const ROLE_LABELS = {
  admin: 'Admin: everything, including users and properties',
  manager: 'Revenue manager: rates, restrictions, rate plans, channels, bookings',
  front_desk: 'Front desk: bookings; can view rates and reports',
  viewer: 'Viewer: can look, but not change anything',
};

const can = (user, permission) => Boolean(user && ROLES[user.role]?.includes(permission));

/** Express middleware: only users whose role includes `permission`. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.user, permission)) return next(new HttpError(403, "Your role doesn't allow this"));
    return next();
  };
}

function accessibleProperties(db, user) {
  if (user.all_properties) {
    return db.prepare('SELECT id, name, currency, city, country FROM properties ORDER BY name, id').all();
  }
  return db.prepare(`
    SELECT p.id, p.name, p.currency, p.city, p.country FROM properties p
    JOIN user_properties up ON up.property_id = p.id AND up.user_id = ?
    ORDER BY p.name, p.id`).all(user.id);
}

/**
 * Express middleware: which property this request is about, from the
 * X-Property-Id header (or ?property=). Defaults to the user's first
 * property. Users can only reach properties they have been given.
 */
function withProperty(db) {
  return (req, res, next) => {
    const props = accessibleProperties(db, req.user);
    const wanted = req.get('x-property-id') || req.query.property;
    const property = wanted ? props.find((p) => p.id === Number(wanted)) : props[0];
    if (!property) {
      return next(new HttpError(wanted ? 404 : 403, wanted ? 'Property not found' : 'You have no properties yet'));
    }
    req.property = property;
    return next();
  };
}

module.exports = { ROLES, ROLE_LABELS, can, requirePermission, accessibleProperties, withProperty };
