// Factuur-PDF in de opmaak van Aannemersbedrijf 't Woud (A4, nagebouwd naar factuur 2026-0023).
import { PDFDocument, rgb, PDFFont, PDFPage } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
// Font (DejaVu Sans, lijkt op Lucida Grande van de originele factuur) en logo worden bij de eerste
// aanroep opgehaald en daarna in het geheugen bewaard.
const FONT_URL = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/";
const LOGO_URL = Deno.env.get("FACTUUR_LOGO_URL") ?? "https://maartenzomerdijk-alt.github.io/twoud-facturen/logo.jpg";
const cache = new Map<string, Uint8Array>();
async function haal(url: string): Promise<Uint8Array> {
  if (cache.has(url)) return cache.get(url)!;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kon ${url} niet ophalen (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  cache.set(url, bytes);
  return bytes;
}

export type Regel = {
  aantal?: number | null;
  omschrijving: string;
  bedrag?: number | null; // prijs per stuk excl. btw; leeg = toelichtingsregel
  btw?: number | null; // 21, 9 of 0
  toelichting?: string[];
};

export type Factuur = {
  nummer: string;
  factuurdatum: string; // yyyy-mm-dd
  vervaldatum: string; // yyyy-mm-dd
  klant: { naam: string; adres?: string; postcode_plaats?: string; extra?: string };
  betreft?: string;
  regels: Regel[];
};

export const BEDRIJF = {
  naam: "Aannemersbedrijf 't Woud",
  adres: "Herenweg 99",
  plaats: "1861PD Bergen (NH)",
  kvk: "37049602",
  btw: "NL001510458B16",
  bank: "NL45 RABO 0315 7290 07",
  slotzin: "Voor vragen kunt u contact opnemen per e-mail.",
};

export function euro(n: number): string {
  const neg = n < 0;
  const [heel, dec] = Math.abs(n).toFixed(2).split(".");
  const metPunten = heel.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}€ ${metPunten},${dec}`;
}

export function datumNL(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export function totalen(regels: Regel[]) {
  let subtotaal = 0;
  const perTarief = new Map<number, number>();
  for (const r of regels) {
    if (r.bedrag == null) continue;
    const t = round2((r.aantal ?? 1) * r.bedrag);
    subtotaal += t;
    const tarief = r.btw ?? 21;
    perTarief.set(tarief, (perTarief.get(tarief) ?? 0) + t);
  }
  const btwRegels = [...perTarief.entries()]
    .filter(([tarief]) => tarief > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([tarief, grondslag]) => ({ tarief, bedrag: round2((grondslag * tarief) / 100) }));
  const btw = round2(btwRegels.reduce((s, b) => s + b.bedrag, 0));
  subtotaal = round2(subtotaal);
  return { subtotaal, btwRegels, btw, totaal: round2(subtotaal + btw) };
}

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}


// Alleen tekens die het ingebedde font zeker kent; regeleindes, tabs en emoji eruit.
function veilig(s: string): string {
  return (s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\u0020-\u007E\u00A0-\u024F\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u20AC]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const woorden = veilig(text).split(/\s+/).filter(Boolean);
  const regels: string[] = [];
  let huidig = "";
  for (const w of woorden) {
    const test = huidig ? `${huidig} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) <= max || !huidig) huidig = test;
    else {
      regels.push(huidig);
      huidig = w;
    }
  }
  if (huidig) regels.push(huidig);
  return regels.length ? regels : [""];
}

export async function maakPdf(f: Factuur): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Factuur ${f.nummer}`);
  doc.setAuthor(BEDRIJF.naam);
  doc.registerFontkit(fontkit);
  const [fReg, fBold, logoBytes] = await Promise.all([
    haal(FONT_URL + "DejaVuSans.ttf"), haal(FONT_URL + "DejaVuSans-Bold.ttf"), haal(LOGO_URL),
  ]);
  const font = await doc.embedFont(fReg, { subset: true });
  const vet = await doc.embedFont(fBold, { subset: true });
  const logo = await doc.embedJpg(logoBytes);

  const W = 595.28, H = 842;
  const zwart = rgb(0, 0, 0);
  const L = 38, R = 557; // marges
  const KOL = { aantal: L, omschr: 73, bedragR: 426, totaalR: 515, btwR: R };
  const S = 8; // basis lettergrootte
  const LH = 13; // regelhoogte

  let page: PDFPage = doc.addPage([W, H]);
  const t = (p: PDFPage, s: string, x: number, yTop: number, opt: { f?: PDFFont; size?: number } = {}) =>
    p.drawText(veilig(s), { x, y: H - yTop, size: opt.size ?? S, font: opt.f ?? font, color: zwart });
  const tR = (p: PDFPage, s: string, xR: number, yTop: number, opt: { f?: PDFFont; size?: number } = {}) => {
    const ff = opt.f ?? font, sz = opt.size ?? S;
    p.drawText(veilig(s), { x: xR - ff.widthOfTextAtSize(veilig(s), sz), y: H - yTop, size: sz, font: ff, color: zwart });
  };
  const lijn = (p: PDFPage, x1: number, x2: number, yTop: number, dikte = 0.8) =>
    p.drawLine({ start: { x: x1, y: H - yTop }, end: { x: x2, y: H - yTop }, thickness: dikte, color: zwart });

  // Kop: logo links, bedrijfsgegevens rechts
  const logoB = 235, logoH = (logoB * logo.height) / logo.width;
  page.drawImage(logo, { x: 40, y: H - 40 - logoH, width: logoB, height: logoH });
  const xB = 410;
  t(page, BEDRIJF.naam, xB, 52, { f: vet });
  t(page, BEDRIJF.adres, xB, 65);
  t(page, BEDRIJF.plaats, xB, 78);
  t(page, `KVK: ${BEDRIJF.kvk}`, xB, 120);
  t(page, `Btw: ${BEDRIJF.btw}`, xB, 133);
  t(page, `Bank: ${BEDRIJF.bank}`, xB, 146);

  // Klant
  const klant = [f.klant.naam, f.klant.adres, f.klant.postcode_plaats, f.klant.extra].filter((x) => x && x.trim());
  klant.forEach((r, i) => t(page, r!, 76, 192 + i * LH));

  // Titel en data
  t(page, `Factuur ${f.nummer}`, L, 341, { size: 16 });
  t(page, "Factuurdatum:", xB, 331);
  tR(page, datumNL(f.factuurdatum), R, 331);
  t(page, "Vervaldatum:", xB, 344);
  tR(page, datumNL(f.vervaldatum), R, 344);

  // Tabelkop
  const kop = (p: PDFPage, y: number) => {
    t(p, "Omschrijving", KOL.omschr, y, { f: vet });
    tR(p, "Bedrag", KOL.bedragR, y, { f: vet });
    tR(p, "Totaal", KOL.totaalR, y, { f: vet });
    tR(p, "Btw", KOL.btwR, y, { f: vet });
    lijn(p, L, R, y + 6);
  };
  kop(page, 405);
  let y = 427;
  const maxOmschr = KOL.bedragR - 95 - KOL.omschr;
  const ONDERGRENS = 700;
  const nieuweRegel = () => {
    y += LH;
    if (y > ONDERGRENS) {
      page = doc.addPage([W, H]);
      t(page, `Factuur ${f.nummer} (vervolg)`, L, 60, { f: vet });
      kop(page, 90);
      y = 112;
    }
  };

  const items: { tekst: string; regel?: Regel }[] = [];
  if (f.betreft?.trim()) items.push({ tekst: `Betreft: ${f.betreft.trim()}` });
  for (const r of f.regels) {
    items.push({ tekst: r.omschrijving, regel: r });
    for (const tl of r.toelichting ?? []) if (tl.trim()) items.push({ tekst: tl.trim().startsWith("-") ? tl.trim() : `- ${tl.trim()}` });
  }
  for (const it of items) {
    const stukken = wrap(it.tekst, font, S, maxOmschr);
    const r = it.regel;
    if (r && r.bedrag != null) {
      t(page, `${r.aantal ?? 1} x`, KOL.aantal, y);
      tR(page, euro(r.bedrag), KOL.bedragR, y);
      tR(page, euro(round2((r.aantal ?? 1) * r.bedrag)), KOL.totaalR, y);
      tR(page, `${r.btw ?? 21}%`, KOL.btwR, y);
    }
    stukken.forEach((s, i) => {
      if (i > 0) nieuweRegel();
      t(page, s, KOL.omschr, y);
    });
    nieuweRegel();
  }

  // Totalen
  const tot = totalen(f.regels);
  if (y + 75 > 760) {
    page = doc.addPage([W, H]);
    y = 80;
  }
  y -= 4;
  lijn(page, L, R, y);
  y += 17;
  tR(page, "Subtotaal", KOL.bedragR, y, { f: vet });
  tR(page, euro(tot.subtotaal), KOL.totaalR, y);
  for (const b of tot.btwRegels) {
    y += LH;
    tR(page, `${b.tarief}% btw`, KOL.bedragR, y);
    tR(page, euro(b.bedrag), KOL.totaalR, y);
  }
  y += 8;
  lijn(page, 338, 523, y);
  y += 16;
  tR(page, "Totaal", KOL.bedragR, y, { f: vet });
  tR(page, euro(tot.totaal), KOL.totaalR, y, { f: vet });

  // Voettekst
  lijn(page, L, R, 773);
  const voet = `We verzoeken u vriendelijk het bovenstaande bedrag van ${euro(tot.totaal)} voor ${datumNL(f.vervaldatum)} te voldoen op onze bankrekening onder vermelding van de omschrijving ${f.nummer}. ${BEDRIJF.slotzin}`;
  wrap(voet, font, 8, R - L).forEach((s, i) => t(page, s, L, 789 + i * 12, { size: 8 }));

  return await doc.save();
}
