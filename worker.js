// ─────────────────────────────────────────────────────────────────────────────
// Game Design Notebook — Cloudflare Worker → Google Drive
//
// The form (index.html) POSTs each scout's data to this Worker. The Worker
// authenticates to Google Drive as a service account and upserts the
// submission into a Drive folder you own. Scouts never log in.
//
// One-time setup (~10 minutes, all free tier):
//
// ── A. Google side: create a service account ─────────────────────────────────
//   1. https://console.cloud.google.com/ → create or pick a project.
//   2. APIs & Services → Library → enable "Google Drive API".
//   3. APIs & Services → Credentials → Create credentials → Service account.
//      Give it any name (e.g. "scout-notebook-writer"). Skip role assignment.
//   4. Open the new service account → Keys tab → Add key → JSON. A file
//      downloads. Open it; you'll need two fields below: `client_email` and
//      `private_key`.
//   5. Create a folder in YOUR Drive (e.g. "Scout Submissions"). Right-click →
//      Share → paste the service-account `client_email` → give it Editor.
//      Copy the folder ID from the URL (the part after /folders/).
//
// ── B. Cloudflare side: create the Worker ────────────────────────────────────
//   1. https://dash.cloudflare.com/ → Workers & Pages → Create → Worker.
//   2. After it deploys the hello-world, click Edit code, replace everything
//      with this file's contents, click Deploy.
//   3. Back at the Worker overview → Settings → Variables and Secrets:
//        Add these as type "Secret":
//          GOOGLE_CLIENT_EMAIL   = (the client_email from the JSON key)
//          GOOGLE_PRIVATE_KEY    = (the private_key from the JSON; paste the
//                                   whole thing including BEGIN/END lines and
//                                   the \n escapes — the worker handles both
//                                   real newlines and literal "\n" sequences)
//          DRIVE_FOLDER_ID       = (the folder ID from step A.5)
//          SHARED_SECRET         = (any random string you make up; will also
//                                   go into index.html so casual bots can't
//                                   spam your Worker)
//   4. Copy the Worker's URL (e.g. https://scout-notebook.YOURNAME.workers.dev)
//
// ── C. Form side: point at the Worker ────────────────────────────────────────
//   In index.html, set:
//      SAVE_URL       = "<your worker URL>"
//      SHARED_SECRET  = "<the same random string from B.3>"
//
// Done. Each scout's Next click + Export silently writes / overwrites
// `gamedesign_<scout>_<troop>.txt` (and `.json`) in your Drive folder.
// Share that folder (View) with counselors and they get every submission.
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return new Response("Game Design Notebook receiver is live.", { headers: cors });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

    let payload;
    try { payload = JSON.parse(await request.text()); }
    catch { return jsonResp({ ok: false, error: "bad json" }, 400, cors); }

    if (env.SHARED_SECRET && payload.secret !== env.SHARED_SECRET) {
      return jsonResp({ ok: false, error: "forbidden" }, 403, cors);
    }

    try {
      const token = await getAccessToken(env);
      const folderId = env.DRIVE_FOLDER_ID;
      const base = `gamedesign_${sanitize(payload.scoutName || "anonymous")}` +
                   (payload.troop ? "_" + sanitize(payload.troop) : "");

      await upsert(token, folderId, base + ".txt", payload.exportText || "", "text/plain");
      await upsert(token, folderId, base + ".json", JSON.stringify(payload, null, 2), "application/json");

      return jsonResp({ ok: true, file: base + ".txt" }, 200, cors);
    } catch (err) {
      return jsonResp({ ok: false, error: String(err && err.message || err) }, 500, cors);
    }
  },
};

function jsonResp(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function sanitize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "anonymous";
}

// ─── Google service-account auth ─────────────────────────────────────────────
// Builds a signed JWT and exchanges it for an OAuth access token. The token
// is good for 1 hour; we just fetch a fresh one each request — simpler than
// caching, and Worker cold starts are cheap.
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;

  const key = await importPrivateKey(env.GOOGLE_PRIVATE_KEY);
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64urlBytes(new Uint8Array(sigBuf))}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("token: " + JSON.stringify(data));
  return data.access_token;
}

async function importPrivateKey(pem) {
  const cleaned = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
}

function b64url(s) {
  return b64urlBytes(new TextEncoder().encode(s));
}
function b64urlBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ─── Drive upsert ────────────────────────────────────────────────────────────
async function findFile(token, folderId, name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  return (d.files && d.files[0]) || null;
}

async function upsert(token, folderId, name, content, mime) {
  const existing = await findFile(token, folderId, name);
  const boundary = "----notebook_boundary_" + Math.random().toString(36).slice(2);
  const metadata = existing ? { name } : { name, parents: [folderId] };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + "\r\n" +
    `--${boundary}\r\n` +
    `Content-Type: ${mime}\r\n\r\n` +
    content + "\r\n" +
    `--${boundary}--`;
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const r = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!r.ok) throw new Error(`drive ${r.status}: ${await r.text()}`);
  return r.json();
}
