/* Salon site + admin panel. Run: ADMIN_PASSWORD=yourpassword node server.js */
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm');
const PORT = process.env.PORT || 3000, ADMIN_PATH = process.env.ADMIN_PATH || '/admin', PASS = process.env.ADMIN_PASSWORD;
if (!PASS || PASS.length < 8) { console.error('Set ADMIN_PASSWORD (at least 8 characters). Example: ADMIN_PASSWORD=mySecret123 node server.js'); process.exit(1); }

const DATA = path.join(__dirname, 'data'), UP = path.join(DATA, 'uploads'), DBF = path.join(DATA, 'db.json');
fs.mkdirSync(UP, { recursive: true });
const uid = () => crypto.randomBytes(6).toString('hex');

function seed() {
  let cats = [], gallery = [];
  try { // take the default prices and gallery labels from public/index.html
    const h = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    cats = vm.runInNewContext('(' + h.match(/var CATS = (\[[\s\S]*?\n\]);/)[1] + ')');
    gallery = vm.runInNewContext('(' + h.match(/var GALLERY = (\[\[[\s\S]*?\]\]);/)[1] + ')').map(g => ({ id: uid(), label: g[0], image: '' }));
  } catch (e) { console.warn('Could not read defaults:', e.message); }
  return {
    config: { name: '', phone: '', address: '', hoursWeek: '10:00–20:00', hoursSat: '10:00–19:00', hoursSun: '12:00–18:00', instagram: '', heroImage: '' },
    cats, gallery,
    reviews: [
      { id: uid(), name: 'ნინო, თმის შეღებვა', text: 'საუკეთესო ბალაიაჟი, რაც კი მქონია. ზუსტად ის ტონი, რაც მინდოდა.', stars: 5, visible: true },
      { id: uid(), name: 'ანა, მანიკური', text: 'სუფთა, მშვიდი გარემო და ყოველთვის დროზე. გელ-ლაქი სამი კვირა გამიძლო.', stars: 5, visible: true },
      { id: uid(), name: 'მარიამი, საქორწილო მაკიაჟი', text: 'საქორწილო მაკიაჟი ისე გამიკეთეს, რომ ისევ მე ვიყავი, უბრალოდ უფრო ბრწყინვალე.', stars: 5, visible: true }
    ],
    clients: [], bookings: []
  };
}
let db = fs.existsSync(DBF) ? JSON.parse(fs.readFileSync(DBF, 'utf8')) : seed();
const save = () => { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db, null, 1)); fs.renameSync(DBF + '.tmp', DBF); };
if (!fs.existsSync(DBF)) save();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '9mb' }));
app.use((q, r, n) => { r.set('X-Content-Type-Options', 'nosniff'); n(); });

/* ---- auth ---- */
const sessions = new Map(), tries = {};
const cookie = (req, n) => ((req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(n + '=')) || '').slice(n.length + 1);
const auth = (req, res, next) => { const s = sessions.get(cookie(req, 'sid')); if (s && s > Date.now()) return next(); res.status(401).json({ error: 'auth' }); };

app.post('/api/admin/login', (req, res) => {
  const t = tries[req.ip] = (tries[req.ip] || []).filter(x => x > Date.now() - 9e5);
  if (t.length >= 8) return res.status(429).json({ error: 'too many attempts' });
  const a = Buffer.from(String((req.body || {}).password || '')), b = Buffer.from(PASS);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) { t.push(Date.now()); return res.status(401).json({ error: 'bad password' }); }
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, Date.now() + 7 * 864e5);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
  res.json({ ok: 1 });
});
app.post('/api/admin/logout', (req, res) => { sessions.delete(cookie(req, 'sid')); res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: 1 }); });

/* ---- public API ---- */
app.get('/api/site', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ config: db.config, cats: db.cats, gallery: db.gallery, reviews: db.reviews.filter(r => r.visible !== false) });
});
const hits = {};
app.post('/api/bookings', (req, res) => {
  const t = hits[req.ip] = (hits[req.ip] || []).filter(x => x > Date.now() - 36e5);
  if (t.length >= 10) return res.status(429).end();
  t.push(Date.now());
  const b = req.body || {}, s = x => String(x || '').slice(0, 200);
  if (!s(b.name).trim()) return res.status(400).end();
  db.bookings.unshift({ id: uid(), name: s(b.name), services: Array.isArray(b.services) ? b.services.slice(0, 10).map(x => s(x)) : [], day: s(b.day), time: s(b.time), status: 'new', created: new Date().toISOString() });
  db.bookings = db.bookings.slice(0, 2000);
  save(); res.json({ ok: 1 });
});

/* ---- admin API ---- */
const KEYS = ['config', 'cats', 'gallery', 'reviews', 'clients', 'bookings'];
app.get('/api/admin/data', auth, (req, res) => res.json(db));
app.put('/api/admin/:key', auth, (req, res) => {
  const k = req.params.key, v = (req.body || {}).value;
  if (!KEYS.includes(k)) return res.status(404).end();
  if (!v || typeof v !== 'object' || (k === 'config') === Array.isArray(v)) return res.status(400).json({ error: 'bad data' });
  db[k] = v; save(); res.json({ ok: 1 });
});
app.post('/api/admin/upload', auth, (req, res) => {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: 'bad image' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6e6) return res.status(413).json({ error: 'too large' });
  const f = uid() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, f), buf);
  res.json({ url: '/uploads/' + f });
});

/* ---- pages ---- */
app.use('/uploads', express.static(UP, { maxAge: '30d', immutable: true }));
app.get(ADMIN_PATH, (req, res) => { res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }); res.sendFile(path.join(__dirname, 'views/admin.html')); });
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Site: http://localhost:${PORT}   Admin: http://localhost:${PORT}${ADMIN_PATH}`));
