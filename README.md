# Facturen 't Woud

Foto van een handgeschreven rekening → controlescherm → PDF in de 't Woud-opmaak, gemaild naar j.zomerdijk@hetnet.nl.

- `docs/` — de pagina (GitHub Pages): pincode, fotoknop, vaste velden, live totaal.
- `supabase/functions/factuur/` — edge function in Supabase-project `twoud-facturen`: leest de foto met Claude, rekent na, maakt de PDF, mailt via Resend en bewaart elke factuur (tabel `facturen`, opslag `facturen/`).

Secrets in Supabase (Edge Functions → Secrets): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `FACTUUR_PIN`.
Optioneel: `FACTUUR_MAIL_NAAR`, `FACTUUR_MAIL_VAN`, `FACTUUR_LOGO_URL`.
Factuurnummers lopen door via de functie `volgend_factuurnummer` (tabel `factuurnummers`).
