// Factuurdienst 't Woud: foto van handgeschreven rekening -> gecontroleerde gegevens -> PDF per mail.
// Acties (POST JSON):
//   { actie: "lees", pin, foto: <base64>, type: "image/jpeg" }  -> gelezen gegevens + controles
//   { actie: "maak", pin, factuur: {...} }                       -> nummer, PDF en mail
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { maakPdf, totalen, euro, datumNL, round2, type Regel } from "./pdf.ts";

const MAIL_NAAR = Deno.env.get("FACTUUR_MAIL_NAAR") ?? "j.zomerdijk@hetnet.nl";
const MAIL_VAN = Deno.env.get("FACTUUR_MAIL_VAN") ?? "'t Woud facturen <facturen@maartenzomerdijk.com>";
const TERMIJN_DAGEN = 14;
const MODEL = Deno.env.get("FACTUUR_MODEL") ?? "claude-sonnet-5-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

function pinKlopt(pin: unknown): boolean {
  const echt = Deno.env.get("FACTUUR_PIN") ?? "";
  if (!echt || typeof pin !== "string" || pin.length !== echt.length) return false;
  let verschil = 0;
  for (let i = 0; i < echt.length; i++) verschil |= echt.charCodeAt(i) ^ pin.charCodeAt(i);
  return verschil === 0;
}

const LEES_TOOL = {
  name: "factuurgegevens",
  description: "De gegevens van de handgeschreven rekening.",
  input_schema: {
    type: "object",
    required: ["klant", "regels", "twijfels"],
    properties: {
      klant: {
        type: "object",
        required: ["naam"],
        properties: {
          naam: { type: "string" },
          adres: { type: "string", description: "Straat en huisnummer" },
          postcode_plaats: { type: "string", description: "Postcode zonder spatie, dan plaats, bijv. 1934PV Egmond aan den Hoef" },
          extra: { type: "string", description: "Eventuele extra adresregel, zoals t.a.v." },
        },
      },
      betreft: { type: "string", description: "Wat er na 'Betreft' staat, zonder het woord Betreft" },
      regels: {
        type: "array",
        description: "Eén regel per bedrag. Tekstregels zonder eigen bedrag die bij het bedrag erboven of eronder horen gaan in toelichting.",
        items: {
          type: "object",
          required: ["omschrijving", "bedrag"],
          properties: {
            aantal: { type: "number", description: "Alleen als er expliciet een aantal x prijs staat; anders 1" },
            omschrijving: { type: "string" },
            toelichting: { type: "array", items: { type: "string" } },
            bedrag: { type: "number", description: "Prijs per stuk exclusief btw, in euro" },
            btw: { type: "number", enum: [21, 9, 0] },
          },
        },
      },
      geschreven_subtotaal: { type: "number", description: "Totaal excl. btw zoals op het papier staat" },
      geschreven_btw: { type: "number" },
      geschreven_totaal: { type: "number", description: "Factuurbedrag incl. btw zoals op het papier staat" },
      twijfels: {
        type: "array",
        description: "Elk woord, getal of adresdeel dat je niet zeker kon lezen, kort in het Nederlands, bijv. 'Huisnummer: 301 of 3a?'",
        items: { type: "string" },
      },
    },
  },
};

const LEES_PROMPT = `Dit is een foto van een handgeschreven rekening van Aannemersbedrijf 't Woud (aannemer in Bergen NH). Lees de klant, wat er na "Betreft" staat, alle regels met bedragen en de totalen onderaan.

Regels:
- Het euroteken is vaak geschreven als een krul of £; dat is altijd euro.
- Bedragen zijn exclusief btw; neem 21% btw tenzij er iets anders staat.
- Een omschrijving die over meerdere regels loopt met één bedrag: de eerste regel wordt "omschrijving", de rest gaat in "toelichting".
- Verbeter duidelijke spelfouten in gewone woorden (bijv. "Electrick" -> "Elektra", "Fundering" goed spellen), maar laat namen van mensen, bedrijven en materialen staan zoals geschreven.
- Postcode zonder spatie: "1934PV".
- Neem elk woord of getal waar je niet zeker van bent op in "twijfels". Liever één twijfel te veel dan een verkeerd adres of bedrag.
Geef je antwoord altijd door de tool factuurgegevens aan te roepen, zonder verdere tekst.`;

async function leesFoto(foto: string, type: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY ontbreekt");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      tools: [LEES_TOOL],
      tool_choice: { type: "auto" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: type, data: foto } },
          { type: "text", text: LEES_PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Lezen mislukt (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const blok = data.content?.find((c: { type: string }) => c.type === "tool_use");
  if (blok) return blok.input;
  // Valt terug op JSON in de tekst als het model de tool niet gebruikte.
  const tekst = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  const m = tekst.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* hieronder foutmelding */ }
  }
  throw new Error("Geen gegevens teruggekregen");
}

function controleer(g: {
  regels: Regel[];
  geschreven_subtotaal?: number;
  geschreven_btw?: number;
  geschreven_totaal?: number;
}) {
  const t = totalen(g.regels);
  const meldingen: string[] = [];
  const vergelijk = (naam: string, geschreven: number | undefined, berekend: number) => {
    if (geschreven == null) return;
    if (Math.abs(round2(geschreven) - berekend) > 0.01) {
      meldingen.push(`${naam} op papier is ${euro(geschreven)}, maar opgeteld kom ik op ${euro(berekend)}.`);
    }
  };
  vergelijk("Totaal excl. btw", g.geschreven_subtotaal, t.subtotaal);
  vergelijk("Btw", g.geschreven_btw, t.btw);
  vergelijk("Factuurbedrag", g.geschreven_totaal, t.totaal);
  return { ...t, meldingen };
}

function vandaag(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
}
function plusDagen(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function schoonRegels(regels: unknown): Regel[] {
  if (!Array.isArray(regels)) throw new Error("Geen regels");
  return regels.map((r: Regel) => ({
    aantal: r.aantal && r.aantal > 0 ? Number(r.aantal) : 1,
    omschrijving: String(r.omschrijving ?? "").trim(),
    bedrag: r.bedrag == null || (r.bedrag as unknown) === "" ? null : Number(r.bedrag),
    btw: [21, 9, 0].includes(Number(r.btw)) ? Number(r.btw) : 21,
    toelichting: (r.toelichting ?? []).map((x) => String(x).trim()).filter(Boolean),
  })).filter((r) => r.omschrijving || r.bedrag != null);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ fout: "Alleen POST" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ fout: "Ongeldig verzoek" }, 400);
  }
  if (!pinKlopt(body.pin)) return json({ fout: "Pincode klopt niet" }, 401);

  try {
    if (body.actie === "controleer-pin") return json({ ok: true });

    if (body.actie === "lees") {
      const foto = String(body.foto ?? "");
      const type = ["image/jpeg", "image/png", "image/webp"].includes(String(body.type)) ? String(body.type) : "image/jpeg";
      if (foto.length < 1000) return json({ fout: "Geen foto ontvangen" }, 400);
      const g = await leesFoto(foto, type);
      g.regels = schoonRegels(g.regels);
      return json({ gegevens: g, controle: controleer(g) });
    }

    if (body.actie === "maak") {
      const f = body.factuur as Record<string, any>;
      if (!f?.klant?.naam) return json({ fout: "Klantnaam ontbreekt" }, 400);
      const regels = schoonRegels(f.regels);
      if (!regels.some((r) => r.bedrag != null)) return json({ fout: "Er staat geen enkel bedrag op de factuur" }, 400);

      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (!resendKey) throw new Error("Mailen is nog niet ingesteld (RESEND_API_KEY ontbreekt). Er is geen factuurnummer gebruikt.");

      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const factuurdatum = vandaag();
      const vervaldatum = plusDagen(factuurdatum, TERMIJN_DAGEN);
      const { data: nummer, error: nErr } = await sb.rpc("volgend_factuurnummer", { p_jaar: Number(factuurdatum.slice(0, 4)) });
      if (nErr) throw nErr;

      const klant = {
        naam: String(f.klant.naam).trim(),
        adres: String(f.klant.adres ?? "").trim(),
        postcode_plaats: String(f.klant.postcode_plaats ?? "").trim(),
        extra: String(f.klant.extra ?? "").trim(),
      };
      const factuur = { nummer, factuurdatum, vervaldatum, klant, betreft: String(f.betreft ?? "").trim(), regels };
      const pdf = await maakPdf(factuur);
      const t = totalen(regels);
      const bestandsnaam = `Factuur ${nummer} ${klant.naam}.pdf`.replace(/[\\/:*?"<>|]/g, "");
      const pad = `${factuurdatum.slice(0, 4)}/${nummer}.pdf`;

      await sb.storage.from("facturen").upload(pad, pdf, { contentType: "application/pdf", upsert: true });

      const mail = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: MAIL_VAN,
          to: [MAIL_NAAR],
          subject: `Factuur ${nummer} – ${klant.naam} – ${euro(t.totaal)}`,
          text:
            `Hierbij factuur ${nummer} voor ${klant.naam}.\n\n` +
            `Factuurbedrag: ${euro(t.totaal)} (incl. btw)\nFactuurdatum: ${datumNL(factuurdatum)}\nVervaldatum: ${datumNL(vervaldatum)}\n\n` +
            `De factuur zit als PDF in de bijlage. Open de bijlage en druk hem af.`,
          attachments: [{ filename: bestandsnaam, content: bytesToB64(pdf) }],
        }),
      });
      const mailOk = mail.ok;
      const mailFout = mailOk ? null : (await mail.text()).slice(0, 300);

      await sb.from("facturen").insert({
        nummer, factuurdatum, vervaldatum, klant, regels,
        subtotaal: t.subtotaal, btw: t.btw, totaal: t.totaal,
        gemaild_naar: mailOk ? MAIL_NAAR : null, pdf_pad: pad,
      });

      return json({
        nummer, totaal: t.totaal, gemaild_naar: mailOk ? MAIL_NAAR : null, mail_fout: mailFout,
        bestandsnaam, pdf: bytesToB64(pdf),
      });
    }

    return json({ fout: "Onbekende actie" }, 400);
  } catch (e) {
    console.error(e);
    return json({ fout: e instanceof Error ? e.message : String(e) }, 500);
  }
});
