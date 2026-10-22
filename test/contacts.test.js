import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone, findPhones, findLabeledWhatsapp, parseWhatsappUrl, classifyUrl,
  extractContacts, stripSiteWide, mergeContacts, primaryWebsite, contactKinds, emptyContact, keepOwnBranch,
} from '../server/contacts.js';
import { robotsDisallows, pageContent } from '../server/sources/sites.js';
import { safeUrl, contactActions, websiteInfo, socialLinks, bookingInfo } from '../public/contacts.js';
import { clusterAction } from '../public/filter.js';

const nums = (list) => list.map((x) => x.e164).sort();

test('normalizes Israeli phone numbers in every common format', () => {
  assert.deepEqual(normalizePhone('052-123-4567'), { e164: '+972521234567', display: '052-1234567' });
  assert.equal(normalizePhone('+972 52 123 4567').e164, '+972521234567');
  assert.equal(normalizePhone('972521234567').e164, '+972521234567');
  assert.equal(normalizePhone('+972 (0)52-1234567').e164, '+972521234567');
  assert.deepEqual(normalizePhone('03-5551234'), { e164: '+97235551234', display: '03-5551234' });
  assert.equal(normalizePhone('077-1234567').e164, '+972771234567');
  assert.equal(normalizePhone('1234567'), null);
  assert.equal(normalizePhone('052-123'), null);
  assert.equal(normalizePhone('06-1234567'), null, 'no such Israeli prefix');
});

test('finds phones in text without matching hours, dates, prices or IDs', () => {
  const text = 'פתוח 06:00-22:00, עדכון 2026-10-22, מחיר ₪120, ע.מ 515123456, מס׳ 0391234567. התקשרו 03-5551234 או 050 765 4321';
  assert.deepEqual(nums(findPhones(text)), ['+97235551234', '+972507654321']);
});

test('WhatsApp only when the text labels the number as WhatsApp', () => {
  assert.deepEqual(nums(findLabeledWhatsapp('וואטסאפ: 052-1234567')), ['+972521234567']);
  assert.deepEqual(nums(findLabeledWhatsapp('ניתן לשלוח WhatsApp ל-052-1234567')), ['+972521234567']);
  assert.deepEqual(nums(findLabeledWhatsapp('052-1234567 (וואטסאפ)')), ['+972521234567']);
  assert.deepEqual(nums(findLabeledWhatsapp('טלפון 03-5551234 וואטסאפ 052-1234567')), ['+972521234567'], 'only the labelled one');
  assert.deepEqual(findLabeledWhatsapp('טלפון: 052-1234567'), [], 'a plain phone is not WhatsApp');
  assert.deepEqual(findLabeledWhatsapp('לא זמינים בוואטסאפ, טלפון 04-8123456'), [], 'negated label');
  assert.deepEqual(findLabeledWhatsapp('טלפון 03-5551234. וואטסאפ בקרוב'), [], 'label in another sentence');
  assert.deepEqual(findLabeledWhatsapp('03-5551234\nוואטסאפ: בקרוב'), [], 'label on another line');
});

test('parses WhatsApp links of every common form', () => {
  assert.equal(parseWhatsappUrl('https://wa.me/972521234567?text=hi').e164, '+972521234567');
  assert.equal(parseWhatsappUrl('https://api.whatsapp.com/send?phone=+972-52-123-4567').e164, '+972521234567');
  assert.equal(parseWhatsappUrl('whatsapp://send?phone=0521234567').e164, '+972521234567');
  assert.equal(parseWhatsappUrl('https://web.whatsapp.com/send?phone=972521234567').url, 'https://wa.me/972521234567');
  assert.ok(parseWhatsappUrl('https://chat.whatsapp.com/AbCdEf').group);
  assert.equal(parseWhatsappUrl('https://wa.me/'), null);
  assert.equal(parseWhatsappUrl('https://example.com/972521234567'), null);
});

test('classifies links: business site vs. social, booking, Freefit and noise', () => {
  assert.equal(classifyUrl('https://studio.co.il/'), 'website');
  assert.equal(classifyUrl('https://www.instagram.com/omada.life/'), 'instagram');
  assert.equal(classifyUrl('https://m.facebook.com/omada'), 'facebook');
  assert.equal(classifyUrl('https://app.arboxapp.com/x'), 'booking');
  assert.equal(classifyUrl('https://linktr.ee/studio'), 'links');
  assert.equal(classifyUrl('https://website.freefit.co.il/club/x/'), null);
  assert.equal(classifyUrl('https://ffapp.page.link/FreeFit'), null);
  assert.equal(classifyUrl('https://www.google.com/maps/place/x'), null);
  assert.equal(classifyUrl('https://waze.com/ul?ll=1,2'), null);
  assert.equal(classifyUrl('https://studio.co.il/logo.png'), null);
  assert.equal(classifyUrl('https://studio.co.il/about', { ownHosts: ['studio.co.il'] }), null);
  assert.equal(classifyUrl('javascript:alert(1)'), null);
});

test('extracts contacts from links and text, never promoting plain phones to WhatsApp', () => {
  const c = extractContacts({
    links: [
      { href: 'tel:03-5551234', text: '03-5551234' },
      { href: 'tel:052-9998877', text: 'WhatsApp' },
      { href: 'https://wa.me/972541112233', text: 'הודעה' },
      { href: 'mailto:Info@Studio.co.il?subject=hi', text: 'מייל' },
      { href: 'https://studio.co.il/', text: 'לאתר' },
      { href: 'https://website.freefit.co.il/locations/?route=max', text: 'MAX' },
    ],
    text: 'טלפון נוסף 050-7654321. קישור לדף האינסטגרם: https://www.instagram.com/studio.life/ צרו קשר logo@2x.png service@freefit.co.il',
    source: 'freefit',
    sourceUrl: 'https://website.freefit.co.il/club/x/',
    ownHosts: ['website.freefit.co.il'],
  });
  assert.deepEqual(nums(c.whatsapp), ['+972529998877', '+972541112233']);
  assert.equal(c.whatsapp.find((w) => w.e164 === '+972541112233').evidence, 'link');
  assert.equal(c.whatsapp.find((w) => w.e164 === '+972529998877').evidence, 'label');
  assert.ok(!c.whatsapp.some((w) => w.e164 === '+972507654321'), 'plain phone stays a phone');
  assert.ok(nums(c.phones).includes('+972507654321'));
  assert.deepEqual(c.emails.map((e) => e.email), ['info@studio.co.il']);
  assert.equal(c.social.instagram, 'https://www.instagram.com/studio.life');
  assert.deepEqual(c.websites.map((w) => w.url), ['https://studio.co.il/']);
  assert.deepEqual(contactKinds(c), ['whatsapp', 'phone', 'email', 'website', 'social']);
});

test('merging keeps the strongest WhatsApp evidence and the primary website order', () => {
  const a = { ...emptyContact(), whatsapp: [{ e164: '+972521234567', display: '052-1234567', evidence: 'label', source: 'freefit' }] };
  const b = { ...emptyContact(), whatsapp: [{ e164: '+972521234567', display: '052-1234567', evidence: 'link', source: 'site' }], websites: [{ url: 'https://x.co.il/', kind: 'booking' }, { url: 'https://y.co.il/', kind: 'website' }] };
  const m = mergeContacts(a, b);
  assert.equal(m.whatsapp.length, 1);
  assert.equal(m.whatsapp[0].evidence, 'link');
  assert.equal(primaryWebsite(m).url, 'https://y.co.il/');
});

test('drops contacts that repeat across many pages (the site\'s own chat/footer)', () => {
  const shared = { e164: '+972559458809', display: '055-9458809', evidence: 'link' };
  const records = Array.from({ length: 30 }, (_, i) => ({
    url: `u${i}`,
    contact: {
      ...emptyContact(),
      whatsapp: [shared, ...(i === 3 ? [{ e164: '+972521234567', display: '052-1234567', evidence: 'label' }] : [])],
      phones: [{ e164: `+9723555${String(i).padStart(4, '0')}`, display: 'x' }],
    },
  }));
  const { records: out, removed } = stripSiteWide(records);
  assert.deepEqual(removed, ['p:+972559458809']);
  assert.ok(out.every((r) => !r.contact.whatsapp.some((w) => w.e164 === '+972559458809')));
  assert.deepEqual(nums(out[3].contact.whatsapp), ['+972521234567']);
  assert.ok(out.every((r) => r.contact.phones.length === 1), 'unique phones kept');
});

test('robots.txt rules for the "*" group', () => {
  const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/contact/\n';
  assert.equal(robotsDisallows(robots, '/'), false);
  assert.equal(robotsDisallows(robots, '/private/x'), true);
  assert.equal(robotsDisallows(robots, '/private/contact/'), false);
  assert.equal(robotsDisallows('User-agent: *\nDisallow: /', '/anything'), true);
  assert.equal(robotsDisallows('User-agent: *\nDisallow:', '/anything'), false);
});

test('page text ignores scripts so code values are not read as contacts', () => {
  const { text, links } = pageContent('<body><p>טלפון 03-5551234</p><script>var p="050-0000000"</script><a href="/c">צור קשר</a></body>', 'https://s.co.il/');
  assert.deepEqual(nums(findPhones(text)), ['+97235551234']);
  assert.equal(links[0].href, 'https://s.co.il/c');
});

test('UI actions: WhatsApp first, only from published WhatsApp, unsafe links dropped', () => {
  const item = {
    name: 'סטודיו',
    city: 'חיפה',
    contact: {
      phones: [{ e164: '+972521234567', display: '052-1234567', source: 'freefit' }],
      whatsapp: [{ e164: '+972541112233', display: '054-1112233', evidence: 'link', source: 'site', sourceUrl: 'https://s.co.il/' }],
      emails: [{ email: 'a@s.co.il', source: 'site' }, { email: 'bad"@x', source: 'site' }],
      websites: [{ url: 'javascript:alert(1)', kind: 'website' }, { url: 'https://app.arboxapp.com/s', kind: 'booking' }, { url: 'https://s.co.il/', kind: 'website' }],
      social: { instagram: 'https://instagram.com/s', facebook: 'javascript:alert(1)' },
    },
  };
  const a = contactActions(item);
  assert.deepEqual(a.map((x) => x.kind), ['whatsapp', 'phone', 'email']);
  assert.equal(a[0].href, 'https://wa.me/972541112233');
  assert.equal(a.filter((x) => x.kind === 'whatsapp').length, 1, 'the phone did not become WhatsApp');
  assert.match(a[0].evidence, /קישור וואטסאפ/);
  assert.equal(websiteInfo(item).url, 'https://s.co.il/');
  assert.equal(bookingInfo(item).url, 'https://app.arboxapp.com/s');
  assert.deepEqual(socialLinks(item).map((s) => s.kind), ['instagram']);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(contactActions({}).length, 0);
});

test('cluster clicks list small or stacked clusters and zoom into spread ones', () => {
  assert.equal(clusterAction({ count: 4, zoom: 8, spanMeters: 50000 }), 'list');
  assert.equal(clusterAction({ count: 60, zoom: 9, spanMeters: 20 }), 'list', 'pins stacked on one spot');
  assert.equal(clusterAction({ count: 60, zoom: 16, spanMeters: 900 }), 'list', 'already zoomed in');
  assert.equal(clusterAction({ count: 60, zoom: 10, spanMeters: 9000 }), 'zoom');
});

// The real text of sportan.org.il/contact2 (as shown in search results), October 2026.
const SPORTAN = `צור קשר
יום שישי 08:00-13:00
ליצירת קשר: מועדוני ספורטן ניתן לחייג *6669
הודעות וואטצאפ
ספורטן פתח תקווה - לחץ כאן - 052-6996306
ספורטן הוד השרון - לחץ כאן - 052-6996307

דרושים/ות`;

test('real Sportan contact page: WhatsApp heading, star number, branches', () => {
  const c = extractContacts({ text: SPORTAN, source: 'site', sourceUrl: 'https://www.sportan.org.il/contact2' });
  assert.deepEqual(nums(c.whatsapp), ['+972526996306', '+972526996307'], 'numbers under the WhatsApp heading');
  assert.ok(c.whatsapp.every((w) => w.evidence === 'label'));
  assert.ok(c.phones.some((p) => p.e164 === '*6669'), 'star number to call');
  const pt = keepOwnBranch(c, 'פתח תקווה', ['פתח תקווה', 'הוד השרון', 'גני תקווה']);
  assert.deepEqual(nums(pt.whatsapp), ['+972526996306'], 'Petah Tikva keeps only its own branch number');
  assert.ok(pt.phones.some((p) => p.e164 === '*6669'), 'chain-wide number kept');
  const hod = keepOwnBranch(c, 'הוד השרון', ['פתח תקווה', 'הוד השרון']);
  assert.deepEqual(nums(hod.whatsapp), ['+972526996307']);
  assert.equal(contactActions({ contact: pt }).find((a) => a.value === '*6669').href, 'tel:*6669');
});

test('a WhatsApp heading does not swallow numbers after a blank line or in long text', () => {
  assert.deepEqual(findLabeledWhatsapp('וואטסאפ\n\nטלפון 03-5551234'), []);
  assert.deepEqual(findLabeledWhatsapp('הצטרפו לקבוצת הוואטסאפ שלנו כדי לקבל עדכונים על שיעורים ואירועים מיוחדים במהלך השנה\n050-1234567'), [], 'not a heading');
  assert.deepEqual(findPhones('מחיר *1234 מבצע').length, 0, 'star pattern without a call word');
});
